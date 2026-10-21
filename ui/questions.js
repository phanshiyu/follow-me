// @ts-check
// Pure logic for the question loop: telling a question from a change request, matching the
// previous version's questions to their answers, placing each answer in the new plan, and deciding
// where playback stops for one. No DOM, no fetch.

/**
 * @typedef {{ kind: "hunk", unit: string, commit: number, changes: readonly number[] | null }
 *   | { kind: "message", commit: number } | { kind: "position", commit: number }
 *   | { kind: "plan" }} Anchor
 * @typedef {{ id: string, anchor: Anchor, body: string, kind?: string,
 *   context: { commitMessage: string, path: string | null, lines?: string[] } }} AskedComment
 * @typedef {{ comment: string, status: string, note: string,
 *   at?: { commit: number, unit?: string } }} Response
 * @typedef {{ version: number, comments: AskedComment[], responses: Response[] }} Previous
 * @typedef {{ unit: string, select: { kind: "rest" } | { kind: "lines", changes: number[] } }} Ref
 * @typedef {{ commit: number, unit: string | null, continues: number[] }} Place
 * @typedef {{ id: string, comment: AskedComment, response: Response | null, status: string,
 *   resolved: boolean, place: Place | null }} AnswerCard
 */

const QUESTION_WORDS = /^\s*(why|what|how|when|where|is|does|can|should)(?![\w'’])/i;

/**
 * What a comment is, guessed from its text: a question when it ends with a question mark or
 * opens with a question word. The reviewer can override the guess.
 * @param {string} text
 * @returns {"question" | "change"}
 */
export function inferKind(text) {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_WORDS.test(trimmed) ? "question" : "change";
}

/**
 * Whether a commit's ref takes any of the lines a comment was on. A "rest" ref takes them all.
 * @param {Ref} ref
 * @param {readonly number[] | null} changes null means the whole unit
 */
function takes(ref, changes) {
  if (ref.select.kind === "rest" || changes === null) return true;
  const own = new Set(ref.select.changes);
  return changes.some((c) => own.has(c));
}

/**
 * Where an answer belongs in the new plan. The agent's own "at" wins, with its 1-based commit.
 * Otherwise the first commit that now holds the lines asked about, and the later ones after it.
 * null when the code is gone and the answer can only live in the Answers panel.
 * @param {AskedComment} comment
 * @param {Response | null} response
 * @param {readonly { refs: readonly Ref[] }[]} commits
 * @returns {Place | null}
 */
export function placeAnswer(comment, response, commits) {
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

/**
 * One card per question of the previous version, in the order they were asked.
 * @param {Previous | null} previous
 * @param {readonly string[]} resolved ids the reviewer marked resolved
 * @param {readonly { refs: readonly Ref[] }[]} commits
 * @returns {AnswerCard[]}
 */
export function answerCards(previous, resolved, commits) {
  if (previous === null) return [];
  return previous.comments
    .filter((c) => c.kind === "question")
    .map((comment) => {
      const response = previous.responses.find((r) => r.comment === comment.id) ?? null;
      return {
        id: comment.id,
        comment,
        response,
        status: response?.status ?? "unanswered",
        resolved: resolved.includes(comment.id),
        place: placeAnswer(comment, response, commits),
      };
    });
}

/**
 * How many of the previous questions the new plan answered.
 * @param {Previous | null} previous
 */
export function answeredCount(previous) {
  if (previous === null) return 0;
  const asked = new Set(previous.comments.filter((c) => c.kind === "question").map((c) => c.id));
  return previous.responses.filter((r) => r.status === "answered" && asked.has(r.comment)).length;
}

/**
 * The cards that belong on a commit: those under its message when unit is null, those above a
 * unit otherwise. A card placed on a unit the commit does not show falls back to the message.
 * @param {readonly AnswerCard[]} cards
 * @param {number} commit
 * @param {string | null} unit
 * @param {readonly string[]} shown unit ids the commit shows
 */
export function cardsAt(cards, commit, unit, shown) {
  return cards.filter((card) => {
    if (card.place === null || card.place.commit !== commit) return false;
    const home =
      card.place.unit !== null && shown.includes(card.place.unit) ? card.place.unit : null;
    return home === unit;
  });
}

/**
 * The comment an "Ask again" posts: same place, in this plan, tied to the question it continues.
 * An anchor whose code is gone falls back to the whole plan.
 * @param {AnswerCard} card
 * @param {string} body
 */
export function askAgain(card, body) {
  const { anchor, context } = card.comment;
  const commit = card.place?.commit ?? 0;
  /** @type {Anchor} */
  let next = { kind: "plan" };
  if (anchor.kind === "hunk" && card.place?.unit) {
    next = { kind: "hunk", unit: card.place.unit, commit, changes: anchor.changes };
  } else if (anchor.kind === "message" || anchor.kind === "position") {
    next = { kind: anchor.kind, commit };
  }
  return { anchor: next, context, body, kind: "question", follows: card.id };
}

/**
 * The step where playback stops for an unresolved answer: right after the narration of the beat
 * it sits on, so the reviewer hears the explanation and then sees the answer to their question.
 * A card on a commit as a whole stops after that commit's intro.
 * @param {readonly { kind: string, commit: number, unit?: string }[]} beats
 * @param {readonly { kind: string, beat: number }[]} steps
 * @param {number} position
 * @param {readonly AnswerCard[]} cards
 * @param {ReadonlySet<string>} seen cards already shown, so a replay does not stop again
 * @returns {AnswerCard[]}
 */
export function holdAt(beats, steps, position, cards, seen) {
  const step = steps[position];
  if (step === undefined) return [];
  return cards.filter((card) => {
    if (card.resolved || seen.has(card.id) || card.place === null) return false;
    const { commit, unit } = card.place;
    if (unit === null) {
      const intro = beats.findIndex((b) => b.kind === "intro" && b.commit === commit);
      const next = steps.findIndex((s) => s.beat > intro);
      return position === next && next !== -1;
    }
    const target = beats.findIndex(
      (b) => b.kind === "chunk" && b.commit === commit && b.unit === unit,
    );
    if (target === -1) return false;
    return position === steps.findIndex((s) => s.beat === target && s.kind !== "say");
  });
}

/**
 * Questions and change requests on a commit, for the two counts in the commit list.
 * @param {readonly { anchor: Anchor, kind?: string }[]} comments
 * @param {number} commit
 */
export function kindCounts(comments, commit) {
  const here = comments.filter((c) => c.anchor.kind !== "plan" && c.anchor.commit === commit);
  const questions = here.filter((c) => c.kind === "question").length;
  return { questions, changes: here.length - questions };
}

/**
 * The line that says what a card is waiting on.
 * @param {AnswerCard} card
 */
export function statusLine(card) {
  if (card.resolved) return "Resolved";
  if (card.status === "answered") return "Answered";
  if (card.status === "deferred") return "Deferred";
  if (card.status === "unanswered") return "Not answered";
  return "Answered by changing the plan";
}
