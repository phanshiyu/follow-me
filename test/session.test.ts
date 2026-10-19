import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PLAN_SCHEMA, validatePlan } from "../src/plan.ts";
import {
  BranchMovedError,
  extractSession,
  openSession,
  parseReview,
  SessionFileError,
} from "../src/session.ts";
import type { Diff } from "../src/types.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function plan(diff: Diff, message: string) {
  return {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [{ message, units: [...diff.units.keys()] }],
    responses: [],
  };
}

test("opening a session anchors it to the branch and keeps the worktree clean", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const session = await openSession(repo.dir);
  assert.equal(session.dir, join(realpathSync(repo.dir), ".follow-me", "feature"));
  assert.deepEqual(JSON.parse(readFileSync(join(session.dir, "session.json"), "utf8")), {
    schema: "follow-me/session@1",
    branch: "feature",
    baseRef: "main",
    base: repo.base,
    tip: repo.branch,
    tipTree: git(repo.dir, "rev-parse", "feature^{tree}"),
  });
  assert.equal(readFileSync(join(repo.dir, ".follow-me", ".gitignore"), "utf8"), "*\n");
  assert.equal(git(repo.dir, "status", "--porcelain"), "");
});

test("a branch name with slashes maps to a flat slug directory", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "branch", "topic/split-me", "feature");
  const session = await openSession(repo.dir, { branch: "topic/split-me" });
  assert.equal(session.dir, join(realpathSync(repo.dir), ".follow-me", "topic-split-me"));
  assert.equal(session.anchor.branch, "topic/split-me");
});

test("freeze writes a new version only when the plan changed", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const session = await openSession(repo.dir);
  const first = validatePlan(session.diff, plan(session.diff, "feat: everything"));
  const second = validatePlan(session.diff, plan(session.diff, "feat: all of it"));
  assert.ok(first.ok && second.ok);
  assert.equal(session.freeze(first.plan), 1);
  assert.equal(session.freeze(first.plan), 1);
  const latest = session.freeze(second.plan);
  assert.equal(latest, 2);
  assert.deepEqual(
    session
      .plans()
      .map((p) => [p.version, p.file.commits[0]?.message, p.hash === second.plan.hash]),
    [
      [1, "feat: everything", false],
      [2, "feat: all of it", true],
    ],
  );
  session.recordApplied(latest, { branch: "feature-split", head: session.anchor.base });
  assert.deepEqual(session.applied(), {
    schema: "follow-me/applied@1",
    version: 2,
    branch: "feature-split",
    head: repo.base,
  });
});

test("reviews round-trip through the boundary parser and are written once", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const session = await openSession(repo.dir);
  assert.equal(session.lastReview(), null);
  const unit = [...session.diff.units.keys()][0];
  assert.ok(unit);
  const review = {
    schema: "follow-me/review@1",
    planVersion: 1,
    planHash: "a".repeat(64),
    endedAt: "2026-10-19T00:00:00.000Z",
    comments: [
      {
        id: "c_1",
        anchor: { kind: "hunk", unit, commit: 0, changes: [0, 2] },
        context: { commitMessage: "feat: x", path: "README.md" },
        body: "split this",
        createdAt: "2026-10-19T00:00:00.000Z",
      },
    ],
  };
  const parsed = parseReview(review);
  assert.ok(typeof parsed !== "string", String(parsed));
  session.writeReview(parsed);
  assert.deepEqual(session.lastReview(), review);
  assert.throws(() => session.writeReview(parsed), SessionFileError);

  writeFileSync(
    join(session.dir, "reviews", "v2.json"),
    JSON.stringify({ ...review, comments: [{}] }),
  );
  assert.throws(() => session.reviews(), {
    name: "SessionFileError",
    message: `${join(session.dir, "reviews", "v2.json")}: comments[0]: id is not a comment id`,
  });
});

test("a moved branch must be re-extracted before the session opens again", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  await openSession(repo.dir);
  writeFileSync(join(repo.dir, "notes.txt"), "moved\n");
  git(repo.dir, "commit", "-qam", "move");
  const moved = git(repo.dir, "rev-parse", "HEAD");
  await assert.rejects(openSession(repo.dir), {
    name: BranchMovedError.name,
    message: `feature moved from ${repo.branch.slice(0, 12)} to ${moved.slice(0, 12)} since extract; run "follow-me extract" again`,
  });
  const fresh = await extractSession(repo.dir);
  assert.equal(fresh.anchor.tip, moved);
  assert.equal((await openSession(repo.dir)).anchor.tip, moved);
});
