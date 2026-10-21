// @ts-check
// Pure logic for the agent's concerns: which are still undecided, where each one sits among the
// lines, when playback stops for one and how long a chunk lingers for it. No DOM, no fetch.

import { readMs } from "./playback.js";

/**
 * @typedef {"blocker" | "major" | "minor"} Severity
 * @typedef {{ id: string, severity: Severity, kind: string, text: string, lines?: number[],
 *   unit?: string }} Concern
 * @typedef {{ concern: string, decision: "kept" | "dismissed", severity?: Severity,
 *   note?: string }} Decision
 * @typedef {{ index: number, concerns?: Concern[] }} CommitConcerns
 * @typedef {{ op: string, change?: number }} BodyLine
 * @typedef {{ kind: string, commit: number, unit?: string, lines?: number[] }} Beat
 */

export const SEVERITIES = /** @type {const} */ (["blocker", "major", "minor"]);

/**
 * The severity in force: the reviewer's override when they kept it with one, else the agent's.
 * @param {Concern} concern
 * @param {Readonly<Record<string, Decision>>} decisions
 * @returns {Severity}
 */
export function severityOf(concern, decisions) {
  return decisions[concern.id]?.severity ?? concern.severity;
}

/**
 * @param {Concern} concern
 * @param {Readonly<Record<string, Decision>>} decisions
 * @returns {"undecided" | "kept" | "dismissed"}
 */
export function stateOf(concern, decisions) {
  return decisions[concern.id]?.decision ?? "undecided";
}

/**
 * Every concern of the plan in commit order.
 * @param {readonly CommitConcerns[]} commits
 * @returns {Concern[]}
 */
export function allConcerns(commits) {
  return commits.flatMap((c) => c.concerns ?? []);
}

/**
 * Concerns the reviewer has not decided.
 * @param {readonly Concern[]} concerns
 * @param {Readonly<Record<string, Decision>>} decisions
 */
export function undecided(concerns, decisions) {
  return concerns.filter((c) => stateOf(c, decisions) === "undecided");
}

/**
 * The most severe of some concerns, or null for none.
 * @param {readonly Concern[]} concerns
 * @param {Readonly<Record<string, Decision>>} decisions
 * @returns {Severity | null}
 */
export function topSeverity(concerns, decisions) {
  const found = new Set(concerns.map((c) => severityOf(c, decisions)));
  return SEVERITIES.find((s) => found.has(s)) ?? null;
}

/**
 * Body index of each change line asked for, skipping any the unit does not have.
 * @param {readonly BodyLine[]} body
 * @param {readonly number[]} changes
 */
export function bodyIndexes(body, changes) {
  const wanted = new Set(changes);
  return body.flatMap((line, i) =>
    line.op !== " " && line.change !== undefined && wanted.has(line.change) ? [i] : [],
  );
}

/**
 * The body line a concern's card sits under: below its last pinned line, else below the last
 * line the commit changes in the unit. null when the commit shows none.
 * @param {Concern} concern
 * @param {readonly BodyLine[]} body
 * @param {readonly number[]} own body indexes of the commit's own lines in the unit
 */
export function anchorLine(concern, body, own) {
  const pinned = bodyIndexes(body, concern.lines ?? []).filter((i) => own.includes(i));
  return pinned.at(-1) ?? own.at(-1) ?? null;
}

/**
 * The concerns that belong to a chunk: those whose pinned lines it holds, and unpinned ones on
 * the first chunk of their unit.
 * @param {readonly Concern[]} concerns the commit's
 * @param {readonly Beat[]} beats
 * @param {number} index the chunk's beat
 * @param {readonly BodyLine[]} body of the chunk's unit
 */
export function concernsInChunk(concerns, beats, index, body) {
  const beat = beats[index];
  if (beat?.kind !== "chunk") return [];
  const first = beats.findIndex(
    (b) => b.kind === "chunk" && b.commit === beat.commit && b.unit === beat.unit,
  );
  const held = new Set(beat.lines ?? []);
  return concerns.filter((c) => {
    if (c.unit !== beat.unit) return false;
    if (c.lines === undefined || c.lines.length === 0) return first === index;
    return bodyIndexes(body, c.lines).some((i) => held.has(i));
  });
}

/**
 * The concern y and x act on: the first undecided one of the chunk on screen, else of the commit.
 * @param {readonly Concern[]} commitConcerns
 * @param {readonly Concern[]} chunkConcerns
 * @param {Readonly<Record<string, Decision>>} decisions
 */
export function pickConcern(commitConcerns, chunkConcerns, decisions) {
  return undecided(chunkConcerns, decisions)[0] ?? undecided(commitConcerns, decisions)[0] ?? null;
}

/**
 * Undecided blockers to stop on, at the step that reveals their chunk, once each.
 * @param {readonly Concern[]} inChunk
 * @param {{ kind: string } | undefined} step
 * @param {Readonly<Record<string, Decision>>} decisions
 * @param {ReadonlySet<string>} seen
 */
export function blockersToHold(inChunk, step, decisions, seen) {
  if (step?.kind !== "show") return [];
  return undecided(inChunk, decisions).filter(
    (c) => severityOf(c, decisions) === "blocker" && !seen.has(c.id),
  );
}

/**
 * Extra milliseconds a chunk lingers so its undecided major and minor concerns can be read.
 * Blockers pause playback instead.
 * @param {readonly Concern[]} inChunk
 * @param {Readonly<Record<string, Decision>>} decisions
 * @param {number} speed
 */
export function dwellExtra(inChunk, decisions, speed) {
  return undecided(inChunk, decisions)
    .filter((c) => severityOf(c, decisions) !== "blocker")
    .reduce((sum, c) => sum + Math.round(readMs(c.text) / speed), 0);
}

/**
 * The question asked when the review ends with concerns undecided.
 * @param {number} count
 */
export function undecidedPrompt(count) {
  return `${count} agent concern${count === 1 ? "" : "s"} undecided. Undecided concerns are left out of the report.`;
}

/**
 * The stage header's reminder, or null when nothing waits.
 * @param {number} count
 */
export function toDecide(count) {
  return count === 0 ? null : `${count} agent concern${count === 1 ? "" : "s"} to decide`;
}
