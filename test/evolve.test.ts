import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseComment } from "../src/comments.ts";
import { carryComments, evolvePlan } from "../src/evolve.ts";
import { loadDiff } from "../src/git.ts";
import { isCommentId, PLAN_SCHEMA, serializePlanFile, validatePlan } from "../src/plan.ts";
import type { Comment, Diff, PlanFile, Unit, UnitId } from "../src/types.ts";
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

function rowOf(unit: Unit | undefined, text: string): number {
  assert.ok(unit?.kind === "hunk");
  const row = unit.body.findIndex((r) => r.text === text);
  assert.notEqual(row, -1, text);
  return row;
}

function commentOn(id: string, unit: UnitId, offsets: number[], path: string): Comment {
  const comment = parseComment({
    id,
    anchor: { kind: "hunk", unit, commit: 0, changes: [], offsets },
    context: { commitMessage: "feat: the rest", path },
    body: "change this",
    createdAt: "2026-10-21T12:00:00.000Z",
  });
  assert.ok(typeof comment !== "string");
  return comment;
}

test("comments follow the agent's edit: an edited hunk's thread moves and is marked changed", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const oldDiff = await loadDiff(repo.dir, "main", "feature");
  const [first, second] = idsOn(oldDiff, "src/lib.js");
  const [notes] = idsOn(oldDiff, "notes.txt");
  assert.ok(first && second && notes);
  const guard = "  if (b === 0) throw new RangeError('division by zero');\n";
  const comments = [
    commentOn(
      "c_aaaaaa",
      first,
      [rowOf(oldDiff.units.get(first), "  assertNumber(a);\n")],
      "src/lib.js",
    ),
    commentOn("c_bbbbbb", second, [rowOf(oldDiff.units.get(second), guard)], "src/lib.js"),
    commentOn("c_cccccc", notes, [0], "notes.txt"),
  ];
  const message = parseComment({
    id: "c_dddddd",
    anchor: { kind: "message", commit: 0 },
    context: { commitMessage: "feat: the rest", path: null },
    body: "reword",
    createdAt: "2026-10-21T12:00:00.000Z",
  });
  assert.ok(typeof message !== "string");

  // The agent documents div's guard one line above it and drops the notes change.
  commitEdit(
    repo,
    "src/lib.js",
    "export function div(a, b) {\n",
    "export function div(a, b) {\n  // b is never zero here\n",
  );
  writeFileSync(join(repo.dir, "notes.txt"), "line one\nline two");
  git(repo.dir, "commit", "-q", "-am", "drop notes");
  const newDiff = await loadDiff(repo.dir, "main", "feature");
  const [, replacement] = idsOn(newDiff, "src/lib.js");

  const carried = carryComments([...comments, message], oldDiff.units, newDiff.units);

  assert.deepEqual(
    carried.map(({ comment, ...where }) => ({ id: comment.id, ...where })),
    [
      {
        id: "c_aaaaaa",
        unit: first,
        offsets: comments[0]?.anchor.kind === "hunk" ? comments[0].anchor.offsets : null,
        changed: false,
        path: "src/lib.js",
        newLine: 4,
      },
      {
        id: "c_bbbbbb",
        unit: replacement,
        offsets: null,
        changed: true,
        path: "src/lib.js",
        newLine: 21,
      },
      {
        id: "c_cccccc",
        unit: null,
        offsets: null,
        changed: true,
        path: "notes.txt",
        newLine: null,
      },
      { id: "c_dddddd", unit: null, offsets: null, changed: false, path: null, newLine: null },
    ],
  );
  assert.notEqual(replacement, second);
});

test("a comment on a whole hunk keeps no line when its hunk is kept or replaced", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const oldDiff = await loadDiff(repo.dir, "main", "feature");
  const [first, second] = idsOn(oldDiff, "src/lib.js");
  assert.ok(first && second);
  const whole = (id: string, unit: string) => {
    const parsed = parseComment({
      id,
      anchor: { kind: "hunk", unit, commit: 0, changes: null },
      context: { commitMessage: "feat: the rest", path: "src/lib.js" },
      body: "this whole hunk needs a test",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    assert.ok(typeof parsed !== "string");
    return parsed;
  };
  commitEdit(
    repo,
    "src/lib.js",
    "export function div(a, b) {\n",
    "export function div(a, b) {\n  // b is never zero here\n",
  );
  const newDiff = await loadDiff(repo.dir, "main", "feature");
  const [, replacement] = idsOn(newDiff, "src/lib.js");

  const carried = carryComments(
    [whole("c_eeeeee", first), whole("c_ffffff", second)],
    oldDiff.units,
    newDiff.units,
  );

  assert.deepEqual(
    carried.map(({ comment, ...where }) => ({ id: comment.id, ...where })),
    [
      {
        id: "c_eeeeee",
        unit: first,
        offsets: null,
        changed: false,
        path: "src/lib.js",
        newLine: null,
      },
      {
        id: "c_ffffff",
        unit: replacement,
        offsets: null,
        changed: true,
        path: "src/lib.js",
        newLine: null,
      },
    ],
  );
});
