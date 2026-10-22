import { isRepoPath, isSha, isUnitId } from "./diff.ts";
import {
  diagramProblem,
  isArray,
  isCommentId,
  isConcernId,
  isFields,
  isOfferId,
  isPlanVersion,
  isSeverity,
  parsePlacedConcern,
} from "./plan.ts";
import type {
  Anchor,
  CarriedComment,
  CarriedConcern,
  CarriedRef,
  Comment,
  CommentId,
  ConcernDecision,
  ConcernId,
  EarlierReplies,
  Excluded,
  Placement,
  PlanVersion,
  Reply,
  ReplyAuthor,
  ReplyId,
  Review,
  ReviewDraft,
  ServerEvent,
} from "./types.ts";

/**
 * The wire formats of review state, parsed once at the boundary: comments, replies, concern
 * decisions, the review file, its autosaved draft and the events a hosted session logs. Every
 * parser returns the domain value or the reason it is not one, so a caller decides whether a bad
 * item rejects a request or is skipped when reading a file.
 */

const REPLY_ID = /^r_[a-z2-7]{6}$/;

export function isReplyId(value: unknown): value is ReplyId {
  return typeof value === "string" && REPLY_ID.test(value);
}

function isIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseAnchor(v: unknown): Anchor | string {
  if (!isFields<"kind" | "unit" | "commit" | "changes" | "offsets">(v)) {
    return "anchor is not an object";
  }
  if (v.kind === "plan") return { kind: "plan" };
  if (!isIndex(v.commit)) return "anchor.commit is not a commit index";
  const commit = v.commit;
  if (v.kind === "message" || v.kind === "position") return { kind: v.kind, commit };
  if (v.kind !== "hunk") return "anchor.kind is unknown";
  if (typeof v.unit !== "string" || !isUnitId(v.unit)) return "anchor.unit is not a unit id";
  if (v.changes === null) {
    if (v.offsets !== undefined) return "anchor.offsets needs anchor.changes to be a list";
    return { kind: "hunk", unit: v.unit, commit, changes: null };
  }
  if (!isArray(v.changes) || !v.changes.every(isIndex)) {
    return "anchor.changes is not null or a list of change indices";
  }
  const changes = v.changes.filter(isIndex);
  if (v.offsets === undefined) return { kind: "hunk", unit: v.unit, commit, changes };
  if (!isArray(v.offsets) || v.offsets.length === 0 || !v.offsets.every(isIndex)) {
    return "anchor.offsets is not a non-empty list of row indices";
  }
  const offsets = v.offsets.filter(isIndex);
  if (!offsets.every((o, i) => i === 0 || o > (offsets[i - 1] ?? 0))) {
    return "anchor.offsets is not strictly ascending";
  }
  return { kind: "hunk", unit: v.unit, commit, changes, offsets };
}

/** A stored reply. Replies a client posts go through parseNewReply, which mints id and time. */
export function parseReply(v: unknown): Reply | string {
  if (!isFields<"id" | "author" | "body" | "diagram" | "createdAt">(v)) return "not an object";
  if (!isReplyId(v.id)) return "id is not a reply id";
  if (v.author !== "agent" && v.author !== "reviewer") return 'author is not "agent" or "reviewer"';
  if (typeof v.body !== "string" || typeof v.createdAt !== "string") {
    return "body and createdAt must be strings";
  }
  if (v.diagram !== undefined && typeof v.diagram !== "string") return "diagram is not a string";
  return {
    id: v.id,
    author: v.author,
    body: v.body,
    ...(v.diagram === undefined ? {} : { diagram: v.diagram }),
    createdAt: v.createdAt,
  };
}

export type NewReply = {
  readonly author: ReplyAuthor;
  readonly body: string;
  readonly diagram?: string;
};

/**
 * The body of POST .../replies: who speaks, what, and an optional Mermaid diagram. The body may be
 * empty only when the diagram is the answer.
 */
export function parseNewReply(v: unknown): NewReply | string {
  if (!isFields<"author" | "body" | "diagram">(v)) return "the reply is not an object";
  if (v.author !== "agent" && v.author !== "reviewer") return 'author is not "agent" or "reviewer"';
  if (typeof v.body !== "string") return "body is not a string";
  if (v.diagram === undefined) {
    if (v.body.trim() === "") return "body is empty; a reply needs words or a diagram";
    return { author: v.author, body: v.body };
  }
  if (typeof v.diagram !== "string") return "diagram is not a string";
  const problem = diagramProblem(v.diagram);
  if (problem !== null) return `diagram: ${problem}`;
  return { author: v.author, body: v.body, diagram: v.diagram };
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

type CommentFields =
  | "id"
  | "anchor"
  | "context"
  | "body"
  | "createdAt"
  | "kind"
  | "follows"
  | "severity"
  | "replies"
  | "author"
  | "diagram"
  | "offer";

/** Boundary parse of a comment, from a file or a request. Returns the reason when it is not one. */
export function parseComment(v: unknown): Comment | string {
  if (!isFields<CommentFields>(v)) return "not an object";
  if (typeof v.id !== "string" || !isCommentId(v.id)) return "id is not a comment id";
  const anchor = parseAnchor(v.anchor);
  if (typeof anchor === "string") return anchor;
  const ctx = v.context;
  if (!isFields<"commitMessage" | "path" | "lines">(ctx) || typeof ctx.commitMessage !== "string") {
    return "context.commitMessage is not a string";
  }
  const path = ctx.path;
  if (path !== null && (typeof path !== "string" || !isRepoPath(path))) {
    return "context.path is not null or a path";
  }
  const lines = ctx.lines;
  if (lines !== undefined && !(isArray(lines) && lines.every(isString))) {
    return "context.lines is not a list of strings";
  }
  if (typeof v.body !== "string" || typeof v.createdAt !== "string") {
    return "body and createdAt must be strings";
  }
  if (v.kind !== undefined && v.kind !== "question") return 'kind is not "question"';
  if (v.author !== undefined && v.author !== "agent") return 'author is not "agent"';
  if (v.diagram !== undefined) {
    if (typeof v.diagram !== "string") return "diagram is not a string";
    if (v.author !== "agent") return "diagram is only for an agent's comment";
    const problem = diagramProblem(v.diagram);
    if (problem !== null) return `diagram: ${problem}`;
  }
  const follows = v.follows;
  if (follows !== undefined && !(typeof follows === "string" && isCommentId(follows))) {
    return "follows is not a comment id";
  }
  const severity = v.severity;
  if (severity !== undefined && !isSeverity(severity)) return "severity is unknown";
  const offer = v.offer;
  if (offer !== undefined) {
    if (!isOfferId(offer)) return "offer is not an offer id";
    if (v.kind !== "question" || v.author !== undefined) {
      return "offer is only for a reviewer's question";
    }
  }
  const replies = parseList(v.replies, parseReply, "replies");
  if (typeof replies === "string") return replies;
  return {
    id: v.id,
    anchor,
    context: {
      commitMessage: ctx.commitMessage,
      path,
      ...(lines === undefined ? {} : { lines: lines.filter(isString) }),
    },
    body: v.body,
    createdAt: v.createdAt,
    ...(v.kind === "question" ? { kind: "question" } : {}),
    ...(follows === undefined ? {} : { follows }),
    ...(severity === undefined ? {} : { severity }),
    ...(replies.length === 0 ? {} : { replies }),
    ...(v.author === "agent" ? { author: "agent" } : {}),
    ...(v.diagram === undefined ? {} : { diagram: v.diagram }),
    ...(offer === undefined ? {} : { offer }),
  };
}

type DecisionFields = "concern" | "decision" | "severity" | "note" | "decidedAt";

function withDecision(
  concern: ConcernId,
  v: { readonly [K in DecisionFields]?: unknown },
): ConcernDecision | string {
  if (v.decision !== "kept" && v.decision !== "dismissed") {
    return 'decision is not "kept" or "dismissed"';
  }
  if (v.severity !== undefined && !isSeverity(v.severity)) return "severity is unknown";
  if (v.note !== undefined && typeof v.note !== "string") return "note is not a string";
  if (v.decidedAt !== undefined && typeof v.decidedAt !== "string") {
    return "decidedAt is not a string";
  }
  return {
    concern,
    decision: v.decision,
    ...(v.severity === undefined ? {} : { severity: v.severity }),
    ...(v.note === undefined || v.note.trim() === "" ? {} : { note: v.note }),
    ...(v.decidedAt === undefined ? {} : { decidedAt: v.decidedAt }),
  };
}

/** A stored decision. */
export function parseDecision(v: unknown): ConcernDecision | string {
  if (!isFields<DecisionFields>(v)) return "not an object";
  if (!isConcernId(v.concern)) return "concern is not a concern id";
  return withDecision(v.concern, v);
}

/** The body of POST .../concerns/<id>; the id comes from the URL and the time is the server's. */
export function parseNewDecision(concern: ConcernId, v: unknown): ConcernDecision | string {
  if (!isFields<DecisionFields>(v)) return "the decision is not an object";
  return withDecision(concern, { ...v, decidedAt: undefined });
}

/**
 * Absent reads as none. The first item that does not parse names its index and reason. Items
 * are objects so a string result can only mean a failure; string values go through parseIds.
 */
function parseList<T extends object>(
  raw: unknown,
  parse: (item: unknown) => T | string,
  what: string,
): T[] | string {
  if (raw === undefined) return [];
  if (!isArray(raw)) return `${what} is not an array`;
  const out: T[] = [];
  for (const [i, item] of raw.entries()) {
    const parsed = parse(item);
    if (typeof parsed === "string") return `${what}[${i}]: ${parsed}`;
    out.push(parsed);
  }
  return out;
}

/** Absent reads as none. The first item that is not an id of the kind names its index. */
function parseIds<T extends string>(
  raw: unknown,
  is: (item: unknown) => item is T,
  what: string,
  kind: string,
): T[] | string {
  if (raw === undefined) return [];
  if (!isArray(raw)) return `${what} is not an array`;
  const out: T[] = [];
  for (const [i, item] of raw.entries()) {
    if (!is(item)) return `${what}[${i}]: not a ${kind} id`;
    out.push(item);
  }
  return out;
}

/** Keeps only the items that are ids of the kind. */
function lenientIds<T extends string>(raw: unknown, is: (item: unknown) => item is T): T[] {
  return isArray(raw) ? raw.filter(is) : [];
}

function isCommentIdValue(item: unknown): item is CommentId {
  return typeof item === "string" && isCommentId(item);
}

/** Absent reads as nothing excluded. */
export function parseExcluded(v: unknown): Excluded | string {
  if (v === undefined) return { comments: [], concerns: [] };
  if (!isFields<"comments" | "concerns">(v)) return "excluded is not an object";
  const comments = parseIds(v.comments, isCommentIdValue, "excluded.comments", "comment");
  if (typeof comments === "string") return comments;
  const concerns = parseIds(v.concerns, isConcernId, "excluded.concerns", "concern");
  return typeof concerns === "string" ? concerns : { comments, concerns };
}

function asCommentId(item: unknown): CommentId | null {
  return isCommentIdValue(item) ? item : null;
}

function parseEarlierReplies(v: unknown): EarlierReplies | string {
  if (!isFields<"comment" | "replies">(v)) return "not an object";
  const comment = asCommentId(v.comment);
  if (comment === null) return "comment is not a comment id";
  const replies = parseList(v.replies, parseReply, "replies");
  return typeof replies === "string" ? replies : { comment, replies };
}

function isLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

type PlacementFields = "unit" | "offsets" | "changed" | "path" | "newLine";

function parsePlacement(v: { readonly [K in PlacementFields]?: unknown }): Placement | string {
  const { unit, offsets, changed, path, newLine } = v;
  if (unit !== null && !(typeof unit === "string" && isUnitId(unit)))
    return "unit is not a unit id";
  if (offsets !== null && !(isArray(offsets) && offsets.every(isIndex))) {
    return "offsets is not null or a list of rows";
  }
  if (typeof changed !== "boolean") return "changed is not a boolean";
  if (path !== null && !(typeof path === "string" && isRepoPath(path))) return "path is not a path";
  if (newLine !== null && !isLine(newLine)) return "newLine is not null or a line";
  return {
    unit,
    offsets: offsets === null ? null : offsets.filter(isIndex),
    changed,
    path,
    newLine,
  };
}

export function parseCarried(v: unknown): CarriedComment | string {
  if (!isFields<"comment" | PlacementFields>(v)) return "not an object";
  const comment = parseComment(v.comment);
  if (typeof comment === "string") return comment;
  const placement = parsePlacement(v);
  return typeof placement === "string" ? placement : { comment, ...placement };
}

function parseSince(v: unknown): PlanVersion | null | string {
  if (v === null) return null;
  return isPlanVersion(v) ? v : "since is not null or a plan version";
}

function parseCarriedRef(v: unknown): CarriedRef | string {
  if (!isFields<"comment" | "version" | "since" | PlacementFields>(v)) return "not an object";
  const comment = asCommentId(v.comment);
  if (comment === null) return "comment is not a comment id";
  if (!isPlanVersion(v.version)) return "version is not a plan version";
  const since = parseSince(v.since);
  if (typeof since === "string") return since;
  const placement = parsePlacement(v);
  if (typeof placement === "string") return placement;
  return { ...placement, comment, version: v.version, since };
}

function parseCarriedConcern(v: unknown): CarriedConcern | string {
  if (!isFields<"concern" | "commit" | "decision" | "since" | PlacementFields>(v)) {
    return "not an object";
  }
  const concern = parsePlacedConcern(v.concern);
  if (typeof concern === "string") return `concern: ${concern}`;
  if (!isIndex(v.commit)) return "commit is not a commit index";
  const decision = parseDecision(v.decision);
  if (typeof decision === "string") return `decision: ${decision}`;
  const since = parseSince(v.since);
  if (typeof since === "string") return since;
  const placement = parsePlacement(v);
  if (typeof placement === "string") return placement;
  return { ...placement, concern, commit: v.commit, decision, since };
}

/** Boundary parse of reviews/vN.json. Files written before walk mode existed have no mode. */
export function parseReview(v: unknown): Review | string {
  if (
    !isFields<
      | "schema"
      | "mode"
      | "planVersion"
      | "planHash"
      | "endedAt"
      | "comments"
      | "concerns"
      | "resolved"
      | "excluded"
      | "earlierReplies"
      | "carried"
      | "carriedConcerns"
      | "dismissedOffers"
    >(v)
  ) {
    return "not an object";
  }
  if (v.schema !== "follow-me/review@1") return 'schema is not "follow-me/review@1"';
  const mode = v.mode ?? "split";
  if (mode !== "split" && mode !== "walk") return 'mode is not "split" or "walk"';
  if (!isPlanVersion(v.planVersion)) return "planVersion is not a positive integer";
  if (typeof v.planHash !== "string" || typeof v.endedAt !== "string") {
    return "planHash and endedAt must be strings";
  }
  if (!isArray(v.comments)) return "comments is not an array";
  const comments = parseList(v.comments, parseComment, "comments");
  if (typeof comments === "string") return comments;
  const concerns = parseList(v.concerns, parseDecision, "concerns");
  if (typeof concerns === "string") return concerns;
  const resolved = parseIds(v.resolved, isCommentIdValue, "resolved", "comment");
  if (typeof resolved === "string") return resolved;
  const excluded = parseExcluded(v.excluded);
  if (typeof excluded === "string") return excluded;
  const anyExcluded = excluded.comments.length + excluded.concerns.length > 0;
  const earlier = parseList(v.earlierReplies, parseEarlierReplies, "earlierReplies");
  if (typeof earlier === "string") return earlier;
  const carried = v.carried === undefined ? null : parseList(v.carried, parseCarriedRef, "carried");
  if (typeof carried === "string") return carried;
  const concernsCarried = parseList(v.carriedConcerns, parseCarriedConcern, "carriedConcerns");
  if (typeof concernsCarried === "string") return concernsCarried;
  const dismissed = parseIds(v.dismissedOffers, isOfferId, "dismissedOffers", "offer");
  if (typeof dismissed === "string") return dismissed;
  return {
    schema: v.schema,
    mode,
    planVersion: v.planVersion,
    planHash: v.planHash,
    endedAt: v.endedAt,
    comments,
    ...(concerns.length === 0 ? {} : { concerns }),
    ...(resolved.length === 0 ? {} : { resolved }),
    ...(anyExcluded ? { excluded } : {}),
    ...(earlier.length === 0 ? {} : { earlierReplies: earlier }),
    ...(carried === null ? {} : { carried }),
    ...(concernsCarried.length === 0 ? {} : { carriedConcerns: concernsCarried }),
    ...(dismissed.length === 0 ? {} : { dismissedOffers: dismissed }),
  };
}

function lenient<T extends object>(items: unknown, parse: (item: unknown) => T | string): T[] {
  if (!isArray(items)) return [];
  return items.flatMap((item) => {
    const parsed = parse(item);
    return typeof parsed === "string" ? [] : [parsed];
  });
}

/**
 * Boundary parse of reviews/vN.draft.json. Unlike a finished review it is read leniently: an
 * item that does not parse is dropped, so one bad entry never loses the rest of an autosave.
 */
export function parseDraft(v: unknown): ReviewDraft | string {
  type Fields =
    | "comments"
    | "concerns"
    | "resolved"
    | "excluded"
    | "earlierReplies"
    | "carried"
    | "carriedConcerns"
    | "dismissedOffers";
  if (!isFields<Fields>(v) || !isArray(v.comments)) {
    return "not a review draft";
  }
  const excluded = parseExcluded(v.excluded);
  return {
    comments: lenient(v.comments, parseComment),
    concerns: lenient(v.concerns, parseDecision),
    resolved: lenientIds(v.resolved, isCommentIdValue),
    excluded: typeof excluded === "string" ? { comments: [], concerns: [] } : excluded,
    earlierReplies: lenient(v.earlierReplies, parseEarlierReplies),
    carried: v.carried === undefined ? null : lenient(v.carried, parseCarriedRef),
    carriedConcerns: lenient(v.carriedConcerns, parseCarriedConcern),
    dismissedOffers: lenientIds(v.dismissedOffers, isOfferId),
  };
}

type EventFields =
  | "seq"
  | "type"
  | "comment"
  | "id"
  | "commentId"
  | "reply"
  | "concernId"
  | "decision"
  | "severity"
  | "note"
  | "decidedAt"
  | "resolved"
  | "version"
  | "hash"
  | "carried"
  | "tip"
  | "takenAt"
  | "offer"
  | "review";

export function parseEvent(v: unknown): ServerEvent | string {
  if (!isFields<EventFields>(v)) return "not an object";
  const { seq } = v;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return "seq is not a number";
  switch (v.type) {
    case "comment":
    case "comment-updated": {
      const comment = parseComment(v.comment);
      return typeof comment === "string" ? comment : { seq, type: v.type, comment };
    }
    case "comment-deleted": {
      const id = asCommentId(v.id);
      return id === null ? "id is not a comment id" : { seq, type: v.type, id };
    }
    case "reply": {
      const id = asCommentId(v.commentId);
      const reply = parseReply(v.reply);
      if (id === null) return "commentId is not a comment id";
      return typeof reply === "string" ? reply : { seq, type: v.type, commentId: id, reply };
    }
    case "concern": {
      if (!isConcernId(v.concernId)) return "concernId is not a concern id";
      const decision = withDecision(v.concernId, v);
      if (typeof decision === "string") return decision;
      const { concern: concernId, ...rest } = decision;
      return { seq, type: v.type, concernId, ...rest };
    }
    case "resolved": {
      const id = asCommentId(v.commentId);
      if (id === null || typeof v.resolved !== "boolean") {
        return "malformed resolved event";
      }
      return { seq, type: v.type, commentId: id, resolved: v.resolved };
    }
    case "offer-dismissed":
      return isOfferId(v.offer)
        ? { seq, type: v.type, offer: v.offer }
        : "offer is not an offer id";
    case "version": {
      if (!isPlanVersion(v.version) || typeof v.hash !== "string") return "malformed version event";
      const carried = parseList(v.carried, parseCarried, "carried");
      if (typeof carried === "string") return carried;
      return { seq, type: v.type, version: v.version, hash: v.hash, carried };
    }
    case "coverage":
      if (typeof v.tip !== "string" || !isSha(v.tip) || typeof v.takenAt !== "string") {
        return "malformed coverage event";
      }
      return { seq, type: v.type, tip: v.tip, takenAt: v.takenAt };
    case "submitted":
      return { seq, type: v.type };
    case "ended":
      return typeof v.review === "string"
        ? { seq, type: v.type, review: v.review }
        : "review is not a path";
    default:
      return "unknown event type";
  }
}

/** The body of GET .../events: the latest seq and the events after the asked-for one. */
export function parseEventBatch(
  v: unknown,
): { readonly seq: number; readonly events: readonly ServerEvent[] } | string {
  if (!isFields<"seq" | "events">(v)) return "not an object";
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
    return "seq is not a number";
  }
  const events = parseList(v.events, parseEvent, "events");
  return typeof events === "string" ? events : { seq: v.seq, events };
}
