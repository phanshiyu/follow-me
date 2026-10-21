import { isRepoPath, isUnitId } from "./diff.ts";
import {
  diagramProblem,
  isArray,
  isCommentId,
  isConcernId,
  isFields,
  isPlanVersion,
  isSeverity,
} from "./plan.ts";
import type {
  Anchor,
  Comment,
  CommentId,
  ConcernDecision,
  ConcernId,
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

/** The body of POST .../replies: who speaks, what, and an optional Mermaid diagram. */
export function parseNewReply(v: unknown): NewReply | string {
  if (!isFields<"author" | "body" | "diagram">(v)) return "the reply is not an object";
  if (v.author !== "agent" && v.author !== "reviewer") return 'author is not "agent" or "reviewer"';
  if (typeof v.body !== "string" || v.body.trim() === "") return "body is not a non-empty string";
  if (v.diagram === undefined) return { author: v.author, body: v.body };
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
  | "replies";

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
  const follows = v.follows;
  if (follows !== undefined && !(typeof follows === "string" && isCommentId(follows))) {
    return "follows is not a comment id";
  }
  const severity = v.severity;
  if (severity !== undefined && !isSeverity(severity)) return "severity is unknown";
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
  };
}

type DecisionFields = "concern" | "decision" | "severity" | "note";

function withDecision(
  concern: ConcernId,
  v: { readonly [K in DecisionFields]?: unknown },
): ConcernDecision | string {
  if (v.decision !== "kept" && v.decision !== "dismissed") {
    return 'decision is not "kept" or "dismissed"';
  }
  if (v.severity !== undefined && !isSeverity(v.severity)) return "severity is unknown";
  if (v.note !== undefined && typeof v.note !== "string") return "note is not a string";
  return {
    concern,
    decision: v.decision,
    ...(v.severity === undefined ? {} : { severity: v.severity }),
    ...(v.note === undefined || v.note.trim() === "" ? {} : { note: v.note }),
  };
}

/** A stored decision. */
export function parseDecision(v: unknown): ConcernDecision | string {
  if (!isFields<DecisionFields>(v)) return "not an object";
  if (!isConcernId(v.concern)) return "concern is not a concern id";
  return withDecision(v.concern, v);
}

/** The body of POST .../concerns/<id>; the id comes from the URL. */
export function parseNewDecision(concern: ConcernId, v: unknown): ConcernDecision | string {
  if (!isFields<DecisionFields>(v)) return "the decision is not an object";
  return withDecision(concern, v);
}

/** Absent reads as none. The first item that does not parse names its index and reason. */
function parseList<T>(
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

function asCommentId(item: unknown): CommentId | null {
  return typeof item === "string" && isCommentId(item) ? item : null;
}

function parseCommentId(item: unknown): CommentId | string {
  return asCommentId(item) ?? "not a comment id";
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
  const resolved = parseList(v.resolved, parseCommentId, "resolved");
  if (typeof resolved === "string") return resolved;
  return {
    schema: v.schema,
    mode,
    planVersion: v.planVersion,
    planHash: v.planHash,
    endedAt: v.endedAt,
    comments,
    ...(concerns.length === 0 ? {} : { concerns }),
    ...(resolved.length === 0 ? {} : { resolved }),
  };
}

function lenient<T>(items: unknown, parse: (item: unknown) => T | string): T[] {
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
  if (!isFields<"comments" | "concerns" | "resolved">(v) || !isArray(v.comments)) {
    return "not a review draft";
  }
  return {
    comments: lenient(v.comments, parseComment),
    concerns: lenient(v.concerns, parseDecision),
    resolved: lenient(v.resolved, parseCommentId),
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
  | "resolved"
  | "version"
  | "hash"
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
    case "version": {
      if (!isPlanVersion(v.version) || typeof v.hash !== "string") return "malformed version event";
      return { seq, type: v.type, version: v.version, hash: v.hash };
    }
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
