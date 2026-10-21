import assert from "node:assert/strict";
import { test } from "node:test";
import type { Concern, Decision } from "../ui/concerns.js";
import {
  allConcerns,
  anchorLine,
  blockersToHold,
  bodyIndexes,
  concernsInChunk,
  dwellExtra,
  pickConcern,
  severityOf,
  stateOf,
  toDecide,
  topSeverity,
  undecided,
  undecidedPrompt,
} from "../ui/concerns.js";
import { readMs } from "../ui/playback.js";

const body = [
  { op: " " },
  { op: "-", change: 0 },
  { op: "+", change: 1 },
  { op: " " },
  { op: "+", change: 2 },
  { op: "+", change: 3 },
];
const pinned: Concern = {
  id: "k_1",
  unit: "h_1",
  severity: "blocker",
  kind: "bug",
  text: "a b c",
  lines: [2],
};
const loose: Concern = { id: "k_2", unit: "h_1", severity: "minor", kind: "naming", text: "d e" };
const other: Concern = { id: "k_3", unit: "h_2", severity: "major", kind: "risk", text: "f" };
const decided = (
  concern: string,
  decision: Decision["decision"],
  severity?: Decision["severity"],
) =>
  ({ [concern]: { concern, decision, ...(severity ? { severity } : {}) } }) satisfies Record<
    string,
    Decision
  >;

test("a decision's severity overrides the agent's, and state reads the decision", () => {
  assert.equal(severityOf(pinned, {}), "blocker");
  assert.equal(severityOf(pinned, decided("k_1", "kept", "minor")), "minor");
  assert.equal(severityOf(pinned, decided("k_1", "dismissed")), "blocker");
  assert.deepEqual(
    [{}, decided("k_1", "kept"), decided("k_1", "dismissed")].map((d) => stateOf(pinned, d)),
    ["undecided", "kept", "dismissed"],
  );
});

test("allConcerns, undecided and topSeverity", () => {
  const all = allConcerns([
    { index: 0, concerns: [pinned, loose] },
    { index: 1 },
    { index: 2, concerns: [other] },
  ]);
  assert.deepEqual(
    all.map((c) => c.id),
    ["k_1", "k_2", "k_3"],
  );
  const d = decided("k_1", "kept");
  assert.deepEqual(
    undecided(all, d).map((c) => c.id),
    ["k_2", "k_3"],
  );
  assert.equal(topSeverity(all, {}), "blocker");
  assert.equal(topSeverity(undecided(all, d), d), "major");
  assert.equal(topSeverity([], {}), null);
  assert.equal(topSeverity([pinned], decided("k_1", "kept", "minor")), "minor");
});

test("bodyIndexes maps change indices to hunk body lines", () => {
  assert.deepEqual(bodyIndexes(body, [1, 3]), [2, 5]);
  assert.deepEqual(bodyIndexes(body, [9]), []);
});

test("anchorLine sits under the last pinned line the commit shows, else its last line", () => {
  const own = [1, 2, 4, 5];
  assert.equal(anchorLine(pinned, body, own), 4);
  assert.equal(anchorLine(loose, body, own), 5);
  assert.equal(anchorLine({ ...pinned, lines: [2, 3] }, body, own), 5);
  assert.equal(anchorLine(pinned, body, [1, 2]), 2, "pinned lines the commit does not show");
  assert.equal(anchorLine(loose, body, []), null);
});

const beats = [
  { kind: "intro", commit: 0 },
  { kind: "chunk", commit: 0, unit: "h_1", lines: [1, 2] },
  { kind: "chunk", commit: 0, unit: "h_1", lines: [4, 5] },
  { kind: "chunk", commit: 0, unit: "h_2", lines: [0] },
];

test("concernsInChunk gives pinned concerns to the chunk with their lines and loose ones to the first", () => {
  const list = [pinned, loose, other];
  const ids = (i: number) => concernsInChunk(list, beats, i, body).map((c) => c.id);
  assert.deepEqual([0, 1, 2, 3].map(ids), [[], ["k_2"], ["k_1"], ["k_3"]]);
  assert.deepEqual(
    concernsInChunk([{ ...pinned, lines: [3] }], beats, 2, body).map((c) => c.id),
    ["k_1"],
  );
});

test("pickConcern prefers the chunk, then the commit, and skips decided ones", () => {
  const d = decided("k_1", "kept");
  assert.equal(pickConcern([pinned, loose], [pinned], {})?.id, "k_1");
  assert.equal(pickConcern([pinned, loose], [pinned], d)?.id, "k_2");
  assert.equal(pickConcern([pinned], [], {})?.id, "k_1");
  assert.equal(pickConcern([pinned], [], d), null);
});

test("blockers hold once, at the step that shows their chunk", () => {
  const show = { kind: "show" };
  const ids = (step: { kind: string } | undefined, seen: string[] = [], d = {}) =>
    blockersToHold([pinned, loose], step, d, new Set(seen)).map((c) => c.id);
  assert.deepEqual(ids(show), ["k_1"]);
  assert.deepEqual(ids({ kind: "say" }), []);
  assert.deepEqual(ids(undefined), []);
  assert.deepEqual(ids(show, ["k_1"]), []);
  assert.deepEqual(ids(show, [], decided("k_1", "dismissed")), []);
  assert.deepEqual(
    ids(show, [], decided("k_1", "kept", "major")),
    [],
    "downgraded is not a blocker",
  );
});

test("dwellExtra adds reading time for undecided non-blockers, scaled by speed", () => {
  assert.equal(dwellExtra([pinned, loose], {}, 1), readMs("d e"));
  assert.equal(dwellExtra([pinned, loose], {}, 2), Math.round(readMs("d e") / 2));
  assert.equal(dwellExtra([loose], decided("k_2", "kept"), 1), 0);
  assert.equal(dwellExtra([], {}, 1), 0);
});

test("the end prompt and the stage reminder count concerns", () => {
  assert.match(undecidedPrompt(1), /^1 agent concern undecided/);
  assert.match(undecidedPrompt(3), /^3 agent concerns undecided/);
  assert.equal(toDecide(0), null);
  assert.equal(toDecide(2), "2 agent concerns to decide");
});
