import assert from "node:assert/strict";
import { test } from "node:test";
import type { Commit, Step, Unit } from "../ui/playback.js";
import {
  buildScript,
  commitAt,
  commitNarration,
  commitStart,
  lineStates,
  parseSpeed,
  pickVoice,
  stepDelay,
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
  { kind: "file", id: "f_cccccccccccc", path: "logo.png" },
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

test("the script speaks each commit, then each unit, then types that commit's own lines", () => {
  assert.deepEqual(buildScript(commits, units), [
    { kind: "commit", commit: 0, say: "Rename the first line" },
    { kind: "unit", commit: 0, unit: "h_aaaaaaaaaaaa", say: null },
    { kind: "line", commit: 0, unit: "h_aaaaaaaaaaaa", line: 0, change: 0, op: "-" },
    { kind: "line", commit: 0, unit: "h_aaaaaaaaaaaa", line: 1, change: 1, op: "+" },
    { kind: "commit", commit: 1, say: "Now the second line." },
    { kind: "unit", commit: 1, unit: "h_aaaaaaaaaaaa", say: "This one is subtle." },
    { kind: "line", commit: 1, unit: "h_aaaaaaaaaaaa", line: 3, change: 2, op: "-" },
    { kind: "line", commit: 1, unit: "h_aaaaaaaaaaaa", line: 4, change: 3, op: "+" },
    { kind: "unit", commit: 1, unit: "f_cccccccccccc", say: null },
  ]);
});

test("narration falls back to the commit title when it is missing or blank", () => {
  assert.equal(commitNarration({ index: 0, message: "Add x\n\nwhy", refs: [] }), "Add x");
  assert.equal(commitNarration({ index: 0, message: "Add x", narration: " ", refs: [] }), "Add x");
  assert.equal(
    commitNarration({ index: 0, message: "Add x", narration: "I add x.", refs: [] }),
    "I add x.",
  );
});

test("line states follow the position: added lines appear, removed lines go", () => {
  const script = buildScript(commits, units);
  const at = (position: number, commit: number) => {
    const { states, current } = lineStates(script, position, commit);
    return { states: Object.fromEntries(states), current };
  };
  assert.deepEqual(at(commitStart(script, 1), 1), {
    states: { "h_aaaaaaaaaaaa:3": "shown", "h_aaaaaaaaaaaa:4": "hidden" },
    current: null,
  });
  assert.deepEqual(at(7, 1), {
    states: { "h_aaaaaaaaaaaa:3": "gone", "h_aaaaaaaaaaaa:4": "hidden" },
    current: "h_aaaaaaaaaaaa:3",
  });
  assert.deepEqual(at(9, 1), {
    states: { "h_aaaaaaaaaaaa:3": "gone", "h_aaaaaaaaaaaa:4": "shown" },
    current: "h_aaaaaaaaaaaa:4",
  });
  assert.deepEqual(at(9, 0), {
    states: { "h_aaaaaaaaaaaa:0": "gone", "h_aaaaaaaaaaaa:1": "shown" },
    current: null,
  });
});

test("seeking lands on a commit's first step and reports the commit on screen", () => {
  const script = buildScript(commits, units);
  assert.deepEqual(
    [
      commitStart(script, 0),
      commitStart(script, 1),
      commitStart(script, 2),
      commitStart(script, -1),
    ],
    [0, 4, 9, 0],
  );
  assert.deepEqual(
    [commitAt(script, 0), commitAt(script, 4), commitAt(script, 5), commitAt(script, 99)],
    [0, 0, 1, 1],
  );
});

test("speed scales the typing rate and snaps to the offered steps", () => {
  const add: Step = {
    kind: "line",
    commit: 0,
    unit: "h_x",
    line: 0,
    change: 0,
    op: "+",
  };
  assert.deepEqual(
    [stepDelay(add, 1), stepDelay(add, 2), stepDelay(add, 0.5), stepDelay({ ...add, op: "-" }, 1)],
    [250, 125, 500, 125],
  );
  assert.deepEqual([parseSpeed("1.5"), parseSpeed("7"), parseSpeed(null)], [1.5, 1, 1]);
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
