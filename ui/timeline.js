// @ts-check
// Pure logic for the conversation panel: the timeline in chat order built from page state plus the
// server's event log, where an entry points in the code, which entries belong to the chunk on
// screen, and what is unread. No DOM, no fetch.

import { bodyIndexes } from "./concerns.js";
import { eventBody } from "./live.js";
import { answeredCount, placeAnswer } from "./questions.js";
import { rowsOfAnchor } from "./selection.js";

/**
 * @typedef {{ kind: "hunk", unit: string, commit: number, changes: readonly number[] | null,
 *   offsets?: readonly number[] } | { kind: "message", commit: number }
 *   | { kind: "position", commit: number } | { kind: "plan" }} Anchor
 * @typedef {{ id: string, author: string, body: string, diagram?: string,
 *   createdAt: string }} Reply
 * @typedef {{ id: string, anchor: Anchor, body: string, createdAt: string, kind?: string,
 *   author?: string, follows?: string, severity?: string, replies?: Reply[],
 *   context: { commitMessage: string, path: string | null, lines?: string[] } }} Comment
 * @typedef {{ comment: string, status: string, note: string,
 *   at?: { commit: number, unit?: string } }} Response
 * @typedef {{ id: string, severity: string, kind: string, text: string, lines?: number[],
 *   unit?: string }} Concern
 * @typedef {{ concern: string, decision: "kept" | "dismissed", severity?: string, note?: string,
 *   decidedAt?: string }} Decision
 * @typedef {{ kind: string, unit: string, select: { kind: string, changes?: number[] } }} Ref
 * @typedef {{ kind: string, id: string, path: string,
 *   body?: readonly import("./selection.js").BodyRow[] }} TimelineUnit
 * @typedef {{ version: number, comments: Comment[], responses: Response[] }} Previous
 * @typedef {{ comments: Comment[], previous: Previous | null, decisions: Record<string, Decision>,
 *   resolved: string[], version: number, units: TimelineUnit[],
 *   commits: { index: number, refs: { unit: string, select: { kind: "rest" } | { kind: "lines",
 *   changes: number[] } }[], concerns?: Concern[] }[] }} TimelineState
 * @typedef {{ type: string, seq?: number, [key: string]: unknown }} LogEvent
 *
 * @typedef {{ kind: "comment", id: string, thread: string, comment: Comment,
 *   from: "you" | "agent" }
 *   | { kind: "reply", id: string, thread: string, comment: Comment, reply: Reply,
 *       from: "you" | "agent" }
 *   | { kind: "concern", id: string, thread: null, concernId: string, concern: Concern | null,
 *       decision: "kept" | "dismissed", severity: string | null, note: string | null }
 *   | { kind: "resolved", id: string, thread: string, comment: Comment, resolved: boolean }
 *   | { kind: "version", id: string, thread: null, version: number, asked: number | null,
 *       answered: number | null }
 *   | { kind: "answer", id: string, thread: string, comment: Comment, response: Response }
 *   | { kind: "ended", id: string, thread: null }} Entry
 * @typedef {{ stale: true } | { stale: false, at: { commit: number, unit: string | null,
 *   rows: number[] } | null }} Place
 * @typedef {{ commit: number, unit?: string | null, rows?: readonly number[] | null }} Here
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Comment} */
function isComment(value) {
  return isRecord(value) && typeof value["id"] === "string" && isRecord(value["anchor"]);
}

/** @param {unknown} value @returns {value is Reply} */
function isReply(value) {
  return isRecord(value) && typeof value["id"] === "string";
}

/** @param {Comment} comment @returns {"you" | "agent"} */
function authorOf(comment) {
  return comment.author === "agent" ? "agent" : "you";
}

/**
 * The conversation in the order it happened, oldest first. The event log gives the order for what
 * it holds. After a server restart the log is gone, and what the saved state holds is placed by
 * its timestamps: comments, replies and, once the server stamps them, concern decisions. What has
 * no time at all, an old decision or a resolved mark, goes after the rest. The review ending is
 * always last. A plan version divider comes from the log, or is made from the previous version
 * when the log has none.
 * @param {TimelineState} state
 * @param {readonly LogEvent[]} events
 * @returns {Entry[]}
 */
export function timelineOf(state, events) {
  const ordered = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const previous = state.previous;
  const concerns = new Map(state.commits.flatMap((c) => c.concerns ?? []).map((c) => [c.id, c]));

  /** @type {Map<string, Comment>} */
  const known = new Map();
  const gone = new Set();
  /** @type {Map<string, Map<string, Reply>>} */
  const replies = new Map();
  /** @param {string} commentId @param {Reply} reply */
  const addReply = (commentId, reply) => {
    const have = replies.get(commentId) ?? new Map();
    if (!have.has(reply.id)) have.set(reply.id, reply);
    replies.set(commentId, have);
  };

  for (const event of ordered) {
    const body = eventBody(event);
    if (event.type === "comment" || event.type === "comment-updated") {
      const comment = body["comment"] ?? body;
      if (isComment(comment)) known.set(comment.id, comment);
    } else if (event.type === "comment-deleted") {
      const id = body["id"] ?? body["commentId"];
      if (typeof id === "string") gone.add(id);
    }
  }
  const held = [...(previous?.comments ?? []), ...state.comments];
  for (const comment of held) known.set(comment.id, comment);
  const inState = new Set(held.map((c) => c.id));
  for (const id of gone) if (!inState.has(id)) known.delete(id);
  for (const comment of held)
    for (const reply of comment.replies ?? []) addReply(comment.id, reply);

  /** @type {(Entry & { t: string | null })[]} */
  const logged = [];
  /** @type {(Entry & { t: string | null })[]} */
  const loose = [];
  const seenComment = new Set();
  const seenReply = new Set();
  const seenConcern = new Set();
  const seenResolved = new Set();
  let versionLogged = false;
  let ended = false;
  /** @type {string | null} */
  let clock = null;

  /** @param {Comment} comment @param {string | null} t @returns {Entry & { t: string | null }} */
  const commentEntry = (comment, t) => ({
    kind: "comment",
    id: `c:${comment.id}`,
    thread: comment.id,
    comment,
    from: authorOf(comment),
    t,
  });
  /** @param {Comment} comment @param {Reply} reply @returns {Entry & { t: string | null }} */
  const replyEntry = (comment, reply) => ({
    kind: "reply",
    id: `r:${reply.id}`,
    thread: comment.id,
    comment,
    reply,
    from: reply.author === "agent" ? "agent" : "you",
    t: reply.createdAt,
  });

  for (const event of ordered) {
    const body = eventBody(event);
    switch (event.type) {
      case "comment": {
        const id = isComment(body["comment"]) ? body["comment"].id : body["id"];
        const comment = typeof id === "string" ? known.get(id) : undefined;
        if (comment === undefined || seenComment.has(comment.id)) break;
        seenComment.add(comment.id);
        clock = comment.createdAt;
        logged.push(commentEntry(comment, clock));
        break;
      }
      case "reply": {
        const id = body["commentId"];
        const reply = body["reply"];
        const comment = typeof id === "string" ? known.get(id) : undefined;
        if (comment === undefined || !isReply(reply)) break;
        const own = replies.get(comment.id)?.get(reply.id) ?? reply;
        if (seenReply.has(own.id)) break;
        seenReply.add(own.id);
        addReply(comment.id, own);
        clock = own.createdAt;
        logged.push(replyEntry(comment, own));
        break;
      }
      case "concern": {
        const id = body["concernId"];
        const verdict = body["decision"];
        if (typeof id !== "string" || (verdict !== "kept" && verdict !== "dismissed")) break;
        seenConcern.add(id);
        logged.push({
          kind: "concern",
          id: `k:${id}:${event.seq ?? logged.length}`,
          thread: null,
          concernId: id,
          concern: concerns.get(id) ?? null,
          decision: verdict,
          severity: typeof body["severity"] === "string" ? body["severity"] : null,
          note: typeof body["note"] === "string" ? body["note"] : null,
          t: clock,
        });
        break;
      }
      case "resolved": {
        const id = body["commentId"];
        const comment = typeof id === "string" ? known.get(id) : undefined;
        if (comment === undefined || typeof body["resolved"] !== "boolean") break;
        seenResolved.add(comment.id);
        logged.push({
          kind: "resolved",
          id: `x:${comment.id}:${event.seq ?? logged.length}`,
          thread: comment.id,
          comment,
          resolved: body["resolved"],
          t: clock,
        });
        break;
      }
      case "version": {
        const version = body["version"];
        if (typeof version !== "number") break;
        if (version === state.version) versionLogged = true;
        logged.push(dividerFor(version, state, previous));
        break;
      }
      case "ended":
        ended = true;
        break;
      default:
    }
  }

  for (const comment of known.values()) {
    if (!seenComment.has(comment.id)) loose.push(commentEntry(comment, comment.createdAt));
    for (const reply of replies.get(comment.id)?.values() ?? []) {
      if (!seenReply.has(reply.id)) loose.push(replyEntry(comment, reply));
    }
  }
  for (const [id, decision] of Object.entries(state.decisions)) {
    if (seenConcern.has(id)) continue;
    loose.push({
      kind: "concern",
      id: `k:${id}`,
      thread: null,
      concernId: id,
      concern: concerns.get(id) ?? null,
      decision: decision.decision,
      severity: decision.severity ?? null,
      note: decision.note ?? null,
      t: decision.decidedAt ?? null,
    });
  }
  for (const id of state.resolved) {
    const comment = known.get(id);
    if (seenResolved.has(id) || comment === undefined) continue;
    loose.push({
      kind: "resolved",
      id: `x:${id}`,
      thread: id,
      comment,
      resolved: true,
      t: null,
    });
  }

  const dated = loose
    .filter((e) => e.t !== null)
    .sort((a, b) => (a.t ?? "").localeCompare(b.t ?? ""));
  const out = [...logged];
  for (const entry of dated) {
    const at = out.findIndex((e) => e.t !== null && e.t > (entry.t ?? ""));
    if (at === -1) out.push(entry);
    else out.splice(at, 0, entry);
  }
  out.push(...loose.filter((e) => e.t === null));

  if (!versionLogged && previous !== null && previous.comments.length > 0) {
    const old = new Set(previous.comments.map((c) => c.id));
    const last = out.findLastIndex((e) => e.thread !== null && old.has(e.thread));
    out.splice(last + 1, 0, dividerFor(state.version, state, previous));
  }
  if (previous !== null) {
    const at = out.findIndex((e) => e.kind === "version" && e.version === state.version);
    if (at !== -1) out.splice(at + 1, 0, ...answersOf(previous));
  }
  if (ended) out.push({ kind: "ended", id: "ended", thread: null, t: null });
  return out.map(({ t: _t, ...entry }) => entry);
}

/**
 * @param {number} version
 * @param {TimelineState} state
 * @param {Previous | null} previous
 * @returns {Entry & { t: string | null }}
 */
function dividerFor(version, state, previous) {
  const known = version === state.version && previous !== null;
  const asked = known ? previous.comments.filter((c) => c.kind === "question").length : null;
  return {
    kind: "version",
    id: `v:${version}`,
    thread: null,
    version,
    asked,
    answered: known ? answeredCount(previous) : null,
    t: null,
  };
}

/**
 * One entry per question of the previous version the new plan answered or deferred.
 * @param {Previous} previous
 * @returns {(Entry & { t: null })[]}
 */
function answersOf(previous) {
  return previous.responses.flatMap((response) => {
    const comment = previous.comments.find((c) => c.id === response.comment);
    return comment === undefined
      ? []
      : [
          {
            kind: /** @type {const} */ ("answer"),
            id: `a:${comment.id}`,
            thread: comment.id,
            comment,
            response,
            t: null,
          },
        ];
  });
}

/**
 * The line a divider reads: "Plan v2 opened · answers 3 of 4 questions".
 * @param {{ version: number, asked: number | null, answered: number | null }} entry
 */
export function dividerText(entry) {
  const tail =
    entry.asked === null || entry.asked === 0
      ? ""
      : ` · answers ${entry.answered ?? 0} of ${entry.asked} question${entry.asked === 1 ? "" : "s"}`;
  return `Plan v${entry.version} opened${tail}`;
}

/**
 * The line a decision reads: "You kept the agent's concern, major bug, on src/lib.js".
 * @param {Extract<Entry, { kind: "concern" }>} entry
 * @param {Readonly<Record<string, string>>} paths unit id to path
 */
export function concernLine(entry, paths) {
  const verb = entry.decision === "kept" ? "kept" : "dismissed";
  const { concern } = entry;
  if (concern === null) return `You ${verb} an agent concern`;
  const level = entry.severity ?? concern.severity;
  const where = concern.unit === undefined ? "" : ` on ${paths[concern.unit] ?? "this commit"}`;
  return `You ${verb} the agent's concern, ${level} ${concern.kind},${where}`.replace(/,$/, "");
}

/**
 * Where an entry points in the plan on screen. none for the whole plan and for rows that point
 * nowhere; stale when the code it was about is gone from this plan.
 * @param {TimelineState} state
 * @param {Entry} entry
 * @returns {Place}
 */
export function locate(state, entry) {
  if (entry.kind === "concern") return locateConcern(state, entry.concern);
  if (entry.kind === "version" || entry.kind === "ended") return { stale: false, at: null };
  const { comment } = entry;
  const { anchor } = comment;
  if (anchor.kind === "plan") return { stale: false, at: null };
  const earlier =
    state.previous?.comments.some((c) => c.id === comment.id) === true &&
    !state.comments.some((c) => c.id === comment.id);
  let commit = anchor.commit;
  /** @type {string | null} */
  let unit = anchor.kind === "hunk" ? anchor.unit : null;
  if (earlier) {
    const response = state.previous?.responses.find((r) => r.comment === comment.id) ?? null;
    const place = placeAnswer(comment, response, state.commits);
    if (place === null) return { stale: true };
    commit = place.commit;
    unit = place.unit;
  }
  const home = state.commits[commit];
  if (home === undefined) return { stale: true };
  if (anchor.kind !== "hunk") return { stale: false, at: { commit, unit, rows: [] } };
  const hunk = state.units.find((u) => u.id === unit);
  if (unit === null || hunk === undefined || !home.refs.some((r) => r.unit === unit)) {
    return { stale: true };
  }
  return { stale: false, at: { commit, unit, rows: rowsOfAnchor(anchor, hunk.body ?? []) } };
}

/**
 * @param {TimelineState} state
 * @param {Concern | null} concern
 * @returns {Place}
 */
function locateConcern(state, concern) {
  if (concern === undefined || concern === null) return { stale: false, at: null };
  const commit = state.commits.find((c) => (c.concerns ?? []).some((k) => k.id === concern.id));
  if (commit === undefined) return { stale: false, at: null };
  const unit = concern.unit ?? null;
  const body = state.units.find((u) => u.id === unit)?.body ?? [];
  return {
    stale: false,
    at: { commit: commit.index, unit, rows: bodyIndexes(body, concern.lines ?? []) },
  };
}

/**
 * Whether a place is on the chunk on screen. A chunk is its unit and the span of rows it covers,
 * so context rows inside the span count. Without a unit the whole commit is here.
 * @param {Place} place
 * @param {Here} here
 */
export function isHere(place, here) {
  if (place.stale || place.at === null || place.at.commit !== here.commit) return false;
  if (here.unit === undefined || here.unit === null) return true;
  if (place.at.unit !== here.unit) return false;
  const rows = here.rows ?? [];
  if (rows.length === 0 || place.at.rows.length === 0) return true;
  const [low, high] = [Math.min(...rows), Math.max(...rows)];
  return place.at.rows.some((r) => r >= low && r <= high);
}

/**
 * The entries on the chunk on screen, and how many threads they make up.
 * @param {TimelineState} state
 * @param {readonly Entry[]} entries
 * @param {Here} here
 * @returns {{ ids: Set<string>, threads: number }}
 */
export function entriesHere(state, entries, here) {
  const mine = entries.filter((e) => isHere(locate(state, e), here));
  return {
    ids: new Set(mine.map((e) => e.id)),
    threads: new Set(mine.flatMap((e) => (e.thread === null ? [] : [e.thread]))).size,
  };
}

/**
 * The beat playback must be at for the rows an entry points at to be on screen: the chunk of that
 * unit that reveals one of them. null when none of them is hidden by playback, as for context
 * rows, a message or a whole hunk.
 * @param {readonly { kind: string, commit: number, unit?: string, lines?: number[] }[]} beats
 * @param {{ commit: number, unit: string | null, rows: readonly number[] }} at
 */
export function beatFor(beats, at) {
  if (at.unit === null || at.rows.length === 0) return null;
  const found = beats.findIndex(
    (b) =>
      b.kind === "chunk" &&
      b.commit === at.commit &&
      b.unit === at.unit &&
      (b.lines ?? []).some((line) => at.rows.includes(line)),
  );
  return found === -1 ? null : found;
}

/**
 * Agent comments and replies after the last entry the reader has seen.
 * @param {readonly Entry[]} entries
 * @param {string | null} readUpTo id of the last entry seen, null for none
 */
export function unreadAfter(entries, readUpTo) {
  const at = readUpTo === null ? -1 : entries.findIndex((e) => e.id === readUpTo);
  return entries
    .slice(at + 1)
    .filter((e) => (e.kind === "comment" || e.kind === "reply") && e.from === "agent").length;
}

/**
 * Whether a scroll box shows its end, give or take a few pixels.
 * @param {{ scrollTop: number, clientHeight: number, scrollHeight: number }} box
 */
export function atBottom(box, slack = 24) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

/**
 * The first rows of a quote, and how many the rest holds.
 * @param {readonly string[]} lines
 */
export function quoteOf(lines, shown = 3) {
  return { shown: lines.slice(0, shown), more: Math.max(0, lines.length - shown) };
}

/**
 * Where a comment points, in words: "src/lib.js · lines 17-18 · commit 4". A comment from an
 * earlier plan names its version, since its commit number may mean another commit now.
 * @param {Comment} comment
 * @param {{ rows: string, whole: string, version: number | null }} how rows is the file lines of a
 *   hunk comment, whole what a plan comment points at, version the plan the comment was made on
 */
export function anchorText(comment, how) {
  const { anchor } = comment;
  if (anchor.kind === "plan") return how.whole;
  const commit = `commit ${anchor.commit + 1}${how.version === null ? "" : ` (v${how.version})`}`;
  if (anchor.kind === "message") return `commit message · ${commit}`;
  if (anchor.kind === "position") return `position · ${commit}`;
  const path = comment.context.path ?? "";
  return [path, how.rows, commit].filter(Boolean).join(" · ");
}

/**
 * The one line an inline chip shows for a thread: "Question · 2 replies · answered".
 * @param {Comment} comment
 * @param {{ walk: boolean, resolved: boolean }} how
 */
export function chipText(comment, { walk, resolved }) {
  const agent = comment.author === "agent";
  const kind = agent
    ? "Agent note"
    : comment.kind === "question"
      ? "Question"
      : walk
        ? "Code comment"
        : "Change request";
  const n = comment.replies?.length ?? 0;
  const parts = [kind];
  if (n > 0) parts.push(`${n} ${n === 1 ? "reply" : "replies"}`);
  if (resolved) parts.push("resolved");
  else if (comment.kind === "question" && comment.replies?.some((r) => r.author === "agent")) {
    parts.push("answered");
  }
  return parts.join(" · ");
}

/**
 * The first line of a text, cut to fit one line of the panel.
 * @param {string} text
 */
export function snippet(text, max = 60) {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
