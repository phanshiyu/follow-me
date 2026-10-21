// Folds the server's events into the page state. Replaying an event is harmless, because the
// stream replays everything after the seq the page last read. Pure.

import type { Comment, ServerEvent, State, WireComment } from "./wire.ts";

function upsert<T extends { readonly id: string }>(list: readonly T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  if (at === -1) return [...list, item];
  return list.map((x, i) => (i === at ? item : x));
}

/**
 * The state after one event. A new plan version and the end carry nothing to fold in; the caller
 * refetches or stops on those.
 */
export function applyEvent(state: State, event: ServerEvent): State {
  const seq = Math.max(state.seq, event.seq);
  const next = (patch: Partial<State>): State => ({ ...state, ...patch, seq });
  switch (event.type) {
    case "comment":
    case "comment-updated": {
      const existing = state.comments.find((c) => c.id === event.comment.id);
      // An update that omits the thread must not erase replies the page already holds.
      const replies = event.comment.replies ?? existing?.replies;
      const comment: WireComment =
        replies === undefined ? event.comment : { ...event.comment, replies };
      return next({ comments: upsert(state.comments, comment) });
    }
    case "comment-deleted":
      return next({ comments: state.comments.filter((c) => c.id !== event.id) });
    case "reply": {
      // A thread carried over from the previous version stays live: replies land on its old id.
      const reply = (c: Comment) =>
        c.id === event.commentId ? { ...c, replies: upsert(c.replies ?? [], event.reply) } : c;
      return next({
        comments: state.comments.map(reply),
        ...(state.previous === null
          ? {}
          : { previous: { ...state.previous, comments: state.previous.comments.map(reply) } }),
        ...(state.carried === undefined
          ? {}
          : { carried: state.carried.map((c) => ({ ...c, comment: reply(c.comment) })) }),
      });
    }
    case "concern": {
      const { concernId, seq: _seq, type: _type, ...decision } = event;
      const others = state.concerns.filter((d) => d.concern !== concernId);
      return next({ concerns: [...others, { concern: concernId, ...decision }] });
    }
    case "resolved": {
      const others = state.resolved.filter((id) => id !== event.commentId);
      return next({ resolved: event.resolved ? [...others, event.commentId] : others });
    }
    default:
      // version and ended carry nothing to fold in, and a newer server may send types this page
      // does not know.
      return next({});
  }
}
