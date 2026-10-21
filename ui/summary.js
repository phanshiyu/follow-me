// @ts-check
// Pure wording for the end of a review: what the reviewer is about to hand over.

/**
 * @typedef {{ anchor: { kind: string, commit?: number }, kind?: string }} SummaryComment
 */

/** @param {number} n @param {string} word */
function count(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "2 comments on 2 commits and 1 on the whole plan, 1 question for the agent, 2 kept concerns",
 * or "No comments". Questions count apart from change requests, since the agent answers them
 * instead of changing the plan.
 * @param {{ comments: readonly SummaryComment[], kept: number, unresolved: number,
 *   walk: boolean }} input
 */
export function endSummary({ comments, kept, unresolved, walk }) {
  const questions = comments.filter((c) => c.kind === "question");
  const changes = comments.filter((c) => c.kind !== "question");
  const onCommits = changes.filter((c) => c.anchor.kind !== "plan");
  const general = changes.length - onCommits.length;
  const commits = new Set(onCommits.map((c) => c.anchor.commit)).size;
  /** @type {string[]} */
  const parts = [];
  if (onCommits.length > 0) {
    parts.push(`${count(onCommits.length, "comment")} on ${count(commits, "commit")}`);
  }
  if (general > 0) parts.push(`${general} on the whole ${walk ? "branch" : "plan"}`);
  const sentence = [parts.join(" and ")].filter(Boolean);
  if (questions.length > 0) sentence.push(`${count(questions.length, "question")} for the agent`);
  if (kept > 0) sentence.push(`${count(kept, "kept concern")}`);
  if (unresolved > 0) sentence.push(`${count(unresolved, "answer")} not marked resolved`);
  return sentence.length === 0 ? "No comments" : sentence.join(", ");
}

/**
 * Where the report is saved, beside the review file.
 * @param {string} saved path of reviews/vN.json
 */
export function reportPath(saved) {
  return saved.replace(/\.json$/, ".md");
}
