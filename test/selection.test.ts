import assert from "node:assert/strict";
import { test } from "node:test";
import type { BodyRow, Hunk } from "../ui/selection.js";
import {
  anchorFor,
  lastShown,
  pickRow,
  rowsOfAnchor,
  selectionRange,
  snapshotRows,
  stepRow,
} from "../ui/selection.js";

// 0 context, 1 removed (change 0, commit 3), 2 added (change 1, commit 3), 3 context,
// 4 added (change 2, commit 1: an earlier commit), 5 added (change 3, commit 4: a later one)
const body: BodyRow[] = [
  { op: " ", text: "function div(a, b) {\n" },
  { op: "-", text: "  return a / b;\n", change: 0 },
  { op: "+", text: "  if (b === 0) throw new RangeError('zero');\n", change: 1 },
  { op: " ", text: "  return a / b;\n" },
  { op: "+", text: "  // earlier\n", change: 2 },
  { op: "+", text: "  // later\n", change: 3 },
];
const hunk: Hunk = { id: "h_aaaaaaaaaaaa", commit: 3, body, owners: [3, 3, 1, 4] };

test("a range covers every shown row between its ends, whichever end comes first", () => {
  const visible = [0, 1, 2, 3, 4];
  assert.deepEqual(selectionRange(visible, 1, 3), [1, 2, 3]);
  assert.deepEqual(selectionRange(visible, 3, 1), [1, 2, 3]);
  assert.deepEqual(selectionRange(visible, 2, 2), [2]);
});

test("a range across a fold skips the folded rows", () => {
  assert.deepEqual(selectionRange([0, 1, 3, 4], 1, 4), [1, 3, 4]);
});

test("a click picks one row, and the same row again clears it", () => {
  const visible = [0, 1, 2, 3];
  const one = pickRow(visible, null, 2, { extend: false });
  assert.deepEqual(one, { from: 2, lines: [2] });
  assert.deepEqual(pickRow(visible, one, 0, { extend: false }), { from: 0, lines: [0] });
  assert.equal(pickRow(visible, one, 2, { extend: false }), null);
});

test("shift extends from the row the range started at, and can shrink back", () => {
  const visible = [0, 1, 2, 3, 4];
  const start = pickRow(visible, null, 2, { extend: false });
  const wide = pickRow(visible, start, 4, { extend: true });
  assert.deepEqual(wide, { from: 2, lines: [2, 3, 4] });
  assert.deepEqual(pickRow(visible, wide, 0, { extend: true }), { from: 2, lines: [0, 1, 2] });
  assert.deepEqual(pickRow(visible, wide, 3, { extend: true }), { from: 2, lines: [2, 3] });
});

test("shift with nothing picked starts a pick at that row", () => {
  assert.deepEqual(pickRow([0, 1, 2], null, 1, { extend: true }), { from: 1, lines: [1] });
});

test("arrows step to the next shown row and stop at the ends", () => {
  const visible = [0, 1, 3, 4];
  assert.equal(stepRow(visible, 1, 1), 3);
  assert.equal(stepRow(visible, 3, -1), 1);
  assert.equal(stepRow(visible, 4, 1), 4);
  assert.equal(stepRow(visible, 0, -1), 0);
  assert.equal(stepRow(visible, 2, 1), 0);
});

test("anchorFor lists every picked row and the change indices this commit owns among them", () => {
  assert.deepEqual(anchorFor(hunk, [2, 1, 3]), {
    kind: "hunk",
    unit: "h_aaaaaaaaaaaa",
    commit: 3,
    changes: [0, 1],
    offsets: [1, 2, 3],
  });
});

test("a pick of context alone has offsets and no changes", () => {
  const anchor = anchorFor(hunk, [3, 0]);
  assert.deepEqual(anchor.changes, []);
  assert.deepEqual(anchor.offsets, [0, 3]);
});

test("rows other commits own are offsets but never changes", () => {
  const anchor = anchorFor(hunk, [4, 5]);
  assert.deepEqual(anchor.changes, []);
  assert.deepEqual(anchor.offsets, [4, 5]);
});

test("a repeated row counts once", () => {
  assert.deepEqual(anchorFor(hunk, [2, 2]).offsets, [2]);
});

test("snapshotRows quotes the picked rows in hunk order without line ends", () => {
  assert.deepEqual(snapshotRows(body, [3, 2]), [
    "  if (b === 0) throw new RangeError('zero');",
    "  return a / b;",
  ]);
});

test("rowsOfAnchor prefers offsets, falls back to changes, and is empty for a whole hunk", () => {
  assert.deepEqual(rowsOfAnchor({ changes: [0], offsets: [0, 3] }, body), [0, 3]);
  assert.deepEqual(rowsOfAnchor({ changes: [1, 0] }, body), [1, 2]);
  assert.deepEqual(rowsOfAnchor({ changes: null }, body), []);
  assert.deepEqual(rowsOfAnchor({ changes: [], offsets: [2, 40] }, body), [2]);
});

test("a comment sits under its last shown row", () => {
  assert.equal(lastShown([1, 2, 3], new Set([1, 2, 3])), 3);
  assert.equal(lastShown([1, 2, 3], new Set([1, 2])), 2);
  assert.equal(lastShown([1, 2], new Set([5])), null);
  assert.equal(lastShown([], new Set([1])), null);
});
