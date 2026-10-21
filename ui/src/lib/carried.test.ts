import { describe, expect, test } from "vitest";
import { aComment, aState, HUNK } from "../test/factories.ts";
import { arrival, placeCarried } from "./carried.ts";
import type { Carried, State } from "./wire.ts";

function carry(entry: Partial<Carried>): Carried {
  return JSON.parse(
    JSON.stringify({
      comment: "c_aaaaaa",
      unit: HUNK,
      offsets: [3, 4],
      changed: false,
      path: "src/lib.js",
      newLine: 4,
      ...entry,
    }),
  );
}

/** Version 3 over the same two commits, holding the v2 comment on the guard rows. */
function v3(entry: Partial<Carried>): State {
  return aState({
    version: JSON.parse("3"),
    previous: {
      version: JSON.parse("2"),
      comments: [aComment({ kind: undefined, body: "Guard both in one call" })],
      responses: [],
    },
    carried: [carry(entry)],
  });
}

describe("placeCarried", () => {
  test("code that did not change sits under its last row, in the commit that owns the rows", () => {
    const [placed] = placeCarried(v3({}));
    expect(placed).toMatchObject({ kind: "same", commit: 1, unit: HUNK, row: 4 });
    expect(placed?.comment.body).toBe("Guard both in one call");
  });

  test("changed code sits under the last row its commit shows", () => {
    // Row 0 is the import commit 1 adds, so the card goes to commit 1.
    const [placed] = placeCarried(v3({ changed: true, offsets: [0] }));
    expect(placed).toMatchObject({ kind: "changed", commit: 0, unit: HUNK, row: 0 });
    const [second] = placeCarried(v3({ changed: true, offsets: [1, 5] }));
    expect(second).toMatchObject({ kind: "changed", commit: 0, row: 5 });
  });

  test("code that is gone sits under the commit that last held the path", () => {
    const [placed] = placeCarried(v3({ unit: null, offsets: null, changed: true }));
    expect(placed).toMatchObject({ kind: "gone", commit: 1, unit: null, row: null });
  });

  test("gone code on a path no commit holds falls to the branch discussion", () => {
    const [placed] = placeCarried(v3({ unit: null, offsets: null, path: "src/old.js" }));
    expect(placed).toMatchObject({ kind: "gone", commit: null });
  });

  test("a state without carried threads places nothing", () => {
    expect(placeCarried(aState())).toEqual([]);
  });
});

test("the banner counts changed and gone threads, and says nothing of threads that did not move", () => {
  expect(arrival(3, [carry({}), carry({ changed: true }), carry({ unit: null })])).toBe(
    "Plan v3 arrived: 2 threads moved to changed code",
  );
  expect(arrival(3, [carry({ unit: null })])).toBe(
    "Plan v3 arrived: 1 thread moved to changed code",
  );
  expect(arrival(3, [carry({})])).toBe("Plan v3 arrived");
});
