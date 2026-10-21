import { expect, test } from "vitest";
import { aCommit, aHunk, aState } from "../test/factories.ts";
import {
  commitStats,
  describeRows,
  lineNumbers,
  ownership,
  ownersOf,
  rowsOf,
  scopeOf,
} from "./rows.ts";
import type { Unit, UnitId } from "./wire.ts";

test("a commit's own rows are the change, earlier ones context, later additions fold", () => {
  const hunk = aHunk();
  const owners = ownersOf(hunk, ownership(aState().commits));
  expect(rowsOf(hunk.body, owners, 0)).toEqual([
    { kind: "line", line: 0, mine: true },
    { kind: "line", line: 1, mine: true },
    { kind: "line", line: 2, mine: false },
    { kind: "fold", lines: [3, 4], commit: 1 },
    { kind: "line", line: 5, mine: false },
    { kind: "line", line: 6, mine: false },
  ]);
  expect(rowsOf(hunk.body, owners, 1).filter((r) => r.kind === "line" && r.mine)).toEqual([
    { kind: "line", line: 3, mine: true },
    { kind: "line", line: 4, mine: true },
  ]);
});

test("a line a later commit removes is still context, one an earlier commit removed is gone", () => {
  const body = [
    { op: "-" as const, text: "old\n", change: 0 },
    { op: "+" as const, text: "new\n", change: 1 },
  ];
  expect(rowsOf(body, [1, 0], 0)).toEqual([
    { kind: "line", line: 0, mine: false },
    { kind: "line", line: 1, mine: true },
  ]);
  expect(rowsOf(body, [0, 1], 1)).toEqual([{ kind: "line", line: 1, mine: true }]);
});

test("tip numbers shift by what earlier hunks of the same file add or remove", () => {
  const first = aHunk();
  const second = aHunk({
    id: JSON.parse('"h_000000000002"'),
    oldStart: 10,
    body: [
      { op: " ", text: "x\n" },
      { op: "-", text: "y\n", change: 0 },
      { op: "+", text: "z\n", change: 1 },
    ],
    changeCount: 2,
  });
  const units: Unit[] = [second, first];
  const numbers = lineNumbers(units);
  expect(numbers.get(first.id)?.slice(0, 3)).toEqual([
    { old: null, new: 1 },
    { old: null, new: 2 },
    { old: 1, new: 3 },
  ]);
  expect(numbers.get(second.id)).toEqual([
    { old: 11, new: 15 },
    { old: 12, new: null },
    { old: null, new: 16 },
  ]);
});

test("rows are named by tip number, removals by base number, runs collapsed", () => {
  const body = [
    { op: " " as const, text: "a\n" },
    { op: "+" as const, text: "b\n", change: 0 },
    { op: "-" as const, text: "c\n", change: 1 },
  ];
  const numbers = [
    { old: 4, new: 4 },
    { old: null, new: 5 },
    { old: 5, new: null },
  ];
  expect(describeRows(body, numbers, [0])).toBe("line 4");
  expect(describeRows(body, numbers, [1, 0])).toBe("lines 4-5");
  expect(describeRows(body, numbers, [0, 1, 2])).toBe("lines 4-5, old 5");
  expect(describeRows(body, numbers, [2])).toBe("old line 5");
});

test("scopeOf finds the declaration a row sits in", () => {
  expect(scopeOf(aHunk().body, 4)).toBe("add");
  expect(scopeOf(aHunk().body, 0)).toBeNull();
});

test("commitStats counts only the commit's own lines", () => {
  const state = aState();
  const units = new Map<UnitId, Unit>(state.units.map((u) => [u.id, u]));
  const owners = ownership(state.commits);
  expect(commitStats(aCommit(0, state.commits[0]), units, owners)).toEqual({
    added: 2,
    removed: 0,
  });
  expect(commitStats(aCommit(1, state.commits[1]), units, owners)).toEqual({
    added: 2,
    removed: 0,
  });
});
