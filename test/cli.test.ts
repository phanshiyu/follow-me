import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDiff } from "../src/git.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));

/** Without API credentials, so no test can reach the Anthropic API. */
const OFFLINE = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")),
);

function run(dir: string, ...args: string[]) {
  const r = spawnSync(BIN, args, { cwd: dir, encoding: "utf8", env: OFFLINE });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
}

function writeWholeDraft(dir: string, base: string, tip: string, units: readonly string[]) {
  const commits = [{ message: "feat: everything", narration: "I write it all at once.", units }];
  writeFileSync(
    join(dir, ".follow-me", "feature", "draft.json"),
    JSON.stringify({ schema: "follow-me/plan@1", base, tip, commits, responses: [] }),
  );
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

test("extract, check, apply and status drive the whole flow from the command line", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const tip = repo.branch.slice(0, 12);
  const base = repo.base.slice(0, 12);

  assert.deepEqual(run(repo.dir, "extract"), {
    code: 0,
    out: [
      `feature ${tip} onto main ${base}: 8 files, 9 units`,
      "  M README.md        1 hunk, 6 change lines",
      "  M assets/logo.bin  binary",
      "  M notes.txt        1 hunk, 3 change lines",
      "  M scripts/run.sh   mode 100644 -> 100755",
      "  A src/guard.js     1 hunk, 3 change lines",
      "  M src/lib.js       2 hunks, 11 change lines",
      "  A src/new-name.js  1 hunk, 1 change line",
      "  D src/old-name.js  1 hunk, 1 change line",
      "session .follow-me/feature",
      "",
    ].join("\n"),
    err: "",
  });

  const diff = await loadDiff(repo.dir, "main", "feature");
  const ids = [...diff.units.keys()];
  const [readme] = ids;
  assert.ok(readme);
  const draftPath = join(repo.dir, ".follow-me", "feature", "draft.json");
  const draft = (commits: { message: string; units: string[] }[]) =>
    writeFileSync(
      draftPath,
      JSON.stringify({ schema: "follow-me/plan@1", base: repo.base, tip: repo.branch, commits }),
    );

  draft([{ message: "docs: readme", units: [`${readme}:0-2`] }]);
  const failing = run(repo.dir, "check");
  assert.equal(failing.code, 1);
  assert.equal(failing.out.split("\n")[0], `${readme}:3-5 (README.md) is in no commit`);

  draft([
    { message: "docs: readme", units: [readme] },
    { message: "feat: everything else", units: ids.slice(1) },
  ]);
  const ok = run(repo.dir, "check");
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^ok: 2 commits, plan [0-9a-f]{12}\n/);
  assert.equal(
    ok.out.split("\n").slice(1).join("\n"),
    [
      "  1  docs: readme  (1 unit, 1 file)",
      "  2  feat: everything else  (8 units, 7 files)",
      "",
    ].join("\n"),
  );

  const before = git(repo.dir, "rev-parse", "HEAD");
  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  const head = git(repo.dir, "rev-parse", "feature-split");
  const tree = git(repo.dir, "rev-parse", "feature^{tree}");
  assert.equal(
    applied.out,
    [
      `created feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
      `proof: feature-split^{tree} ${tree} equals feature^{tree} ${tree}`,
      "",
    ].join("\n"),
  );
  assert.equal(
    run(repo.dir, "apply").out.split("\n")[0],
    `unchanged feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
  );
  assert.equal(git(repo.dir, "rev-parse", "HEAD"), before);
  assert.equal(git(repo.dir, "status", "--porcelain"), "");

  assert.deepEqual(run(repo.dir, "status"), {
    code: 0,
    out: [
      `feature ${tip} onto main ${base}`,
      "units: 9 units",
      "draft: .follow-me/feature/draft.json",
      "plans: v1",
      "reviews: none",
      `applied: plan v1 as feature-split at ${head.slice(0, 12)}`,
      "",
    ].join("\n"),
    err: "",
  });
  assert.deepEqual(run(repo.dir, "feedback"), {
    code: 1,
    out: "",
    err: "follow-me: no review yet, run `follow-me review` first\n",
  });
  const prompt = run(repo.dir, "prompt");
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /^# follow-me: plan the commits\n/);
  assert.match(prompt.out, /## Previous plan/);
});

test("prompt --walk writes for a reviewer and names the branch in the check command", (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "checkout", "-q", "main");
  const prompt = run(repo.dir, "prompt", "--walk", "--branch", "feature");
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /^# follow-me: tell the story of this branch\n/);
  assert.ok(
    prompt.out.includes("The reader is a reviewer meeting this branch for the first time."),
  );
  assert.ok(prompt.out.includes("Check your work with `follow-me check --branch feature`"));
});

test("walk without a plan or API credentials prints the two commands to run instead", (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.deepEqual(run(repo.dir, "walk", "--no-open"), {
    code: 1,
    out: [
      "no plan for feature yet, and neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set to ask the API for one.",
      "Have a coding agent follow the prompt, then walk again:",
      "  follow-me prompt --walk",
      "  follow-me walk",
      "",
    ].join("\n"),
    err: "",
  });

  writeFileSync(join(repo.dir, "notes.txt"), "moved\n");
  git(repo.dir, "commit", "-qam", "move");
  const moved = run(repo.dir, "walk", "--no-open", "--branch", "feature");
  assert.equal(moved.code, 1);
  const lines = moved.out.split("\n");
  assert.equal(
    lines[0],
    `feature moved, re-extracted at ${git(repo.dir, "rev-parse", "--short=12", "HEAD")}`,
  );
  assert.deepEqual(lines.slice(-3), [
    "  follow-me prompt --walk --branch feature",
    "  follow-me walk --branch feature",
    "",
  ]);
});

test("walk serves a frozen plan in walk mode and saves a code review on end", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);

  const port = await freePort();
  const child = spawn(BIN, ["walk", "--no-open", "--port", String(port)], {
    cwd: repo.dir,
    env: OFFLINE,
  });
  t.after(() => child.kill());
  const exited = once(child, "exit");
  let out = "";
  child.stdout.setEncoding("utf8");
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const found = /follow-me code review: (http:\/\/\S+)\n/.exec(out)?.[1];
      if (found !== undefined) resolve(found);
    });
    child.on("exit", (code) => reject(new Error(`walk exited ${code} before listening: ${out}`)));
  });
  assert.equal(url, `http://127.0.0.1:${port}/`);

  const state = JSON.parse(await (await fetch(new URL("/api/state", url))).text());
  assert.equal(state.mode, "walk");
  assert.equal(state.commits[0].narration, "I write it all at once.");
  const ended = await fetch(new URL("/api/end", url), { method: "POST" });
  assert.equal(ended.status, 200);
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(
    out.split("\n").slice(1).join("\n"),
    [
      "code review saved to .follow-me/feature/reviews/v1.json with 0 comments",
      "`follow-me feedback` prints it as a code review for the author",
      "",
    ].join("\n"),
  );
  const review = JSON.parse(
    readFileSync(join(repo.dir, ".follow-me", "feature", "reviews", "v1.json"), "utf8"),
  );
  assert.equal(review.mode, "walk");
  assert.equal(review.planVersion, 1);
  assert.equal(run(repo.dir, "feedback").out, "# Code review\n\nThe reviewer left no comments.\n");
});

test("apply never writes the branch being split, even with --force", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.deepEqual(run(repo.dir, "apply", "--name", "feature", "--force"), {
    code: 1,
    out: "",
    err: "follow-me: feature is the branch being split; the split always lands on a separate branch, so pick another --name (--force does not change this)\n",
  });
  assert.equal(git(repo.dir, "rev-parse", "feature"), repo.branch);
});

async function runAsync(dir: string, ...args: string[]) {
  const child = spawn(BIN, args, { cwd: dir, env: OFFLINE });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    err += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, out, err };
}

test("two worktrees of one repo apply their own splits at the same time", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const outside = mkdtempSync(join(tmpdir(), "follow-me-worktree-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const worktree = join(outside, "other");
  git(repo.dir, "worktree", "add", "-q", "-b", "other", worktree, "main");
  writeFileSync(join(worktree, "notes.txt"), "other work\n");
  git(worktree, "commit", "-qam", "other work");

  const sessions: [string, string][] = [
    [repo.dir, "feature"],
    [worktree, "other"],
  ];
  for (const [dir, branch] of sessions) {
    assert.equal(run(dir, "extract").code, 0);
    const diff = await loadDiff(dir, "main", branch);
    const commits = [{ message: `feat: ${branch}`, units: [...diff.units.keys()] }];
    writeFileSync(
      join(dir, ".follow-me", branch, "draft.json"),
      JSON.stringify({ schema: "follow-me/plan@1", base: diff.base, tip: diff.tip, commits }),
    );
  }
  const [main, other] = await Promise.all([
    runAsync(repo.dir, "apply"),
    runAsync(worktree, "apply"),
  ]);
  assert.deepEqual([main.code, main.err, other.code, other.err], [0, "", 0, ""]);
  assert.equal(git(repo.dir, "log", "-1", "--format=%s", "feature-split"), "feat: feature");
  assert.equal(git(repo.dir, "log", "-1", "--format=%s", "other-split"), "feat: other");
  assert.equal(git(repo.dir, "fsck", "--connectivity-only", "--no-dangling"), "");
});
