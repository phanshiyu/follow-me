import { expect, test } from "vitest";
import { aHunk } from "../test/factories.ts";
import {
  anchorFor,
  concernRow,
  lastShown,
  pickRow,
  rowsBetween,
  rowsOfAnchor,
  selectionRange,
  snapshotRows,
  stepRow,
} from "./selection.ts";

const visible = [0, 1, 2, 5, 6];

test("a range takes the shown rows between its ends, in either direction, skipping folds", () => {
  expect(selectionRange(visible, 1, 5)).toEqual([1, 2, 5]);
  expect(selectionRange(visible, 5, 1)).toEqual([1, 2, 5]);
});

test("a click picks one row, again clears it, and shift extends from where the range began", () => {
  const one = pickRow(visible, null, 2, false);
  expect(one).toEqual({ from: 2, lines: [2] });
  expect(pickRow(visible, one, 2, false)).toBeNull();
  expect(pickRow(visible, one, 6, true)).toEqual({ from: 2, lines: [2, 5, 6] });
  expect(pickRow(visible, { from: 2, lines: [2, 5, 6] }, 0, true)).toEqual({
    from: 2,
    lines: [0, 1, 2],
  });
});

test("arrows step over hidden rows and stop at the ends", () => {
  expect(stepRow(visible, 2, 1)).toBe(5);
  expect(stepRow(visible, 6, 1)).toBe(6);
  expect(stepRow(visible, 0, -1)).toBe(0);
  expect(stepRow(visible, 3, 1)).toBe(0);
});

test("a pick becomes offsets of every row and changes of only the commit's own lines", () => {
  const hunk = aHunk();
  const owners = [0, 0, 1, 1];
  expect(anchorFor({ id: hunk.id, commit: 1, body: hunk.body, owners }, [5, 3, 2, 3])).toEqual({
    kind: "hunk",
    unit: hunk.id,
    commit: 1,
    changes: [2],
    offsets: [2, 3, 5],
  });
  expect(anchorFor({ id: hunk.id, commit: 1, body: hunk.body, owners }, [0, 2])).toMatchObject({
    changes: [],
    offsets: [0, 2],
  });
  expect(snapshotRows(hunk.body, [3, 2])).toEqual([
    "export function add(a, b) {",
    "  assertNumber(a);",
  ]);
});

test("an anchor names its rows by offsets, or by change indices for older comments", () => {
  const { body } = aHunk();
  expect(rowsOfAnchor({ changes: [2], offsets: [2, 3, 99] }, body)).toEqual([2, 3]);
  expect(rowsOfAnchor({ changes: [2, 3] }, body)).toEqual([3, 4]);
  expect(rowsOfAnchor({ changes: null }, body)).toEqual([]);
  expect(lastShown([2, 3, 4], new Set([2, 3]))).toBe(3);
  expect(lastShown([4], new Set([2]))).toBeNull();
});

test("a text selection picks the rows between its ends, and only inside rows", () => {
  expect(rowsBetween(visible, 5, 1)).toEqual({ from: 5, lines: [1, 2, 5] });
  expect(rowsBetween(visible, null, 1)).toBeNull();
});

test("a concern sits under its last pinned own line, else under the commit's last own line", () => {
  const { body } = aHunk();
  expect(concernRow([2, 3], body, [3, 4])).toBe(4);
  expect(concernRow([0], body, [3, 4])).toBe(4);
  expect(concernRow(undefined, body, [])).toBeNull();
});
