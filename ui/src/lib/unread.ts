// What the agent said since the reviewer last looked, and how to word it. Pure.

import { lineNumbers } from "./rows.ts";
import type { Comment, CommentId, ServerEvent, State } from "./wire.ts";

export type Notice = {
  /** Stable across replays of the same event. */
  readonly key: string;
  readonly kind: "reply" | "explain" | "version";
  /** The thread to jump to; null when a version arrived with nothing moved to point at. */
  readonly thread: CommentId | null;
  /** The agent's first words, or for a version the plan number. */
  readonly preview: string;
  readonly version?: number;
  readonly moved?: number;
};

const PREVIEW_CHARS = 80;

function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

/** The notice an event makes, or null when it is the reviewer's own doing or nothing to read. */
export function noticeOf(event: ServerEvent): Notice | null {
  switch (event.type) {
    case "reply":
      return event.reply.author === "agent"
        ? {
            key: `reply:${event.reply.id}`,
            kind: "reply",
            thread: event.commentId,
            preview: firstWords(event.reply.body),
          }
        : null;
    case "comment":
      return event.comment.author === "agent"
        ? {
            key: `explain:${event.comment.id}`,
            kind: "explain",
            thread: event.comment.id,
            preview: firstWords(event.comment.body),
          }
        : null;
    case "version": {
      const moved = (event.carried ?? []).filter((c) => c.changed || c.unit === null);
      if (moved.length === 0) return null;
      return {
        key: `version:${event.version}`,
        kind: "version",
        thread: moved[0]?.comment.id ?? null,
        preview: `Plan v${event.version}`,
        version: Number(event.version),
        moved: moved.length,
      };
    }
    default:
      return null;
  }
}

/** The notices of these events that the reviewer has not seen, once each, in arrival order. */
export function unreadOf(seen: ReadonlySet<string>, events: readonly ServerEvent[]): Notice[] {
  const out = new Map<string, Notice>();
  for (const event of events) {
    const notice = noticeOf(event);
    if (notice !== null && !seen.has(notice.key) && !out.has(notice.key)) {
      out.set(notice.key, notice);
    }
  }
  return [...out.values()];
}

/** "src/lib.js:16", "commit 3" or "the branch": where a comment sits. */
export function placeOf(comment: Comment, state: State): string {
  const { anchor, context } = comment;
  if (anchor.kind === "plan") return "the branch";
  if (anchor.kind !== "hunk") return `commit ${anchor.commit + 1}`;
  const path = context.path ?? state.units.find((u) => u.id === anchor.unit)?.path ?? "the code";
  const carried = state.carried?.find((c) => c.comment.id === comment.id);
  const numbers = lineNumbers(state.units).get(anchor.unit);
  const row = anchor.offsets?.at(-1);
  const at = row === undefined ? undefined : numbers?.[row];
  const line = carried !== undefined ? carried.newLine : (at?.new ?? at?.old ?? null);
  return line === null || line === undefined ? path : `${path}:${line}`;
}

/** The toast and the notification: "Agent replied on src/lib.js:16". */
export function titleOfNotice(notice: Notice, state: State): string {
  if (notice.kind === "version") {
    const n = notice.moved ?? 0;
    return `Plan v${notice.version} arrived, ${n} thread${n === 1 ? "" : "s"} moved`;
  }
  const comment = [...state.comments, ...(state.carried ?? []).map((c) => c.comment)].find(
    (c) => c.id === notice.thread,
  );
  const verb = notice.kind === "reply" ? "replied on" : "explained";
  if (comment === undefined) return `Agent ${notice.kind === "reply" ? "replied" : "explained"}`;
  return `Agent ${verb} ${placeOf(comment, state)}`;
}
