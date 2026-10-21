// What the stack picker shows beside each commit. Pure.

import type { ConcernDecision, ProjectedCommit, WireComment } from "./wire.ts";

export type Badges = {
  /** Threads on this commit that are not resolved. */
  readonly open: number;
  /** Of those, the ones where the agent spoke last, so the reviewer owes the next word. */
  readonly waiting: number;
  readonly pending: number;
  readonly undecided: number;
};

/** The agent spoke last: it started the thread and nobody answered, or its reply is the latest. */
export function waitingOnReviewer(comment: WireComment): boolean {
  const last = comment.replies?.at(-1);
  return last === undefined ? comment.author === "agent" : last.author === "agent";
}

export function badgesOf(
  commit: ProjectedCommit,
  comments: readonly WireComment[],
  decisions: readonly ConcernDecision[],
  resolved: ReadonlySet<string>,
): Badges {
  const here = comments.filter((c) => c.anchor.kind !== "plan" && c.anchor.commit === commit.index);
  const open = here.filter((c) => !resolved.has(c.id));
  const decided = new Set(decisions.map((d) => d.concern));
  return {
    open: open.length,
    waiting: open.filter(waitingOnReviewer).length,
    pending: here.filter((c) => c.pending === true).length,
    undecided: (commit.concerns ?? []).filter((k) => !decided.has(k.id)).length,
  };
}
