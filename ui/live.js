// @ts-check
// Pure logic for live updates: folding server events into the page state, deciding which commit
// to stay on across a plan swap, and the reconnect delay. No DOM, no fetch.

/**
 * @typedef {{ id: string, author: string, body: string, diagram?: string, createdAt: string }} Reply
 * @typedef {{ id: string, replies?: Reply[], kind?: string, body?: string }} LiveComment
 * @typedef {{ concern: string, decision: "kept" | "dismissed", severity?: string, note?: string,
 *   decidedAt?: string }} Decision
 * @typedef {{ comments: LiveComment[], decisions?: Record<string, Decision>, resolved?: string[],
 *   version: number, [key: string]: unknown }} LiveState
 * @typedef {{ type: string, seq?: number, data?: unknown, [key: string]: unknown }} LiveEvent
 * @typedef {null | "refetch" | "ended"} Effect
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Reply} */
function isReply(value) {
  return isRecord(value) && typeof value["id"] === "string";
}

/** @param {unknown} value @returns {value is LiveComment} */
function isComment(value) {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    (value["replies"] === undefined || Array.isArray(value["replies"]))
  );
}

/**
 * The decisions the server stores as a list, keyed by concern id.
 * @param {readonly Decision[]} list
 * @returns {Record<string, Decision>}
 */
export function decisionsById(list) {
  return Object.fromEntries(list.map((d) => [d.concern, d]));
}

/**
 * An event's fields. The server may nest them under data or flatten them beside type.
 * @param {LiveEvent} event
 * @returns {Record<string, unknown>}
 */
export function eventBody(event) {
  return isRecord(event.data) ? event.data : event;
}

/**
 * Inserts or replaces by id, keeping the position of an existing item. Replaying an event is
 * therefore harmless, which matters because the first poll asks for everything.
 * @template {{ id: string }} T
 * @param {readonly T[]} list
 * @param {T} item
 * @returns {T[]}
 */
function upsert(list, item) {
  const at = list.findIndex((x) => x.id === item.id);
  if (at === -1) return [...list, item];
  return list.map((x, i) => (i === at ? item : x));
}

/**
 * Folds one server event into the page state. Returns a new state, and an effect the caller must
 * carry out: "refetch" when a newer plan version arrived, "ended" when the review is over.
 * @param {LiveState} state
 * @param {LiveEvent} event
 * @returns {{ state: LiveState, effect: Effect }}
 */
export function applyEvent(state, event) {
  const body = eventBody(event);
  switch (event.type) {
    case "comment":
    case "comment-updated": {
      const comment = body["comment"] ?? body;
      if (!isComment(comment)) return { state, effect: null };
      const existing = state.comments.find((c) => c.id === comment.id);
      // An update that omits the thread must not erase replies the page already holds.
      const replies = comment.replies ?? existing?.replies;
      const next = replies === undefined ? comment : { ...comment, replies };
      return { state: { ...state, comments: upsert(state.comments, next) }, effect: null };
    }
    case "comment-deleted": {
      const id = body["id"] ?? body["commentId"];
      return {
        state: { ...state, comments: state.comments.filter((c) => c.id !== id) },
        effect: null,
      };
    }
    case "reply": {
      const reply = body["reply"];
      const target = body["commentId"];
      if (!isReply(reply)) return { state, effect: null };
      const comments = state.comments.map((c) =>
        c.id === target ? { ...c, replies: upsert(c.replies ?? [], reply) } : c,
      );
      return { state: { ...state, comments }, effect: null };
    }
    case "concern": {
      const id = body["concernId"];
      const verdict = body["decision"];
      if (typeof id !== "string" || (verdict !== "kept" && verdict !== "dismissed")) {
        return { state, effect: null };
      }
      /** @type {Decision} */
      const decision = { concern: id, decision: verdict };
      if (typeof body["severity"] === "string") decision.severity = body["severity"];
      if (typeof body["note"] === "string") decision.note = body["note"];
      if (typeof body["decidedAt"] === "string") decision.decidedAt = body["decidedAt"];
      return {
        state: { ...state, decisions: { ...state.decisions, [id]: decision } },
        effect: null,
      };
    }
    case "resolved": {
      const id = body["commentId"];
      if (typeof id !== "string" || typeof body["resolved"] !== "boolean") {
        return { state, effect: null };
      }
      const others = (state.resolved ?? []).filter((x) => x !== id);
      return {
        state: { ...state, resolved: body["resolved"] ? [...others, id] : others },
        effect: null,
      };
    }
    case "version": {
      const version = body["version"];
      const newer = typeof version === "number" && version > state.version;
      return { state, effect: newer ? "refetch" : null };
    }
    case "ended":
      return { state, effect: "ended" };
    default:
      return { state, effect: null };
  }
}

/**
 * The seq to ask for next: the highest the server reported, never going backwards.
 * @param {number} since
 * @param {{ seq?: unknown, events?: readonly LiveEvent[] }} reply
 */
export function nextSince(since, reply) {
  const seqs = (reply.events ?? []).map((e) => e.seq).filter((n) => typeof n === "number");
  const reported = typeof reply.seq === "number" ? reply.seq : 0;
  return Math.max(since, reported, ...seqs);
}

const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 15_000;

/**
 * How long to wait before reconnecting after the given number of failures in a row.
 * @param {number} failures at least 1
 */
export function backoffMs(failures) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * The commit to stay on after a plan swap: the one with the same title, nearest the old index
 * when titles repeat. Falls back to the first commit when it no longer exists.
 * @param {string | null} title first line of the commit on screen
 * @param {number} index its old position
 * @param {readonly { message: string }[]} commits
 */
export function keepCommit(title, index, commits) {
  if (title === null) return 0;
  const same = commits.flatMap((c, i) => (c.message.split("\n")[0] === title ? [i] : []));
  if (same.length === 0) return 0;
  return same.reduce((best, i) => (Math.abs(i - index) < Math.abs(best - index) ? i : best));
}

/**
 * The banner for a new plan version: "Plan v6 arrived, 3 questions answered".
 * @param {number} version
 * @param {number} answered
 */
export function bannerText(version, answered) {
  const tail = answered === 0 ? "" : `, ${answered} question${answered === 1 ? "" : "s"} answered`;
  return `Plan v${version} arrived${tail}`;
}
