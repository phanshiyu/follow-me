import { expect, test } from "vitest";
import { aCommit, aHunk, aRef, aState, HUNK } from "../test/factories.ts";
import { captionsOf } from "./markdown.ts";
import {
  landing,
  type PlacedRef,
  placeRef,
  refLabel,
  refNumberOf,
  refPlace,
  refWhere,
} from "./refs.ts";
import { lineNumbers, ownership } from "./rows.ts";
import type { CodeRef } from "./wire.ts";

const state = aState();
const units = new Map(state.units.map((u) => [u.id, u]));
const owners = ownership(state.commits);
const numbers = lineNumbers(state.units);
const place = (ref: CodeRef): PlacedRef =>
  placeRef(ref, state.anchor.tip, state.commits, units, owners, numbers);

test("a ref lands on the rows of the commit that writes its lines", () => {
  const guards = place(aRef());
  expect(guards).toMatchObject({
    kind: "on",
    commit: 1,
    targets: [
      { commit: 1, unit: HUNK, row: 3 },
      { commit: 1, unit: HUNK, row: 4 },
    ],
  });
  expect(landing(guards)).toEqual({ commit: 1, unit: HUNK, row: 3 });
  expect(refWhere(guards, 1)).toBeNull();
  expect(refWhere(place(aRef({ start: 1 })), 1)).toBe("commit 1");
});

test("a range over lines of two commits reads where the later one shows them all", () => {
  // Line 3 is context the first commit already shows; line 4 is the second commit's guard.
  expect(place(aRef({ start: 3, end: 4 }))).toMatchObject({
    kind: "on",
    commit: 1,
    targets: [
      { commit: 1, row: 2 },
      { commit: 1, row: 3 },
    ],
  });
});

test("code outside every hunk, a moved tip, and base lines the branch removes", () => {
  const outside = place(aRef({ path: "src/other.js" }));
  expect(outside.kind).toBe("off");
  expect(landing(outside)).toBeNull();
  expect(refWhere(outside, 0)).toBeNull();
  const stale = place(aRef({ tip: JSON.parse(`"${"9".repeat(40)}"`) }));
  expect(stale.kind).toBe("stale");
  expect(refWhere(stale, 1)).toBe("from 9999999");
});

test("base lines the branch removes land on the removed row, in the commit that removes it", () => {
  const hunk = aHunk({
    body: [
      { op: " ", text: "export function div(a, b) {\n" },
      { op: "-", text: "  return a / b;\n", change: 0 },
      { op: "+", text: "  return b === 0 ? NaN : a / b;\n", change: 1 },
    ],
    changeCount: 2,
  });
  const commits = [
    aCommit(0),
    aCommit(1, { refs: [{ unit: hunk.id, select: { kind: "lines", changes: [0, 1] } }] }),
  ];
  const removed = placeRef(
    aRef({ lines: null, old: { start: 2, end: 2 } }),
    state.anchor.tip,
    commits,
    new Map([[hunk.id, hunk]]),
    ownership(commits),
    lineNumbers([hunk]),
  );
  expect(removed).toMatchObject({ kind: "on", commit: 1, targets: [{ commit: 1, row: 1 }] });
});

test("chips name the file and lines; code spans find their ref by place", () => {
  const ref = aRef({ start: 4, end: 9, at: 2 });
  expect(refLabel(ref)).toBe("lib.js:4-9");
  expect(refPlace(ref)).toBe("src/lib.js:4-9@2");
  expect(refLabel(aRef({ start: 7, end: 7 }))).toBe("lib.js:7");
  const refs = [aRef(), aRef({ n: 2, start: 7, end: 7, at: "base" })];
  expect(refNumberOf("src/lib.js:4-5", refs)).toBe(1);
  expect(refNumberOf("src/lib.js:7-7@base", refs)).toBe(2);
  expect(refNumberOf("src/lib.js:7@base", refs)).toBe(2);
  expect(refNumberOf("src/lib.js:7", refs)).toBeNull();
  expect(refNumberOf("items.length", refs)).toBeNull();
});

test("each step's caption is the list item that first holds its ref", () => {
  const refs = [aRef(), aRef({ n: 2, start: 1, end: 2 }), aRef({ n: 3, start: 7, end: 7 })];
  const text = [
    "It runs in three steps, starting at `src/lib.js:4-5`:",
    "",
    "1. `src/lib.js:1-2` imports the **guard**, then `assertNumber` throws.",
    "2. `src/lib.js:4-5` checks a: before b.",
    "3. Last, `src/lib.js:7` closes it.",
  ].join("\n");
  expect(captionsOf(text, (code) => refNumberOf(code, refs))).toEqual(
    new Map([
      [2, "imports the guard, then assertNumber throws."],
      [3, "Last, closes it."],
    ]),
  );
});
