import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BranchRefusedError, loadDiff, writeBranch } from "../src/git.ts";
import { PLAN_SCHEMA, validatePlan } from "../src/plan.ts";
import type { Diff } from "../src/types.ts";
import { addWholeFileKinds, makeFixtureRepo } from "./fixture-repo.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function unitAt(diff: Diff, path: string, n = 0): string {
  const id = [...diff.units.values()].filter((u) => u.path === path)[n]?.id;
  assert.ok(id, `unit ${n} of ${path}`);
  return id;
}

/** Takes the second lib.js hunk before the first, and splits it across three commits. */
function storyPlan(diff: Diff) {
  const lib0 = unitAt(diff, "src/lib.js", 0);
  const lib1 = unitAt(diff, "src/lib.js", 1);
  const commits = [
    { message: "fix: reject division by zero", units: [`${lib1}:2`] },
    {
      message: "feat: guard add and mul with assertNumber",
      units: [unitAt(diff, "src/guard.js"), `${lib1}:0-1`, lib0],
    },
    { message: "feat: add pow", units: [lib1] },
    { message: "docs: describe usage", units: [unitAt(diff, "README.md")] },
    {
      message: "chore: rename the legacy module and refresh assets",
      units: [
        unitAt(diff, "src/old-name.js"),
        unitAt(diff, "src/new-name.js"),
        unitAt(diff, "notes.txt"),
        unitAt(diff, "assets/logo.bin"),
        unitAt(diff, "scripts/run.sh"),
      ],
    },
  ];
  return { schema: PLAN_SCHEMA, base: diff.base, tip: diff.tip, commits, responses: [] };
}

function snapshot(dir: string) {
  return {
    head: git(dir, "rev-parse", "HEAD"),
    branch: git(dir, "symbolic-ref", "HEAD"),
    index: readFileSync(join(dir, ".git/index")).toString("hex"),
    status: git(dir, "--no-optional-locks", "status", "--porcelain", "--ignored"),
  };
}

test("apply writes the story as commits whose last tree is the tip, without touching HEAD", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const before = snapshot(repo.dir);
  assert.equal(before.status, "");
  const diff = await loadDiff(repo.dir, "main", "feature");
  const verdict = validatePlan(diff, storyPlan(diff));
  assert.ok(verdict.ok, JSON.stringify(verdict));

  const result = await writeBranch(repo.dir, diff, verdict.plan, {
    name: "feature-split",
    expectedOld: null,
    force: false,
  });
  assert.equal(result.kind, "created");
  assert.equal(git(repo.dir, "rev-parse", "feature-split"), result.head);
  assert.equal(
    git(repo.dir, "rev-parse", "feature-split^{tree}"),
    git(repo.dir, "rev-parse", "feature^{tree}"),
  );
  assert.equal(git(repo.dir, "rev-list", "--count", "main..feature-split"), "5");
  assert.equal(
    git(repo.dir, "log", "--reverse", "--format=%s", "main..feature-split"),
    [
      "fix: reject division by zero",
      "feat: guard add and mul with assertNumber",
      "feat: add pow",
      "docs: describe usage",
      "chore: rename the legacy module and refresh assets",
    ].join("\n"),
  );
  assert.equal(
    git(repo.dir, "log", "-1", "--format=%an <%ae> | %cn <%ce>", "feature-split"),
    "fixture <fixture@example.com> | fixture <fixture@example.com>",
  );
  assert.equal(
    git(repo.dir, "show", "feature-split~4:src/lib.js").split("\n").slice(12).join("\n"),
    [
      "export function div(a, b) {",
      "  if (b === 0) throw new RangeError('division by zero');",
      "  return a / b;",
      "}",
    ].join("\n"),
  );
  assert.equal(git(repo.dir, "ls-tree", "feature-split", "scripts/run.sh").slice(0, 6), "100755");
  assert.deepEqual(snapshot(repo.dir), before);

  const again = await writeBranch(repo.dir, diff, verdict.plan, {
    name: "feature-split",
    expectedOld: result.head,
    force: false,
  });
  assert.deepEqual(
    { kind: again.kind, head: again.head },
    { kind: "unchanged", head: result.head },
  );

  const elsewhere = await writeBranch(repo.dir, diff, verdict.plan, {
    name: "feature-split-2",
    expectedOld: null,
    force: false,
  });
  assert.equal(elsewhere.head, result.head, "the same plan yields the same commits");
});

test("apply refuses to move a branch it did not write unless forced", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const verdict = validatePlan(diff, storyPlan(diff));
  assert.ok(verdict.ok);
  const opts = { name: "main", expectedOld: null, force: false };
  await assert.rejects(writeBranch(repo.dir, diff, verdict.plan, opts), {
    name: BranchRefusedError.name,
    message: "branch main already exists and follow-me did not write it; pass --force to overwrite",
  });
  assert.equal(git(repo.dir, "rev-parse", "main"), repo.base);
  const forced = await writeBranch(repo.dir, diff, verdict.plan, { ...opts, force: true });
  assert.equal(forced.kind, "updated");
  assert.equal(
    git(repo.dir, "rev-parse", "main^{tree}"),
    git(repo.dir, "rev-parse", "feature^{tree}"),
  );
});

test("symlink, empty file, type change and gitlink units apply in reverse diff order", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  addWholeFileKinds(repo);
  writeFileSync(join(repo.dir, "wip.txt"), "staged work in progress\n");
  git(repo.dir, "add", "wip.txt");
  const before = snapshot(repo.dir);
  assert.equal(before.status, "A  wip.txt");
  const diff = await loadDiff(repo.dir, "main", "feature");
  const units = [...diff.units.keys()].reverse();
  const verdict = validatePlan(diff, {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: units.map((u, i) => ({ message: `step ${i}`, units: [u] })),
    responses: [],
  });
  assert.ok(verdict.ok, JSON.stringify(verdict));
  const result = await writeBranch(repo.dir, diff, verdict.plan, {
    name: "split",
    expectedOld: null,
    force: false,
  });
  assert.equal(result.commits.length, 12);
  assert.equal(
    git(repo.dir, "rev-parse", "split^{tree}"),
    git(repo.dir, "rev-parse", "feature^{tree}"),
  );
  assert.deepEqual(snapshot(repo.dir), before);
});
