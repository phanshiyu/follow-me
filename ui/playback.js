// @ts-check
// Pure playback logic. The browser imports it from /playback.js and the tests import it
// directly, so nothing here may touch the DOM or speech APIs.

/**
 * @typedef {{ op: " ", text: string } | { op: "+" | "-", text: string, change: number }} HunkLine
 * @typedef {{ kind: "hunk", id: string, path: string, body: HunkLine[] }
 *   | { kind: "file" | "mode", id: string, path: string }} Unit
 * @typedef {{ kind: "rest" } | { kind: "lines", changes: number[] }} Selection
 * @typedef {{ unit: string, select: Selection, narration?: string }} Ref
 * @typedef {{ index: number, message: string, narration?: string, refs: Ref[] }} Commit
 * @typedef {{ kind: "commit", commit: number, say: string }
 *   | { kind: "unit", commit: number, unit: string, say: string | null }
 *   | { kind: "line", commit: number, unit: string, line: number, change: number, op: "+" | "-" }} Step
 * @typedef {"hidden" | "shown" | "gone"} LineState
 * @typedef {{ name: string, lang: string, default: boolean }} VoiceInfo
 */

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const LINES_PER_SECOND = 4;
const COMMIT_BEAT_MS = 700;
const UNIT_BEAT_MS = 350;
const WORDS_PER_SECOND = 2.5;

/**
 * The key a diff line carries in the DOM, unit id plus its index in the hunk body.
 * @param {string} unit
 * @param {number} line
 */
export function lineKey(unit, line) {
  return `${unit}:${line}`;
}

/**
 * What is spoken when a commit starts: its narration, else its title.
 * @param {Commit} commit
 */
export function commitNarration(commit) {
  const narration = commit.narration?.trim();
  if (narration) return narration;
  return commit.message.split("\n")[0] ?? "";
}

/**
 * Every step of the playback in order: a commit begins, each of its units begins, and each of
 * the commit's own change lines appears (+) or fades out (-) in hunk order.
 * @param {readonly Commit[]} commits
 * @param {readonly Unit[]} units
 * @returns {Step[]}
 */
export function buildScript(commits, units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  /** @type {Step[]} */
  const steps = [];
  for (const commit of commits) {
    steps.push({ kind: "commit", commit: commit.index, say: commitNarration(commit) });
    for (const ref of commit.refs) {
      const unit = byId.get(ref.unit);
      if (unit === undefined) continue;
      const say = ref.narration?.trim() || null;
      steps.push({ kind: "unit", commit: commit.index, unit: unit.id, say });
      if (unit.kind !== "hunk" || ref.select.kind !== "lines") continue;
      const mine = new Set(ref.select.changes);
      unit.body.forEach((line, i) => {
        if (line.op === " " || !mine.has(line.change)) return;
        steps.push({
          kind: "line",
          commit: commit.index,
          unit: unit.id,
          line: i,
          change: line.change,
          op: line.op,
        });
      });
    }
  }
  return steps;
}

/**
 * How long to rest after a step at the given speed. Lines arrive a few per second; removals
 * take half as long because nothing new needs reading.
 * @param {Step} step
 * @param {number} speed
 */
export function stepDelay(step, speed) {
  if (step.kind === "commit") return COMMIT_BEAT_MS / speed;
  if (step.kind === "unit") return UNIT_BEAT_MS / speed;
  const line = 1000 / (LINES_PER_SECOND * speed);
  return step.op === "+" ? line : line / 2;
}

/**
 * A generous upper bound on how long speaking the text takes, for when the browser never
 * reports the end of an utterance.
 * @param {string} text
 * @param {number} speed
 */
export function speechTimeout(text, speed) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (2 * 1000 * words) / (WORDS_PER_SECOND * speed) + 2000;
}

/**
 * The first step of a commit, clamped to the script. Seeking past the end lands on the end.
 * @param {readonly Step[]} script
 * @param {number} commit
 */
export function commitStart(script, commit) {
  const at = script.findIndex((s) => s.kind === "commit" && s.commit === commit);
  if (at !== -1) return at;
  return commit < 0 ? 0 : script.length;
}

/**
 * The commit on screen at a position: the one whose step was performed last.
 * @param {readonly Step[]} script
 * @param {number} position
 */
export function commitAt(script, position) {
  return script[Math.max(0, Math.min(position, script.length) - 1)]?.commit ?? 0;
}

/**
 * How each change line of a commit looks after `position` steps, and which line was written
 * last. Added lines are hidden until typed; removed lines stay shown until their step.
 * @param {readonly Step[]} script
 * @param {number} position
 * @param {number} commit
 * @returns {{ states: Map<string, LineState>, current: string | null }}
 */
export function lineStates(script, position, commit) {
  /** @type {Map<string, LineState>} */
  const states = new Map();
  /** @type {string | null} */
  let current = null;
  script.forEach((step, i) => {
    if (step.kind !== "line" || step.commit !== commit) return;
    const key = lineKey(step.unit, step.line);
    const done = i < position;
    if (step.op === "+") states.set(key, done ? "shown" : "hidden");
    else states.set(key, done ? "gone" : "shown");
    if (done) current = key;
  });
  if (commitAt(script, position) !== commit) current = null;
  return { states, current };
}

/**
 * A speed from storage or a select, snapped to the offered steps.
 * @param {unknown} value
 */
export function parseSpeed(value) {
  const n = Number(value);
  return SPEEDS.includes(n) ? n : 1;
}

/**
 * The voice to preselect: the saved one if the browser still has it, else the browser's
 * default, else the first voice in the reader's language, else none.
 * @param {readonly VoiceInfo[]} voices
 * @param {string | null} saved
 * @param {string} language
 * @returns {string | null}
 */
export function pickVoice(voices, saved, language) {
  if (saved !== null && voices.some((v) => v.name === saved)) return saved;
  const prefix = language.split("-")[0] ?? "";
  const match =
    voices.find((v) => v.default && v.lang.startsWith(prefix)) ??
    voices.find((v) => v.lang === language) ??
    voices.find((v) => v.lang.startsWith(prefix));
  return match?.name ?? null;
}
