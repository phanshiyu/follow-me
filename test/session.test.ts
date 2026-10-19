import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLAN_SCHEMA, validatePlan } from "../src/plan.ts";
import {
  BranchMovedError,
  extractSession,
  isLockToken,
  openSession,
  openSessionAt,
  parseReview,
  SessionFileError,
  SessionLockedError,
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
  session.recordApplied(
    { version: latest, hash: "b".repeat(64) },
    { branch: "feature-split", head: session.anchor.base, signed: true },
  );
  assert.deepEqual(session.applied(), {
    schema: "follow-me/applied@1",
    version: 2,
    branch: "feature-split",
    head: repo.base,
    hash: "b".repeat(64),
    signed: true,
  });
  const path = join(session.dir, "applied.json");
  const { hash: _hash, signed: _signed, ...older } = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify(older));
  assert.deepEqual(session.applied(), {
    schema: "follow-me/applied@1",
    version: 2,
    branch: "feature-split",
    head: repo.base,
    hash: null,
    signed: null,
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
    mode: "split",
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

  const { mode: _, ...older } = review;
  assert.deepEqual(parseReview(older), review);
  assert.equal(parseReview({ ...review, mode: "solo" }), 'mode is not "split" or "walk"');
  const walk = parseReview({ ...review, mode: "walk" });
  assert.ok(typeof walk !== "string", String(walk));
  session.writeReview(walk);
  assert.throws(() => session.writeReview(walk), SessionFileError);
  assert.equal(existsSync(join(session.dir, "reviews", "walk", "v1.json")), true);
  writeFileSync(
    join(session.dir, "reviews", "v2.json"),
    JSON.stringify({ ...review, mode: "walk", planVersion: 2 }),
  );
  const modes = (stored: { version: number; review: { mode: string } }[]) =>
    stored.map((r) => [r.version, r.review.mode]);
  assert.deepEqual(modes(session.reviews()), [
    [1, "split"],
    [2, "walk"],
  ]);
  assert.deepEqual(modes(session.walkReviews()), [
    [1, "walk"],
    [2, "walk"],
  ]);
  assert.deepEqual(session.lastReview(), review);

  writeFileSync(
    join(session.dir, "reviews", "v3.json"),
    JSON.stringify({ ...review, comments: [{}] }),
  );
  assert.throws(() => session.reviews(), {
    name: "SessionFileError",
    message: `${join(session.dir, "reviews", "v3.json")}: comments[0]: id is not a comment id`,
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

test("sessions in two repos keep separate state", async (t) => {
  const one = makeFixtureRepo();
  t.after(one.cleanup);
  const two = makeFixtureRepo();
  t.after(two.cleanup);
  const [a, b] = await Promise.all([openSession(one.dir), openSession(two.dir)]);
  assert.equal(a.dir, join(realpathSync(one.dir), ".follow-me", "feature"));
  assert.equal(b.dir, join(realpathSync(two.dir), ".follow-me", "feature"));
  const verdict = validatePlan(a.diff, plan(a.diff, "feat: one"));
  assert.ok(verdict.ok);
  assert.equal(a.freeze(verdict.plan), 1);
  assert.deepEqual(
    [
      a.plans().length,
      b.plans().length,
      readFileSync(join(two.dir, ".follow-me", ".gitignore"), "utf8"),
    ],
    [1, 0, "*\n"],
  );
});

test("a linked worktree keeps its own .follow-me inside the worktree", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const outside = mkdtempSync(join(tmpdir(), "follow-me-worktree-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const worktree = join(realpathSync(outside), "other");
  git(repo.dir, "worktree", "add", "-q", "-b", "other", worktree, "main");
  writeFileSync(join(worktree, "notes.txt"), "other work\n");
  git(worktree, "commit", "-qam", "other work");

  const [main, linked] = await Promise.all([
    openSession(repo.dir),
    openSession(join(worktree, "src")),
  ]);
  assert.equal(main.dir, join(realpathSync(repo.dir), ".follow-me", "feature"));
  assert.equal(linked.dir, join(worktree, ".follow-me", "other"));
  assert.equal(linked.anchor.branch, "other");
  assert.equal(readFileSync(join(worktree, ".follow-me", ".gitignore"), "utf8"), "*\n");
  assert.deepEqual(readdirSync(join(repo.dir, ".follow-me")).sort(), [".gitignore", "feature"]);
  assert.deepEqual(readdirSync(join(worktree, ".follow-me")).sort(), [".gitignore", "other"]);
  assert.equal(git(worktree, "status", "--porcelain"), "");
});

test("two branches whose names share a slug cannot share a session", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "branch", "topic/x", "feature");
  git(repo.dir, "branch", "topic-x", "feature");
  const first = await openSession(repo.dir, { branch: "topic/x" });
  const message = `${first.dir} holds the session of branch topic/x, and topic-x maps to the same directory; rename one of the two branches`;
  await assert.rejects(openSession(repo.dir, { branch: "topic-x" }), {
    name: SessionFileError.name,
    message,
  });
  await assert.rejects(extractSession(repo.dir, { branch: "topic-x" }), {
    name: SessionFileError.name,
    message,
  });
  assert.equal((await openSession(repo.dir, { branch: "topic/x" })).anchor.branch, "topic/x");
});

test("a held lock is handed over by its token and only the new holder releases it", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const session = await openSession(repo.dir);
  const lockPath = join(session.dir, "lock");
  const cli = session.lock("review");
  const stranger = randomUUID();
  assert.ok(isLockToken(stranger));
  assert.throws(() => session.adoptLock(stranger, "review"), SessionLockedError);

  const server = (await openSessionAt(session.dir)).adoptLock(cli.token, "review");
  assert.notEqual(server.token, cli.token);
  cli.release();
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, server.token);
  assert.throws(() => session.lock("apply"), SessionLockedError);
  server.release();
  assert.deepEqual(session.lockState(), { kind: "free" });
});
