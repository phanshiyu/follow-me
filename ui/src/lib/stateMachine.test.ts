import { expect, test } from "vitest";
import { aCoverage, aState, HUNK } from "../test/factories.ts";
import type { Loc } from "./coverage.ts";
import { lineNumbers, ownership } from "./rows.ts";
import {
  candidatesOf,
  describeStateMark,
  markOfPlaces,
  placeLabel,
  rowsOfMap,
  stateNodes,
} from "./stateMachine.ts";
import type { StateMap } from "./wire.ts";

const lib = (start: number, end = start): Loc =>
  JSON.parse(JSON.stringify({ path: "src/lib.js", start, end }));

test("a state is covered only when the run hit every executable mapped line in full", () => {
  const run = aCoverage();
  expect(markOfPlaces(run, [lib(1), lib(6)])).toMatchObject({ kind: "covered", run: 2, total: 2 });
  // Line 2 is blank, so not executable, and does not count against the state.
  expect(markOfPlaces(run, [lib(1, 3)])).toMatchObject({ kind: "covered", run: 2, total: 2 });
});

test("some lines hit, or a branch only partly taken, is partly covered", () => {
  const run = aCoverage();
  expect(markOfPlaces(run, [lib(5, 6)])).toMatchObject({ kind: "partly", run: 1, total: 2 });
  expect(markOfPlaces(run, [lib(4)])).toMatchObject({ kind: "partly", run: 1, total: 1 });
});

test("no mapped line hit is not covered", () => {
  expect(markOfPlaces(aCoverage(), [lib(5)])).toMatchObject({ kind: "uncovered", run: 0 });
});

test("no run, nothing executable, or a file changed since the run is unknown", () => {
  expect(markOfPlaces(null, [lib(1)]).kind).toBe("unknown");
  expect(markOfPlaces(aCoverage(), [lib(2)]).kind).toBe("unknown");
  expect(markOfPlaces(aCoverage(), []).kind).toBe("unknown");
  expect(markOfPlaces(aCoverage({ stale: ["src/lib.js"] }), [lib(1)]).kind).toBe("unknown");
  const elsewhere: Loc = JSON.parse('{"path":"src/other.js","start":1,"end":9}');
  expect(markOfPlaces(aCoverage(), [elsewhere]).kind).toBe("unknown");
});

test("the tests that reached a state are those that ran a mapped line it hit", () => {
  const run = aCoverage({
    tests: {
      "adds numbers": { lines: { "src/lib.js": [1, 6] } },
      "rejects strings": { lines: { "src/lib.js": [4] } },
      "never here": { lines: { "src/other.js": [1] } },
    },
  });
  expect(markOfPlaces(run, [lib(4, 6)]).tests).toEqual(["adds numbers", "rejects strings"]);
});

test("the table lists states, then moves with their events", () => {
  const map: StateMap = JSON.parse(
    JSON.stringify({
      states: { Idle: [lib(1)], Uploading: [lib(3, 5)] },
      transitions: [{ from: "Idle", to: "Uploading", event: "pick", at: [lib(4)] }],
    }),
  );
  expect(rowsOfMap(map).map((r) => [r.kind, r.name, r.event])).toEqual([
    ["state", "Idle", null],
    ["state", "Uploading", null],
    ["move", "Idle → Uploading", "pick"],
  ]);
  expect(placeLabel(lib(3, 5))).toBe("src/lib.js:3-5");
  expect(placeLabel(lib(4))).toBe("src/lib.js:4");
});

test("each mapped place jumps to the commit that shows it, or peeks when none does", () => {
  const state = aState();
  const units = new Map(state.units.map((u) => [u.id, u]));
  const owners = ownership(state.commits);
  const numbers = lineNumbers(state.units);
  const elsewhere: Loc = JSON.parse('{"path":"src/other.js","start":7,"end":9}');
  const found = candidatesOf(
    [lib(4, 5), lib(1), lib(4), elsewhere],
    state.commits,
    units,
    owners,
    numbers,
  );
  expect(found.map((c) => [c.path, c.newLine, c.commit, c.unit, c.row])).toEqual([
    ["src/lib.js", 4, 1, HUNK, 3],
    ["src/lib.js", 1, 0, HUNK, 0],
    ["src/other.js", 7, null, null, null],
  ]);
});

test("Mermaid's node for a state is found by its id, or by its label", () => {
  const nodes = [
    { id: "d-1-state-root_start-0", text: "" },
    { id: "d-1-state-Idle-1", text: "Idle" },
    { id: "d-1-state-Idle_2-3", text: "Idle again" },
    { id: "d-1-state-RetryWait-5", text: "Retry wait" },
    { id: "d-1-edge0", text: "" },
  ];
  const found = stateNodes("d-1", nodes, ["Idle", "Retry wait", "RetryWait", "Gone"]);
  expect([...found]).toEqual([
    ["Idle", "d-1-state-Idle-1"],
    ["Retry wait", "d-1-state-RetryWait-5"],
    ["RetryWait", "d-1-state-RetryWait-5"],
  ]);
});

test("a mark reads as words with its line count", () => {
  expect(describeStateMark({ kind: "partly", run: 3, total: 5, tests: [] })).toBe(
    "partly covered, 3 of 5 lines",
  );
  expect(describeStateMark({ kind: "covered", run: 1, total: 1, tests: [] })).toBe(
    "covered, 1 of 1 line",
  );
  expect(describeStateMark({ kind: "unknown", run: 0, total: 0, tests: [] })).toBe(
    "coverage unknown",
  );
});
