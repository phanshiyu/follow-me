import { describe, expect, test } from "vitest";
import { aComment, aState, HUNK } from "../test/factories.ts";
import { arrival, placeCarried } from "./carried.ts";
import type { Carried, State } from "./wire.ts";

function carry(entry: Partial<Carried>): Carried {
  return JSON.parse(
    JSON.stringify({
      comment: aComment({ kind: undefined, body: "Guard both in one call" }),
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
    previous: { version: JSON.parse("2"), comments: [], responses: [] },
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

  test("a changed hunk arrives with only a tip line; the card sits at the row nearest it", () => {
    const [placed] = placeCarried(v3({ changed: true, offsets: null, newLine: 5 }));
    expect(placed).toMatchObject({ kind: "changed", commit: 1, unit: HUNK, row: 4 });
    const [far] = placeCarried(v3({ changed: true, offsets: null, newLine: 40 }));
    expect(far).toMatchObject({ row: 6 });
  });

  test("code that is gone sits under the commit that last held the path", () => {
    const [placed] = placeCarried(v3({ unit: null, offsets: null, changed: true }));
    expect(placed).toMatchObject({ kind: "gone", commit: 1, unit: null, row: null });
  });

  test("gone code on a path no commit holds falls to the branch discussion", () => {
    const [placed] = placeCarried(
      v3({ unit: null, offsets: null, path: JSON.parse('"src/old.js"') }),
    );
    expect(placed).toMatchObject({ kind: "gone", commit: null });
  });

  test("a comment on a commit message stays under that commit's message, not in the branch discussion", () => {
    const comment = aComment({
      anchor: JSON.parse('{"kind":"message","commit":1}'),
      context: JSON.parse('{"commitMessage":"Guard add","path":null}'),
    });
    const [placed] = placeCarried(
      v3({ comment, unit: null, offsets: null, path: null, newLine: null }),
    );
    expect(placed).toMatchObject({ kind: "same", commit: 1, unit: null, row: null });
  });

  test("a question about the whole branch stays in the branch discussion and is not gone", () => {
    const comment = aComment({
      anchor: JSON.parse('{"kind":"plan"}'),
      context: JSON.parse('{"commitMessage":"","path":null}'),
    });
    const [placed] = placeCarried(
      v3({ comment, unit: null, offsets: null, path: null, newLine: null }),
    );
    expect(placed).toMatchObject({ kind: "same", commit: null });
  });

  test("a context-line comment on changed code stays in the commit the reviewer was reading", () => {
    // Tip line 3 is the context row "export function add", which commit 0 also shows; the reviewer
    // commented while reading commit 1, so the card must not jump back to commit 0.
    const [placed] = placeCarried(v3({ changed: true, offsets: null, newLine: 3 }));
    expect(placed).toMatchObject({ kind: "changed", commit: 1, unit: HUNK, row: 2 });
  });

  test("a comment on a whole hunk stays at the end of the hunk, not the top of the commit", () => {
    const comment = aComment({
      anchor: JSON.parse(`{"kind":"hunk","unit":"${HUNK}","commit":1,"changes":null}`),
    });
    for (const changed of [false, true]) {
      const [placed] = placeCarried(v3({ comment, changed, offsets: null, newLine: null }));
      expect(placed).toMatchObject({ commit: 1, unit: HUNK, row: 6 });
    }
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
  const onMessage = aComment({ anchor: JSON.parse('{"kind":"message","commit":1}') });
  expect(arrival(3, [carry({ comment: onMessage, unit: null, path: null })])).toBe(
    "Plan v3 arrived",
  );
});
