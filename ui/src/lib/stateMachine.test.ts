import { expect, test } from "vitest";
import { aCoverage, aState, HUNK } from "../test/factories.ts";
import type { Loc } from "./coverage.ts";
import { lineNumbers, ownership } from "./rows.ts";
import {
  candidatesOf,
  describeEdgeMark,
  describeStateMark,
  type EdgeMark,
  edgesOfMap,
  endsOf,
  markOfEdge,
  markOfPlaces,
  notDriven,
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

test("an edge is taken by the tests that ran every one of its lines", () => {
  const run = aCoverage({
    tests: {
      both: { lines: { "src/lib.js": [1, 3, 4] } },
      half: { lines: { "src/lib.js": [3] } },
    },
  });
  expect(markOfEdge(run, [lib(3, 4)])).toEqual({
    kind: "covered",
    run: 2,
    total: 2,
    tests: ["both"],
  });
  // Line 2 is not executable, so it asks nothing of a test.
  expect(markOfEdge(run, [lib(2, 3)]).tests).toEqual(["both", "half"]);
  expect(markOfEdge(run, [lib(5)])).toMatchObject({ kind: "uncovered", tests: [] });
  expect(markOfEdge(run, [lib(6)])).toMatchObject({ kind: "uncovered", run: 1, total: 1 });
  expect(describeEdgeMark(markOfEdge(run, [lib(3)]), true)).toBe("taken by 2 tests");
  expect(describeEdgeMark(markOfEdge(run, [lib(5)]), true)).toBe("no test takes it");
});

test("without per-test runs an edge is covered when its lines ran; with no lines it is unknown", () => {
  const run = aCoverage();
  expect(markOfEdge(run, [lib(3, 4)])).toEqual({ kind: "covered", run: 2, total: 2, tests: [] });
  expect(markOfEdge(run, [lib(4, 5)]).kind).toBe("uncovered");
  expect(markOfEdge(run, []).kind).toBe("unknown");
  expect(markOfEdge(null, [lib(3)]).kind).toBe("unknown");
  expect(markOfEdge(aCoverage({ stale: ["src/lib.js"] }), [lib(3)]).kind).toBe("unknown");
  expect(describeEdgeMark(markOfEdge(run, [lib(3)]), false)).toBe("covered");
});

test("moves no test takes head the table's moves", () => {
  const map: StateMap = JSON.parse(
    JSON.stringify({
      states: { A: [lib(1)], B: [lib(3)] },
      transitions: [
        { from: "A", to: "B", at: [lib(3)] },
        { from: "B", to: "A", at: [lib(5)] },
      ],
    }),
  );
  const marks = map.transitions?.map((t) => markOfEdge(aCoverage(), t.at));
  expect(rowsOfMap(map, marks).map((r) => r.key)).toEqual(["s:A", "s:B", "t:1", "t:0"]);
});

test("a transition finds its drawn edge by its states, then by its label", () => {
  const drawn = [
    { id: "e0", from: null, to: "Idle", label: "" },
    { id: "e1", from: "Idle", to: "Busy", label: "go" },
    { id: "e2", from: "Busy", to: "Idle", label: "done" },
    { id: "e3", from: "Busy", to: "Idle", label: "fail" },
    { id: "e4", from: null, to: null, label: "retry" },
  ];
  const found = edgesOfMap(
    [
      { from: "Busy", to: "Idle", event: "fail" },
      { from: "Busy", to: "Idle", event: "done" },
      { from: "Idle", to: "Busy" },
      { from: "Failed", to: "Busy", event: "retry" },
      { from: "Idle", to: "Gone" },
    ],
    drawn,
  );
  expect([...found]).toEqual([
    [0, "e3"],
    [1, "e2"],
    [2, "e1"],
    [3, "e4"],
  ]);
});

test("the diagram's [*] arrows give the initial and final states", () => {
  const source = "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: go\n  Done --> [*]\n";
  expect(endsOf(source)).toEqual({ initial: ["Idle"], final: ["Done"] });
});

test("a sequence each step of which has a test, but no test takes whole, is not driven", () => {
  const source = "stateDiagram-v2\n[*] --> Idle\nFailed --> [*]\n";
  const map: StateMap = JSON.parse(
    JSON.stringify({
      states: { Idle: [lib(1)], Busy: [lib(3)], Done: [lib(4)], Failed: [lib(5)] },
      transitions: [
        { from: "Idle", to: "Busy", at: [lib(1)] },
        { from: "Busy", to: "Done", at: [lib(3)] },
        { from: "Busy", to: "Failed", at: [lib(4)] },
        { from: "Failed", to: "Busy", at: [lib(6)] },
        { from: "Busy", to: "Idle", at: [lib(5)] },
      ],
    }),
  );
  const tests = (...ids: string[]): EdgeMark => ({ kind: "covered", run: 1, total: 1, tests: ids });
  const untested: EdgeMark = { kind: "uncovered", run: 0, total: 1, tests: [] };
  const marks = [tests("a", "b"), tests("b"), tests("c"), tests("d"), untested];
  const found = notDriven(map, source, marks).map((s) => s.states.join(" → "));
  // Idle → Busy → Done is driven by b; anything through Busy → Idle has an untested step.
  expect(found).toEqual(["Idle → Busy → Failed", "Idle → Busy → Failed → Busy → Done"]);
  expect(notDriven(map, source, marks)[0]?.moves).toEqual([0, 2]);
  // Without per-test runs nothing names a test, so nothing is listed.
  expect(
    notDriven(
      map,
      source,
      marks.map((m) => ({ ...m, tests: [] })),
    ),
  ).toEqual([]);
});

test("a self-loop mapped to the line only its path runs names the test that loops", () => {
  // Line 4 is the guard every test runs; line 6 is the retry's return; line 3 the paid assignment.
  const run = aCoverage({
    tests: {
      pays: { lines: { "src/lib.js": [1, 3, 4] } },
      retries: { lines: { "src/lib.js": [1, 4, 6] } },
    },
  });
  const source = "stateDiagram-v2\n[*] --> Pay\nPay --> Pay: decline\nPaid --> [*]\n";
  const mapWith = (loop: Loc[]): StateMap =>
    JSON.parse(
      JSON.stringify({
        states: { Pay: [lib(1)], Paid: [lib(3)] },
        transitions: [
          { from: "Pay", to: "Paid", at: [lib(3)] },
          { from: "Pay", to: "Pay", event: "decline", at: loop },
        ],
      }),
    );
  const marksOf = (map: StateMap) => (map.transitions ?? []).map((t) => markOfEdge(run, t.at));
  const atReturn = mapWith([lib(6)]);
  expect(marksOf(atReturn)[1]?.tests).toEqual(["retries"]);
  expect(notDriven(atReturn, source, marksOf(atReturn)).map((s) => s.states.join(" → "))).toEqual([
    "Pay → Pay → Paid",
  ]);
  // Mapped to the guard, the loop claims every test, and the gap disappears.
  const atGuard = mapWith([lib(4)]);
  expect(marksOf(atGuard)[1]?.tests).toEqual(["pays", "retries"]);
  expect(notDriven(atGuard, source, marksOf(atGuard))).toEqual([]);
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
