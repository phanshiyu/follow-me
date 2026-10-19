// @ts-check
// Pure playback logic. The browser imports it from /playback.js and the tests import it
// directly, so nothing here may touch the DOM or speech APIs.

/**
 * @typedef {{ op: " ", text: string } | { op: "+" | "-", text: string, change: number }} HunkLine
 * @typedef {{ mode: string, blob: string }} Entry
 * @typedef {{ kind: "hunk", id: string, path: string, body: HunkLine[] }
 *   | { kind: "file", id: string, path: string, reason: string, before: Entry | null, after: Entry | null }
 *   | { kind: "mode", id: string, path: string, from: string, to: string }} Unit
 * @typedef {{ kind: "rest" } | { kind: "lines", changes: number[] }} Selection
 * @typedef {{ unit: string, select: Selection, narration?: string, diagram?: string }} Ref
 * @typedef {{ index: number, message: string, narration?: string, diagram?: string, refs: Ref[] }} Commit
 *
 * A beat is one thing the reviewer attends to: a commit's intro, one chunk of its change, or the
 * held finished commit. lines are indices into the hunk body, removals the subset that are "-"
 * lines; f_ and m_ chunks have neither. added counts the non-blank "+" lines.
 * @typedef {{ kind: "intro", commit: number, message: string, narration: string | null }
 *   | { kind: "chunk", commit: number, unit: string, lines: number[], narration: string | null,
 *       removals: number[], label: string, added: number }
 *   | { kind: "outro", commit: number, next: string | null }} Beat
 *
 * A step is a timed slice of a beat. "say" shows the narration card and speaks it, lasting ms or
 * until speech ends plus tail, whichever is later. "show" reveals a chunk's lines. "rest" is the
 * pause after a chunk, "hold" the finished commit.
 * @typedef {{ kind: "say", beat: number, text: string, ms: number, tail: number }
 *   | { kind: "show" | "rest" | "hold", beat: number, ms: number }} Step
 *
 * @typedef {"hidden" | "shown" | "struck"} LineState
 * @typedef {{ name: string, lang: string, default: boolean }} VoiceInfo
 */

export const SPEEDS = [0.75, 1, 1.5, 2];

/** Context lines that may sit between two change lines of one chunk. */
const MAX_GAP = 3;
/** A longer run is cut at the first blank or closing line once it has this many lines. */
const SPLIT_AFTER = 8;
const MAX_CHUNK = 12;

const BEAT_MS = 600;
const HOLD_MS = 2500;
const INTRO_TAIL_MS = 500;
const MAX_SPEECH_RATE = 1.5;
const WORDS_PER_SECOND = 2.5;

/**
 * The key a diff line carries in the DOM, unit id plus its index in the hunk body.
 * @param {string} unit
 * @param {number} line
 */
export function lineKey(unit, line) {
  return `${unit}:${line}`;
}

/** @param {string} message */
export function titleOf(message) {
  return message.split("\n")[0] ?? "";
}

/** @param {string} text */
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Milliseconds to read a text at 1x: about 200 words a minute plus a second to settle.
 * @param {string} text
 */
export function readMs(text) {
  return Math.max(2000, 1000 + 300 * wordCount(text));
}

/**
 * Milliseconds to take in a chunk at 1x. New code costs more to read than removed code.
 * @param {number} added non-blank added lines
 * @param {number} removed
 */
export function codeMs(added, removed) {
  return Math.min(9000, Math.max(2000, 1500 + 400 * added + 200 * removed));
}

/** @param {string | undefined} text */
function present(text) {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** @param {readonly Commit[]} commits */
export function hasNarration(commits) {
  return commits.some(
    (c) => present(c.narration) !== null || c.refs.some((r) => present(r.narration) !== null),
  );
}

/** @param {HunkLine | undefined} line */
function textOf(line) {
  return (line?.text ?? "").replace(/\r?\n$/, "");
}

/**
 * Runs of a ref's own change lines with at most MAX_GAP other lines between them, each cut to at
 * most MAX_CHUNK lines, preferably right after a blank or closing line.
 * @param {readonly HunkLine[]} body
 * @param {ReadonlySet<number>} mine
 */
function runsOf(body, mine) {
  /** @type {number[][]} */
  const runs = [];
  let gap = Number.POSITIVE_INFINITY;
  body.forEach((line, i) => {
    if (line.op === " " || !mine.has(line.change)) {
      gap += 1;
      return;
    }
    const last = runs.at(-1);
    if (last !== undefined && gap <= MAX_GAP) last.push(i);
    else runs.push([i]);
    gap = 0;
  });
  return runs.flatMap((run) => {
    /** @type {number[][]} */
    const pieces = [];
    let rest = run;
    while (rest.length > MAX_CHUNK) {
      const found = rest.findIndex(
        (i, k) => k >= SPLIT_AFTER && k < MAX_CHUNK && /^\s*[}\])]*[;,]?\s*$/.test(textOf(body[i])),
      );
      const cut = found === -1 ? MAX_CHUNK : found + 1;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.length > 0) pieces.push(rest);
    return pieces;
  });
}

const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|def|fn|func|interface|struct|enum|impl|trait|module)\s+([A-Za-z_$][\w$]*)/;

/**
 * The function or class a hunk line sits in: the nearest declaration at or above it. Lines removed in the hunk are skipped; they no longer exist at the tip.
 * @param {readonly HunkLine[]} body
 * @param {number} last
 */
export function scopeOf(body, last) {
  for (let i = last; i >= 0; i -= 1) {
    const line = body[i];
    if (line === undefined || line.op === "-") continue;
    const name = DECLARATION.exec(textOf(line))?.[1];
    if (name !== undefined) return name;
  }
  return null;
}

/** @param {number} n @param {string} word */
function count(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * @param {string} path
 * @param {number} added
 * @param {number} removed
 * @param {string | null} name
 */
function hunkLabel(path, added, removed, name) {
  const what =
    removed === 0
      ? `adds ${count(added, "line")}`
      : added === 0
        ? `removes ${count(removed, "line")}`
        : `adds ${count(added, "line")}, removes ${removed}`;
  return `${path} · ${what}${name === null ? "" : ` in ${name}`}`;
}

/** @param {Exclude<Unit, { kind: "hunk" }>} unit */
function wholeLabel(unit) {
  if (unit.kind === "mode") return `${unit.path} · mode ${unit.from} → ${unit.to}`;
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.path} · ${unit.reason} file ${change}`;
}

/**
 * The beats of the whole plan: per commit an intro, one chunk per run of its own change lines
 * (one per whole-file or mode unit), and an outro. A unit's narration goes on its first chunk.
 * @param {readonly Commit[]} commits
 * @param {readonly Unit[]} units
 * @returns {Beat[]}
 */
export function buildScript(commits, units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  /** @type {Beat[]} */
  const beats = [];
  commits.forEach((commit, k) => {
    beats.push({
      kind: "intro",
      commit: commit.index,
      message: commit.message,
      narration: present(commit.narration),
    });
    for (const ref of commit.refs) {
      const unit = byId.get(ref.unit);
      if (unit === undefined) continue;
      const narration = present(ref.narration);
      if (unit.kind !== "hunk") {
        beats.push({
          kind: "chunk",
          commit: commit.index,
          unit: unit.id,
          lines: [],
          removals: [],
          narration,
          label: wholeLabel(unit),
          added: 0,
        });
        continue;
      }
      const mine = new Set(
        ref.select.kind === "lines"
          ? ref.select.changes
          : unit.body.flatMap((l) => (l.op === " " ? [] : [l.change])),
      );
      runsOf(unit.body, mine).forEach((lines, n) => {
        const additions = lines.filter((i) => unit.body[i]?.op === "+");
        const removals = lines.filter((i) => unit.body[i]?.op === "-");
        const name = scopeOf(unit.body, lines.at(-1) ?? 0);
        beats.push({
          kind: "chunk",
          commit: commit.index,
          unit: unit.id,
          lines,
          removals,
          narration: n === 0 ? narration : null,
          label: hunkLabel(unit.path, additions.length, removals.length, name),
          added: additions.filter((i) => textOf(unit.body[i]).trim() !== "").length,
        });
      });
    }
    const next = commits[k + 1];
    beats.push({
      kind: "outro",
      commit: commit.index,
      next: next === undefined ? null : titleOf(next.message),
    });
  });
  return beats;
}

/**
 * The timed steps of the beats at a speed, which divides every dwell, beat and hold. A commit
 * without narration speaks its title and stays up long enough to read its whole message.
 * @param {readonly Beat[]} beats
 * @param {number} speed
 * @returns {Step[]}
 */
export function schedule(beats, speed) {
  /** @type {(ms: number) => number} */
  const at = (ms) => Math.round(ms / speed);
  return beats.flatMap((beat, i) => {
    if (beat.kind === "intro") {
      const text = beat.narration ?? titleOf(beat.message);
      const ms = at(readMs(beat.narration ?? beat.message));
      return [{ kind: "say", beat: i, text, ms, tail: at(INTRO_TAIL_MS) }];
    }
    if (beat.kind === "outro") return [{ kind: "hold", beat: i, ms: at(HOLD_MS) }];
    /** @type {Step[]} */
    const steps = [];
    if (beat.narration !== null) {
      steps.push({
        kind: "say",
        beat: i,
        text: beat.narration,
        ms: at(readMs(beat.narration)),
        tail: 0,
      });
    }
    steps.push({ kind: "show", beat: i, ms: at(codeMs(beat.added, beat.removals.length)) });
    steps.push({ kind: "rest", beat: i, ms: at(BEAT_MS) });
    return steps;
  });
}

/**
 * Silent playing time of the steps, the floor of what playback takes with speech on.
 * @param {readonly Step[]} steps
 */
export function duration(steps) {
  return steps.reduce((sum, s) => sum + s.ms, 0);
}

/**
 * Synthetic voices are hard to follow above 1.5x, so speech caps there while dwells keep scaling.
 * @param {number} speed
 */
export function speechRate(speed) {
  return Math.min(speed, MAX_SPEECH_RATE);
}

/**
 * A generous upper bound on how long speaking the text takes, for when the browser never
 * reports the end of an utterance.
 * @param {string} text
 * @param {number} speed
 */
export function speechTimeout(text, speed) {
  return (2 * 1000 * wordCount(text)) / (WORDS_PER_SECOND * speechRate(speed)) + 2000;
}

/**
 * The beat on screen at a step position; past the last step that is beats.length, the end.
 * @param {readonly Step[]} steps
 * @param {number} position
 */
export function beatAt(steps, position) {
  const step = steps[position];
  if (step !== undefined) return step.beat;
  return (steps.at(-1)?.beat ?? -1) + 1;
}

/**
 * The first step of a beat, clamped to the steps. A beat past the end lands on the end.
 * @param {readonly Step[]} steps
 * @param {number} beat
 */
export function beatStart(steps, beat) {
  if (beat < 0) return 0;
  const at = steps.findIndex((s) => s.beat === beat);
  return at === -1 ? steps.length : at;
}

/**
 * The commit a beat belongs to; the end belongs to the last commit.
 * @param {readonly Beat[]} beats
 * @param {number} beat
 */
export function commitOf(beats, beat) {
  return (beats[Math.min(beat, beats.length - 1)] ?? beats.at(-1))?.commit ?? 0;
}

/**
 * The intro beat of a commit, clamped: before the first is 0, after the last is the end.
 * @param {readonly Beat[]} beats
 * @param {number} commit
 */
export function introOf(beats, commit) {
  if (commit < 0) return 0;
  const at = beats.findIndex((b) => b.kind === "intro" && b.commit === commit);
  return at === -1 ? beats.length : at;
}

/**
 * How each change line of a commit looks at a step position. Lines are hidden until their chunk
 * shows them; removals then stay as struck lines. Chunks not yet shown, the current one during
 * its narration included, report a placeholder at their first line with their line count.
 * current is the chunk beat on screen, or null during the intro and outro.
 * @param {readonly Beat[]} beats
 * @param {readonly Step[]} steps
 * @param {number} position
 * @param {number} commit
 * @returns {{ states: Map<string, LineState>, upcoming: Map<string, number>, current: number | null }}
 */
export function lineStates(beats, steps, position, commit) {
  /** @type {Map<string, LineState>} */
  const states = new Map();
  /** @type {Map<string, number>} */
  const upcoming = new Map();
  const now = beatAt(steps, position);
  beats.forEach((beat, i) => {
    if (beat.kind !== "chunk" || beat.commit !== commit || beat.lines.length === 0) return;
    const show = steps.findIndex((s) => s.kind === "show" && s.beat === i);
    const shown = position >= steps.length || (show !== -1 && show <= position);
    const first = beat.lines[0];
    if (!shown && first !== undefined) upcoming.set(lineKey(beat.unit, first), beat.lines.length);
    const removals = new Set(beat.removals);
    for (const line of beat.lines) {
      const look = !shown ? "hidden" : removals.has(line) ? "struck" : "shown";
      states.set(lineKey(beat.unit, line), look);
    }
  });
  const beat = beats[now];
  const current = beat?.kind === "chunk" && beat.commit === commit ? now : null;
  return { states, upcoming, current };
}

/**
 * How a hunk reads in one commit. The commit's own lines are the change. Lines earlier commits
 * added are now part of the file and read as context; lines they removed are gone. Lines later
 * commits remove are still there as context, and lines later commits add fold into one row per
 * run and owner.
 * @param {readonly HunkLine[]} body
 * @param {readonly (number | undefined)[]} owners owning commit per change index
 * @param {number} commit
 * @returns {({ kind: "line", line: number, mine: boolean } | { kind: "fold", lines: number[], commit: number })[]}
 */
export function rowsOf(body, owners, commit) {
  /** @type {ReturnType<typeof rowsOf>} */
  const rows = [];
  body.forEach((line, i) => {
    const owner = line.op === " " ? undefined : owners[line.change];
    if (line.op === " " || owner === undefined || owner === commit) {
      rows.push({ kind: "line", line: i, mine: owner === commit });
      return;
    }
    const later = owner > commit;
    if (line.op === "-" ? later : !later) {
      rows.push({ kind: "line", line: i, mine: false });
      return;
    }
    if (line.op === "-") return;
    const last = rows.at(-1);
    if (last?.kind === "fold" && last.commit === owner) last.lines.push(i);
    else rows.push({ kind: "fold", lines: [i], commit: owner });
  });
  return rows;
}

/**
 * One progress segment per commit, weighted by its chunk count, filled by the share of its
 * beats already behind the current one.
 * @param {readonly Beat[]} beats
 * @param {number} beat
 * @returns {{ commit: number, weight: number, filled: number }[]}
 */
export function progress(beats, beat) {
  /** @type {Map<number, { chunks: number, total: number, behind: number }>} */
  const tally = new Map();
  beats.forEach((b, i) => {
    const t = tally.get(b.commit) ?? { chunks: 0, total: 0, behind: 0 };
    tally.set(b.commit, {
      chunks: t.chunks + (b.kind === "chunk" ? 1 : 0),
      total: t.total + 1,
      behind: t.behind + (i < beat ? 1 : 0),
    });
  });
  return [...tally].map(([commit, t]) => ({
    commit,
    weight: Math.max(1, t.chunks),
    filled: t.behind / t.total,
  }));
}

/**
 * Which chunk of its commit a beat is, 1-based, or null for an intro, outro or the end.
 * @param {readonly Beat[]} beats
 * @param {number} beat
 * @returns {{ index: number, count: number } | null}
 */
export function chunkOf(beats, beat) {
  const here = beats[beat];
  if (here?.kind !== "chunk") return null;
  const mine = beats.flatMap((b, i) => (b.kind === "chunk" && b.commit === here.commit ? [i] : []));
  return { index: mine.indexOf(beat) + 1, count: mine.length };
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
