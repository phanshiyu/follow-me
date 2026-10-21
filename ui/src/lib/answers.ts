// The previous version's questions and where their answers sit in this plan. Pure.

import type {
  Anchor,
  CommentId,
  CommentResponse,
  NewComment,
  PreviousVersion,
  ProjectedCommit,
  UnitId,
  WireComment,
} from "./wire.ts";

export type Place = {
  readonly commit: number;
  readonly unit: UnitId | null;
  readonly continues: readonly number[];
};

export type AnswerCard = {
  readonly id: CommentId;
  readonly comment: WireComment;
  readonly response: CommentResponse | null;
  readonly resolved: boolean;
  /** null when the code asked about is gone; the card then sits in the branch discussion. */
  readonly place: Place | null;
};

function takes(ref: ProjectedCommit["refs"][number], changes: readonly number[] | null): boolean {
  if (ref.select.kind === "rest" || changes === null) return true;
  const own = new Set(ref.select.changes);
  return changes.some((c) => own.has(c));
}

/**
 * Where an answer belongs. The agent's own `at` wins, with its 1-based commit. Otherwise the first
 * commit that now holds the lines asked about, and the later ones after it.
 */
export function placeAnswer(
  comment: WireComment,
  response: CommentResponse | null,
  commits: readonly ProjectedCommit[],
): Place | null {
  const at = response?.at;
  if (at !== undefined && at.commit >= 1 && at.commit <= commits.length) {
    return { commit: at.commit - 1, unit: at.unit ?? null, continues: [] };
  }
  const { anchor } = comment;
  if (anchor.kind !== "hunk") return null;
  const holders = commits.flatMap((commit, index) =>
    commit.refs.some((r) => r.unit === anchor.unit && takes(r, anchor.changes)) ? [index] : [],
  );
  const [first, ...later] = holders;
  return first === undefined ? null : { commit: first, unit: anchor.unit, continues: later };
}

/** One card per question of the previous version, in the order they were asked. */
export function answerCards(
  previous: PreviousVersion | null,
  resolved: readonly CommentId[],
  commits: readonly ProjectedCommit[],
): AnswerCard[] {
  if (previous === null) return [];
  return previous.comments
    .filter((c) => c.kind === "question")
    .map((comment) => {
      const response = previous.responses.find((r) => r.comment === comment.id) ?? null;
      return {
        id: comment.id,
        comment,
        response,
        resolved: resolved.includes(comment.id),
        place: placeAnswer(comment, response, commits),
      };
    });
}

/**
 * The cards on a commit: under its message when unit is null, above a unit otherwise. A card on a
 * unit the commit does not show falls back to the message.
 */
export function cardsAt(
  cards: readonly AnswerCard[],
  commit: number,
  unit: UnitId | null,
  shown: readonly UnitId[],
): AnswerCard[] {
  return cards.filter((card) => {
    if (card.place === null || card.place.commit !== commit) return false;
    const home =
      card.place.unit !== null && shown.includes(card.place.unit) ? card.place.unit : null;
    return home === unit;
  });
}

/** The comment "Ask again" posts: same place in this plan, tied to the question it continues. */
export function askAgain(card: AnswerCard, body: string): NewComment {
  const { anchor, context } = card.comment;
  const commit = card.place?.commit ?? 0;
  let next: Anchor = { kind: "plan" };
  if (anchor.kind === "hunk" && card.place?.unit) {
    next = { kind: "hunk", unit: card.place.unit, commit, changes: anchor.changes };
  } else if (anchor.kind === "message" || anchor.kind === "position") {
    next = { kind: anchor.kind, commit };
  }
  return { anchor: next, context, body, kind: "question", follows: card.id };
}

/** How many of the previous questions this plan answered. */
export function answeredCount(previous: PreviousVersion | null): {
  answered: number;
  asked: number;
} {
  if (previous === null) return { answered: 0, asked: 0 };
  const asked = new Set(previous.comments.filter((c) => c.kind === "question").map((c) => c.id));
  const answered = previous.responses.filter(
    (r) => r.status === "answered" && asked.has(r.comment),
  ).length;
  return { answered, asked: asked.size };
}
