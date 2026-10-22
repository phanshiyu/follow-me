import assert from "node:assert/strict";
import { test } from "node:test";
import { isRepoPath } from "../src/diff.ts";
import { loadDiff } from "../src/git.ts";
import { validatePlan } from "../src/plan.ts";
import { codeSpans, type RefSource, refsIn, resolveRefs } from "../src/refs.ts";
import type { Diff } from "../src/types.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

test("only inline code spans that are wholly a path:line ref count, each place once", () => {
  const body = [
    "At 10:30 the guard in `src/lib.js:4-5` runs, then `items.length` and `10:30`.",
    "",
    "```ts",
    "`src/lib.js:1`",
    "```",
    "",
    "1. ``src/guard.js:2`` throws, see `localhost:3000` and `127.0.0.1:80`",
    "2. `src/lib.js:4-5` again, `src/lib.js:20@1`, `src/lib.js:2@base` and ` src/lib.js:7 `",
    "3. `src/lib.js:4-5@2` is another place, and \\`src/nope.js:1\\` is escaped",
  ].join("\n");
  assert.deepEqual(codeSpans("a `x` b ``y ` z`` c `unclosed"), ["x", "y ` z"]);
  assert.deepEqual(
    refsIn(body).map((r) => r.text),
    [
      "src/lib.js:4-5",
      "src/guard.js:2",
      "src/lib.js:20@1",
      "src/lib.js:2@base",
      "src/lib.js:7",
      "src/lib.js:4-5@2",
    ],
  );
  assert.deepEqual(refsIn("No code here, and `a.ts:5` with `a.ts:5-5` is one place."), [
    { text: "a.ts:5", path: "a.ts", start: 5, end: 5, at: null },
  ]);
});

async function fixtureSource(t: { after(fn: () => void): void }): Promise<RefSource> {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const diff: Diff = await loadDiff(repo.dir, "main", "feature");
  const first = [...diff.units.values()].find((u) => u.path === "src/lib.js");
  assert.ok(first !== undefined);
  const others = [...diff.units.values()].filter((u) => u.id !== first.id);
  const verdict = validatePlan(diff, {
    schema: "follow-me/plan@1",
    base: diff.base,
    tip: diff.tip,
    commits: [
      { message: "Guard add", units: [first.id] },
      { message: "The rest", units: others.map((u) => u.id) },
    ],
    responses: [],
  });
  assert.ok(verdict.ok);
  return {
    tip: diff.tip,
    textFiles: diff.textFiles,
    otherChanged: new Set(
      [...diff.units.values()].flatMap((u) => (diff.textFiles.has(u.path) ? [] : [u.path])),
    ),
    unchanged: new Map(),
    commits: verdict.plan.commits,
    version: 1,
  };
}

test("refs resolve to tip lines with a quote, from the tip, a commit of the plan or the base", async (t) => {
  const source = await fixtureSource(t);
  const specs = refsIn(
    "`src/lib.js:20-21`, `src/lib.js:18@1`, `src/lib.js:2@base`, `src/old-name.js:1@base`",
  );
  const { refs, problems } = resolveRefs(specs, source);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    refs.map(({ n, at, lines, old, quote }) => ({ n, at, lines, old, quote })),
    [
      {
        n: 1,
        at: null,
        lines: { start: 20, end: 21 },
        old: null,
        quote: ["  if (b === 0) throw new RangeError('division by zero');", "  return a / b;"],
      },
      // Commit 1 guards add only, so its line 18 is the division the tip has at 21.
      { n: 2, at: 1, lines: { start: 21, end: 21 }, old: null, quote: ["  return a / b;"] },
      { n: 3, at: "base", lines: { start: 6, end: 6 }, old: null, quote: ["  return a + b;"] },
      // The branch deletes the file, so the line is only in the base.
      {
        n: 4,
        at: "base",
        lines: null,
        old: { start: 1, end: 1 },
        quote: ["export const legacy = true;"],
      },
    ],
  );
  assert.ok(refs.every((r) => r.tip === source.tip));
});

test("every ref that does not resolve is named at once", async (t) => {
  const source = await fixtureSource(t);
  const { refs, problems } = resolveRefs(
    refsIn(
      [
        "`src/lib.js:99`",
        "`src/nope.js:1`",
        "`src/lib.js:1@9`",
        "`assets/logo.bin:1`",
        "`src/guard.js:1@base`",
        "`src/lib.js:5-3`",
        "`src/lib.js:3`",
      ].join(" "),
    ),
    source,
  );
  assert.deepEqual(problems, [
    "src/lib.js:99 is past the end of the file at the tip (26 lines)",
    "src/nope.js:1: no such file at the tip",
    "src/lib.js:1@9: plan v1 has 2 commits",
    "assets/logo.bin:1: not a text file",
    "src/guard.js:1@base: the file does not exist in the base",
    "src/lib.js:5-3 ends before it starts",
  ]);
  assert.deepEqual(
    refs.map((r) => [r.n, r.start]),
    [[7, 3]],
  );
});

test("a file the branch leaves alone resolves from the tip lines it was given", async (t) => {
  const source = await fixtureSource(t);
  const path = "docs/usage.md";
  assert.ok(isRepoPath(path));
  const alone = { ...source, unchanged: new Map([[path, ["one\n", "two\n", "three\n"]]]) };
  const { refs, problems } = resolveRefs(
    refsIn("`docs/usage.md:2-3` and `docs/other.md:1`"),
    alone,
  );
  assert.deepEqual(problems, ["docs/other.md:1: no such file at the tip"]);
  assert.deepEqual(
    refs.map(({ path, lines, old, quote }) => ({ path, lines, old, quote })),
    [{ path, lines: { start: 2, end: 3 }, old: null, quote: ["two", "three"] }],
  );
});
