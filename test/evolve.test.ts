import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evolvePlan } from "../src/evolve.ts";
import { loadDiff } from "../src/git.ts";
import { isCommentId, PLAN_SCHEMA, serializePlanFile, validatePlan } from "../src/plan.ts";
import type { Diff, PlanFile, Unit, UnitId } from "../src/types.ts";
import { type FixtureRepo, makeFixtureRepo } from "./fixture-repo.ts";

function git(dir: string, ...args: string[]): string {
  const who = { NAME: "fixture", EMAIL: "fixture@example.com" };
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: who.NAME,
    GIT_AUTHOR_EMAIL: who.EMAIL,
    GIT_COMMITTER_NAME: who.NAME,
    GIT_COMMITTER_EMAIL: who.EMAIL,
  };
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
}

function commitEdit(repo: FixtureRepo, path: string, from: string, to: string): void {
  const file = join(repo.dir, path);
  writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  git(repo.dir, "commit", "-q", "-am", "edit");
}

function describe(unit: Unit): string {
  return unit.kind === "hunk"
    ? `${unit.path} hunk ${unit.changeCount}`
    : `${unit.path} ${unit.kind}`;
}

function idsOn(diff: Diff, path: string): UnitId[] {
  return [...diff.units.values()].filter((u) => u.path === path).map((u) => u.id);
}

/** Commit 1 guards numbers (guard.js and lib.js's first hunk); commit 2 takes the rest. */
function twoCommits(diff: Diff): PlanFile {
  const [libFirst] = idsOn(diff, "src/lib.js");
  assert.ok(libFirst);
  const first = [...idsOn(diff, "src/guard.js"), libFirst];
  const rest = [...diff.units.keys()].filter((id) => !first.includes(id));
  const answered = "c_aaaaaa";
  assert.ok(isCommentId(answered));
  return {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [
      { message: "feat: guard numbers", narration: "kept", units: first.map(whole) },
      { message: "feat: the rest", units: rest.map(whole) },
    ],
    responses: [{ comment: answered, status: "addressed", note: "old" }],
  };
}

function whole(unit: UnitId) {
  return { unit, select: { kind: "rest" } } as const;
}

test("an edited hunk vanishes from its commit and comes back as a new unit", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const oldDiff = await loadDiff(repo.dir, "main", "feature");
  const oldPlan = twoCommits(oldDiff);
  commitEdit(repo, "src/lib.js", "division by zero", "cannot divide by zero");
  const newDiff = await loadDiff(repo.dir, "main", "feature");

  const { draft, vanished, added } = evolvePlan(oldPlan, oldDiff, newDiff);

  assert.equal(draft.tip, git(repo.dir, "rev-parse", "feature"));
  assert.deepEqual(draft.responses, []);
  assert.deepEqual(draft.commits[0], oldPlan.commits[0]);
  assert.deepEqual(
    draft.commits.map((c) => c.units.length),
    [2, 6],
  );
  assert.deepEqual(
    vanished.map((v) => [describe(v.unit), v.commits]),
    [["src/lib.js hunk 7", [{ index: 1, message: "feat: the rest" }]]],
  );
  assert.deepEqual(added.map(describe), ["src/lib.js hunk 7"]);
  const [unit] = added;
  assert.ok(unit?.kind === "hunk");
  assert.match(unit.body.map((l) => l.text).join(""), /cannot divide by zero/);
  const verdict = validatePlan(newDiff, serializePlanFile(draft));
  assert.ok(!verdict.ok);
  assert.deepEqual(
    verdict.issues.map((i) => i.kind),
    ["unassigned"],
  );
});

test("a commit whose every unit vanished is dropped from the draft", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const oldDiff = await loadDiff(repo.dir, "main", "feature");
  const [notes] = idsOn(oldDiff, "notes.txt");
  assert.ok(notes);
  const others = [...oldDiff.units.keys()].filter((id) => id !== notes);
  const oldPlan: PlanFile = {
    schema: PLAN_SCHEMA,
    base: oldDiff.base,
    tip: oldDiff.tip,
    commits: [
      { message: "docs: notes", units: [whole(notes)] },
      { message: "feat: everything else", units: others.map(whole) },
    ],
    responses: [],
  };
  commitEdit(repo, "notes.txt", "line three", "line 3");
  const newDiff = await loadDiff(repo.dir, "main", "feature");

  const { draft, vanished } = evolvePlan(oldPlan, oldDiff, newDiff);

  assert.deepEqual(
    draft.commits.map((c) => c.message),
    ["feat: everything else"],
  );
  assert.deepEqual(
    vanished.map((v) => v.commits),
    [[{ index: 0, message: "docs: notes" }]],
  );
});

test("a tip that moved without changing the diff keeps the whole plan", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const oldDiff = await loadDiff(repo.dir, "main", "feature");
  const oldPlan = twoCommits(oldDiff);
  git(repo.dir, "commit", "-q", "--amend", "-m", "feature work, reworded");
  const newDiff = await loadDiff(repo.dir, "main", "feature");

  const { draft, vanished, added } = evolvePlan(oldPlan, oldDiff, newDiff);

  assert.notEqual(draft.tip, oldPlan.tip);
  assert.deepEqual(draft.commits, oldPlan.commits);
  assert.deepEqual([vanished, added], [[], []]);
  assert.equal(validatePlan(newDiff, serializePlanFile(draft)).ok, true);
});
