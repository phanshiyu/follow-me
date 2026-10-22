import { expect, test } from "vitest";
import { aCommit, aCoverage, aHunk, aState } from "../test/factories.ts";
import {
  describeMark,
  markOf,
  pageCoverage,
  percentOf,
  stepUncovered,
  toneOf,
} from "./coverage.ts";
import { lineNumbers, ownership } from "./rows.ts";
import type { State, Unit, UnitId } from "./wire.ts";

function overPage(state: State, coverage = aCoverage()) {
  const units = new Map<UnitId, Unit>(state.units.map((u) => [u.id, u]));
  return pageCoverage(
    coverage,
    state.commits,
    units,
    ownership(state.commits),
    lineNumbers(state.units),
  );
}

test("a recorded line is covered, partly covered or not; an unrecorded one is not executable", () => {
  const coverage = aCoverage();
  expect(markOf(coverage, "src/lib.js", 6)).toEqual({
    kind: "covered",
    hits: 14,
    branches: null,
    stale: false,
  });
  expect(markOf(coverage, "src/lib.js", 4)?.kind).toBe("partly");
  expect(markOf(coverage, "src/lib.js", 5)?.kind).toBe("uncovered");
  expect(markOf(coverage, "src/lib.js", 2)).toBeNull();
  expect(markOf(coverage, "src/other.js", 1)).toBeNull();
});

test("a line that never ran is not covered even when its branches were recorded", () => {
  const coverage = aCoverage({
    files: { "a.js": { lines: { "1": 0 }, branches: { "1": [0, 2] } } },
  });
  expect(markOf(coverage, "a.js", 1)?.kind).toBe("uncovered");
});

test("each mark names itself for a screen reader", () => {
  const coverage = aCoverage({ stale: ["src/lib.js"] });
  const fresh = aCoverage();
  const say = (c: typeof coverage, line: number) => {
    const mark = markOf(c, "src/lib.js", line);
    return mark === null ? null : describeMark(mark);
  };
  expect(say(fresh, 6)).toBe("covered, 14 hits");
  expect(say(fresh, 1)).toBe("covered, 1 hit");
  expect(say(fresh, 4)).toBe("partly covered, 14 hits, 1 of 2 branches");
  expect(say(fresh, 5)).toBe("not covered");
  expect(say(coverage, 5)).toBe("not covered, coverage is stale");
});

test("rows of every kind carry their tip line's mark, and only added rows are counted", () => {
  const page = overPage(aState());
  const marks = page.marks.get(aHunk().id);
  expect([...(marks?.keys() ?? [])]).toEqual([0, 2, 3, 4, 5]);
  expect(page.commits).toEqual([
    { total: 1, run: 1, partly: 0 },
    { total: 2, run: 1, partly: 1 },
  ]);
  expect(page.files.get("1|src/lib.js")).toEqual({ total: 2, run: 1, partly: 1 });
  expect(page.branch).toEqual({ total: 3, run: 2, partly: 1 });
  expect(page.uncovered).toEqual([{ commit: 1, path: "src/lib.js", unit: aHunk().id, row: 4 }]);
});

test("a removed row has no tip line, so it gets no mark", () => {
  const hunk = aHunk({
    body: [
      { op: "-", text: "old\n", change: 0 },
      { op: "+", text: "new\n", change: 1 },
      { op: " ", text: "same\n" },
    ],
    changeCount: 2,
  });
  const state = aState({
    units: [hunk],
    commits: [
      aCommit(0, { refs: [{ unit: hunk.id, select: { kind: "lines", changes: [0, 1] } }] }),
    ],
  });
  const page = overPage(
    state,
    aCoverage({ files: { "src/lib.js": { lines: { "1": 0, "2": 3 } } } }),
  );
  expect([...(page.marks.get(hunk.id)?.keys() ?? [])]).toEqual([1, 2]);
  expect(page.commits[0]).toEqual({ total: 1, run: 0, partly: 0 });
});

test("the percentage rounds down, and the tone is red before amber", () => {
  expect(percentOf({ total: 3, run: 2, partly: 0 })).toBe(66);
  expect(percentOf({ total: 1000, run: 999, partly: 0 })).toBe(99);
  expect(toneOf({ total: 3, run: 2, partly: 1 })).toBe("uncovered");
  expect(toneOf({ total: 3, run: 3, partly: 1 })).toBe("partly");
  expect(toneOf({ total: 3, run: 3, partly: 0 })).toBe("covered");
});

test("x goes to the first row below the reading line and X to the last above, round the ends", () => {
  expect(stepUncovered(["above", "at", "below", "below"], 1)).toBe(2);
  expect(stepUncovered(["above", "at", "below"], -1)).toBe(0);
  expect(stepUncovered(["above", "above"], 1)).toBe(0);
  expect(stepUncovered(["at", "below"], -1)).toBe(1);
  expect(stepUncovered([], 1)).toBeNull();
});
