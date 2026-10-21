import assert from "node:assert/strict";
import { test } from "node:test";
import type { Beat, Commit, HunkLine, Unit } from "../ui/playback.js";
import {
  beatAt,
  beatStart,
  buildScript,
  chunkOf,
  commitOf,
  describeLines,
  describeRows,
  diagramAt,
  duration,
  hasDiagrams,
  hasNarration,
  introOf,
  lineNumbers,
  lineStates,
  parseSpeed,
  pickVoice,
  progress,
  rowsOf,
  schedule,
  speechRate,
} from "../ui/playback.js";

const units: Unit[] = [
  {
    kind: "hunk",
    id: "h_aaaaaaaaaaaa",
    path: "src/a.ts",
    body: [
      { op: "-", text: "old1\n", change: 0 },
      { op: "+", text: "new1\n", change: 1 },
      { op: " ", text: "same\n" },
      { op: "-", text: "old2\n", change: 2 },
      { op: "+", text: "new2\n", change: 3 },
    ],
  },
  {
    kind: "file",
    id: "f_cccccccccccc",
    path: "logo.png",
    reason: "binary",
    before: null,
    after: { mode: "100644", blob: "4".repeat(40) },
  },
];

const commits: Commit[] = [
  {
    index: 0,
    message: "Rename the first line\n\nbody",
    refs: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1] } }],
  },
  {
    index: 1,
    message: "Swap the second line",
    narration: "Now the second line.",
    refs: [
      {
        unit: "h_aaaaaaaaaaaa",
        select: { kind: "lines", changes: [2, 3] },
        narration: "  This one is subtle. ",
      },
      { unit: "f_cccccccccccc", select: { kind: "rest" } },
    ],
  },
];

test("each commit is an intro, a chunk per run of its own lines, and an outro", () => {
  assert.deepEqual(buildScript(commits, units), [
    { kind: "intro", commit: 0, message: "Rename the first line\n\nbody", narration: null },
    {
      kind: "chunk",
      commit: 0,
      unit: "h_aaaaaaaaaaaa",
      lines: [0, 1],
      removals: [0],
      narration: null,
      label: "src/a.ts · adds 1 line, removes 1",
      added: 1,
    },
    { kind: "outro", commit: 0, next: "Swap the second line" },
    {
      kind: "intro",
      commit: 1,
      message: "Swap the second line",
      narration: "Now the second line.",
    },
    {
      kind: "chunk",
      commit: 1,
      unit: "h_aaaaaaaaaaaa",
      lines: [3, 4],
      removals: [3],
      narration: "This one is subtle.",
      label: "src/a.ts · adds 1 line, removes 1",
      added: 1,
    },
    {
      kind: "chunk",
      commit: 1,
      unit: "f_cccccccccccc",
      lines: [],
      removals: [],
      narration: null,
      label: "logo.png · binary file added",
      added: 0,
    },
    { kind: "outro", commit: 1, next: null },
  ]);
});

test("the schedule waits to read, then to take in the code, and holds each finished commit", () => {
  const beats = buildScript(commits, units);
  const at1x = schedule(beats, 1);
  assert.deepEqual(at1x, [
    { kind: "say", beat: 0, text: "Rename the first line", ms: 2500, tail: 500 },
    { kind: "show", beat: 1, ms: 2100 },
    { kind: "rest", beat: 1, ms: 600 },
    { kind: "hold", beat: 2, ms: 2500 },
    { kind: "say", beat: 3, text: "Now the second line.", ms: 2200, tail: 500 },
    { kind: "say", beat: 4, text: "This one is subtle.", ms: 2200, tail: 0 },
    { kind: "show", beat: 4, ms: 2100 },
    { kind: "rest", beat: 4, ms: 600 },
    { kind: "show", beat: 5, ms: 2000 },
    { kind: "rest", beat: 5, ms: 600 },
    { kind: "hold", beat: 6, ms: 2500 },
  ]);
  assert.deepEqual(schedule(beats, 2), [
    { kind: "say", beat: 0, text: "Rename the first line", ms: 1250, tail: 250 },
    { kind: "show", beat: 1, ms: 1050 },
    { kind: "rest", beat: 1, ms: 300 },
    { kind: "hold", beat: 2, ms: 1250 },
    { kind: "say", beat: 3, text: "Now the second line.", ms: 1100, tail: 250 },
    { kind: "say", beat: 4, text: "This one is subtle.", ms: 1100, tail: 0 },
    { kind: "show", beat: 4, ms: 1050 },
    { kind: "rest", beat: 4, ms: 300 },
    { kind: "show", beat: 5, ms: 1000 },
    { kind: "rest", beat: 5, ms: 300 },
    { kind: "hold", beat: 6, ms: 1250 },
  ]);
  assert.deepEqual([duration(at1x), duration(schedule(beats, 2))], [19900, 9950]);
  assert.deepEqual([speechRate(0.75), speechRate(1), speechRate(2)], [0.75, 1, 1.5]);
});

test("code dwell grows with added lines and clamps between 2 and 9 seconds", () => {
  const added = (n: number): HunkLine[] =>
    Array.from({ length: n }, (_, i) => ({ op: "+", text: `x${i}\n`, change: i }));
  const showMs = (n: number) => {
    const hunk: Unit = { kind: "hunk", id: "h_b", path: "b", body: added(n) };
    const changes = Array.from({ length: n }, (_, i) => i);
    const plan: Commit[] = [
      { index: 0, message: "m", refs: [{ unit: "h_b", select: { kind: "lines", changes } }] },
    ];
    return schedule(buildScript(plan, [hunk]), 1).flatMap((s) => (s.kind === "show" ? [s.ms] : []));
  };
  assert.deepEqual(showMs(1), [2000]);
  assert.deepEqual(showMs(5), [3500]);
  assert.deepEqual(showMs(12), [6300]);
  assert.deepEqual(showMs(25), [6300, 6300, 2000]);
});

test("chunks break at gaps over three lines, cut long runs after a closing line, and name their function", () => {
  const tail: HunkLine[] = Array.from({ length: 14 }, (_, i) => ({
    op: "+",
    text: i === 9 ? "}\n" : `  line${i};\n`,
    change: 2 + i,
  }));
  const body: HunkLine[] = [
    { op: " ", text: "export function mul(a, b) {\n" },
    { op: "+", text: "  check(a);\n", change: 0 },
    { op: " ", text: "  return a * b;\n" },
    { op: " ", text: "}\n" },
    { op: " ", text: "\n" },
    { op: " ", text: "export function div(a, b) {\n" },
    { op: "+", text: "  check(b);\n", change: 1 },
    { op: " ", text: "  return a / b;\n" },
    ...tail,
  ];
  const hunk: Unit = { kind: "hunk", id: "h_b", path: "src/b.js", body };
  const changes = Array.from({ length: 16 }, (_, i) => i);
  const plan: Commit[] = [
    { index: 0, message: "m", refs: [{ unit: "h_b", select: { kind: "lines", changes } }] },
  ];
  const chunks = buildScript(plan, [hunk]).flatMap((b) =>
    b.kind === "chunk" ? [{ lines: b.lines, label: b.label }] : [],
  );
  assert.deepEqual(chunks, [
    { lines: [1], label: "src/b.js · adds 1 line in mul" },
    { lines: [6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], label: "src/b.js · adds 11 lines in div" },
    { lines: [18, 19, 20, 21], label: "src/b.js · adds 4 lines in div" },
  ]);
});

test("line states hide a chunk until it shows, then strike its removals", () => {
  const beats = buildScript(commits, units);
  const steps = schedule(beats, 1);
  const at = (position: number, commit: number) => {
    const { states, upcoming, current } = lineStates(beats, steps, position, commit);
    return { states: Object.fromEntries(states), upcoming: Object.fromEntries(upcoming), current };
  };
  assert.deepEqual(at(4, 1), {
    states: { "h_aaaaaaaaaaaa:3": "hidden", "h_aaaaaaaaaaaa:4": "hidden" },
    upcoming: { "h_aaaaaaaaaaaa:3": 2 },
    current: null,
  });
  assert.deepEqual(at(5, 1), {
    states: { "h_aaaaaaaaaaaa:3": "hidden", "h_aaaaaaaaaaaa:4": "hidden" },
    upcoming: { "h_aaaaaaaaaaaa:3": 2 },
    current: 4,
  });
  assert.deepEqual(at(6, 1), {
    states: { "h_aaaaaaaaaaaa:3": "struck", "h_aaaaaaaaaaaa:4": "shown" },
    upcoming: {},
    current: 4,
  });
  assert.deepEqual(at(10, 0), {
    states: { "h_aaaaaaaaaaaa:0": "struck", "h_aaaaaaaaaaaa:1": "shown" },
    upcoming: {},
    current: null,
  });
  assert.deepEqual(at(steps.length, 1).states, {
    "h_aaaaaaaaaaaa:3": "struck",
    "h_aaaaaaaaaaaa:4": "shown",
  });
});

test("seeking moves by beat and by commit, clamped to the plan", () => {
  const beats = buildScript(commits, units);
  const steps = schedule(beats, 1);
  assert.deepEqual(
    [beatAt(steps, 0), beatAt(steps, 5), beatAt(steps, 7), beatAt(steps, steps.length)],
    [0, 4, 4, 7],
  );
  assert.deepEqual(
    [beatStart(steps, 4), beatStart(steps, 7), beatStart(steps, -1)],
    [5, steps.length, 0],
  );
  assert.deepEqual([introOf(beats, 1), introOf(beats, 2), introOf(beats, -1)], [3, 7, 0]);
  assert.deepEqual([commitOf(beats, 2), commitOf(beats, 3), commitOf(beats, 7)], [0, 1, 1]);
});

test("a hunk reads with earlier lines as context and later additions folded per commit", () => {
  const body: HunkLine[] = [
    { op: "+", text: "import\n", change: 0 },
    { op: " ", text: "fn() {\n" },
    { op: "-", text: "old\n", change: 1 },
    { op: "+", text: "mine\n", change: 2 },
    { op: "-", text: "later gone\n", change: 3 },
    { op: "+", text: "later a\n", change: 4 },
    { op: "+", text: "later b\n", change: 5 },
    { op: "+", text: "last\n", change: 6 },
  ];
  assert.deepEqual(rowsOf(body, [0, 0, 1, 2, 2, 2, 3], 1), [
    { kind: "line", line: 0, mine: false },
    { kind: "line", line: 1, mine: false },
    { kind: "line", line: 3, mine: true },
    { kind: "line", line: 4, mine: false },
    { kind: "fold", lines: [5, 6], commit: 2 },
    { kind: "fold", lines: [7], commit: 3 },
  ]);
});

test("the diagram follows the unit playing, falls back to the commit's, and is loaded only when used", () => {
  const commit: Commit = {
    index: 0,
    message: "m",
    diagram: "flowchart LR\n  a --> b",
    refs: [
      { unit: "h_a", select: { kind: "rest" }, diagram: "sequenceDiagram\n  a->>b: x" },
      { unit: "h_b", select: { kind: "rest" } },
    ],
  };
  const chunk = (unit: string): Beat => ({
    kind: "chunk",
    commit: 0,
    unit,
    lines: [],
    removals: [],
    narration: null,
    label: "",
    added: 0,
  });
  const intro: Beat = { kind: "intro", commit: 0, message: "m", narration: null };
  assert.deepEqual(
    [diagramAt(commit, chunk("h_a")), diagramAt(commit, chunk("h_b")), diagramAt(commit, intro)],
    [
      { source: "sequenceDiagram\n  a->>b: x", unit: "h_a" },
      { source: "flowchart LR\n  a --> b", unit: null },
      { source: "flowchart LR\n  a --> b", unit: null },
    ],
  );
  const unitOnly: Commit = { ...commit, diagram: " " };
  assert.deepEqual(
    [diagramAt(unitOnly, undefined), diagramAt(unitOnly, intro)],
    [{ source: "sequenceDiagram\n  a->>b: x", unit: "h_a" }, null],
  );
  assert.deepEqual([hasDiagrams([commit]), hasDiagrams(commits)], [true, false]);
});

test("lines are numbered in the base and the tip, and comments name them by those numbers", () => {
  const body: HunkLine[] = [
    { op: "+", text: "import\n", change: 0 },
    { op: "+", text: "\n", change: 1 },
    { op: " ", text: "fn() {\n" },
    { op: "-", text: "old\n", change: 2 },
    { op: "+", text: "new\n", change: 3 },
  ];
  const first: Unit = { kind: "hunk", id: "h_1", path: "a.js", oldStart: 0, body };
  const second: Unit = {
    kind: "hunk",
    id: "h_2",
    path: "a.js",
    oldStart: 9,
    body: [
      { op: " ", text: "x\n" },
      { op: "+", text: "y\n", change: 0 },
    ],
  };
  const numbers = lineNumbers([second, first]);
  assert.deepEqual(numbers.get("h_1"), [
    { old: null, new: 1 },
    { old: null, new: 2 },
    { old: 1, new: 3 },
    { old: 2, new: null },
    { old: null, new: 4 },
  ]);
  assert.deepEqual(numbers.get("h_2"), [
    { old: 10, new: 12 },
    { old: null, new: 13 },
  ]);
  const h1 = numbers.get("h_1") ?? [];
  assert.deepEqual(
    [
      describeLines(body, h1, [3]),
      describeLines(body, h1, [0, 1]),
      describeLines(body, h1, [0, 1, 2, 3]),
      describeLines(body, h1, [2]),
    ],
    ["line 4", "lines 1-2", "lines 1-2, 4, old 2", "old line 2"],
  );
});

test("progress weighs commits by chunks and fills by the beats behind, and names the chunk", () => {
  const beats = buildScript(commits, units);
  assert.deepEqual(progress(beats, 4), [
    { commit: 0, weight: 1, filled: 1 },
    { commit: 1, weight: 2, filled: 0.25 },
  ]);
  assert.deepEqual(
    progress(beats, beats.length).map((s) => s.filled),
    [1, 1],
  );
  assert.deepEqual(
    [chunkOf(beats, 1), chunkOf(beats, 4), chunkOf(beats, 5), chunkOf(beats, 3)],
    [{ index: 1, count: 1 }, { index: 1, count: 2 }, { index: 2, count: 2 }, null],
  );
});

test("a plan has narration when any commit or unit carries a non-blank one", () => {
  assert.equal(hasNarration(commits), true);
  assert.equal(
    hasNarration([
      { index: 0, message: "m", narration: " ", refs: [] },
      { index: 1, message: "n", refs: [{ unit: "f_c", select: { kind: "rest" }, narration: "" }] },
    ]),
    false,
  );
});

test("speed snaps to the four offered steps", () => {
  assert.deepEqual(
    [parseSpeed("1.5"), parseSpeed("0.75"), parseSpeed("1.25"), parseSpeed(null)],
    [1.5, 0.75, 1, 1],
  );
});

test("the preselected voice is the saved one, else the default in the reader's language", () => {
  const voices = [
    { name: "Thomas", lang: "fr-FR", default: true },
    { name: "Daniel", lang: "en-GB", default: false },
    { name: "Samantha", lang: "en-US", default: false },
  ];
  assert.equal(pickVoice(voices, "Daniel", "en-US"), "Daniel");
  assert.equal(pickVoice(voices, "Gone", "en-US"), "Samantha");
  assert.equal(pickVoice(voices, null, "fr-CA"), "Thomas");
  assert.equal(pickVoice(voices, null, "de-DE"), null);
});

test("describeRows names context rows by their tip line and removed rows by the old one", () => {
  const body: HunkLine[] = [
    { op: " ", text: "a\n" },
    { op: "-", text: "b\n", change: 0 },
    { op: "+", text: "c\n", change: 1 },
    { op: " ", text: "d\n" },
  ];
  const numbers = lineNumbers([{ kind: "hunk", id: "h_x", path: "a.ts", oldStart: 9, body }]).get(
    "h_x",
  );
  assert.ok(numbers);
  assert.deepEqual(
    [
      describeRows(body, numbers, [0]),
      describeRows(body, numbers, [3, 0]),
      describeRows(body, numbers, [0, 1, 2, 3]),
      describeRows(body, numbers, [1]),
    ],
    ["line 10", "lines 10, 12", "lines 10-12, old 11", "old line 11"],
  );
});
