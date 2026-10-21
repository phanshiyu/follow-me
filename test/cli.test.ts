import assert from "node:assert/strict";
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDiff } from "../src/git.ts";
import { makeFixtureRepo, signWithSsh, sshSigningUnavailable } from "./fixture-repo.ts";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));

type Spawned = {
  readonly child: ChildProcessWithoutNullStreams;
  /** The first page URL the command prints. */
  readonly url: Promise<string>;
  readonly out: () => string;
  readonly exited: Promise<unknown[]>;
};

/**
 * Runs the CLI with its own state dir, so each test gets its own review server. A server the
 * test leaves running is killed when the test ends.
 */
function cliIn(t: TestContext, extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "follow-me-home-"));
  t.after(() => {
    const pid = serverRecord(home)?.pid;
    if (pid !== undefined && isAlive(pid)) process.kill(pid);
    rmSync(home, { recursive: true, force: true });
  });
  const env = { ...process.env, FOLLOW_ME_HOME: home, FOLLOW_ME_IDLE_MS: "200", ...extraEnv };
  const run = (dir: string, ...args: string[]) => {
    const r = spawnSync(BIN, args, { cwd: dir, encoding: "utf8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const runAsync = async (dir: string, ...args: string[]) => {
    const child = spawn(BIN, args, { cwd: dir, env });
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
  };
  const spawnCli = (dir: string, ...args: string[]): Spawned => {
    const child = spawn(BIN, args, { cwd: dir, env });
    t.after(() => child.kill());
    const exited = once(child, "exit");
    let out = "";
    child.stdout.setEncoding("utf8");
    const url = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const found = /follow-me (?:code )?review: (http:\/\/\S+)\n/.exec(out)?.[1];
        if (found !== undefined) resolve(found);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code} before listening: ${out}`)));
    });
    return { child, url, out: () => out, exited };
  };
  return { home, run, runAsync, spawnCli };
}

function serverRecord(home: string): { pid: number; port: number } | null {
  const path = join(home, "server.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until the condition holds, failing after a bounded wait. */
async function eventually(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const SESSION_URL = /^follow-me review: (http:\/\/127\.0\.0\.1:(\d+)\/s\/[0-9a-f]{12}\/)$/m;

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

/** The agent's fix: one edit to src/lib.js, committed on the original branch. */
function editLib(dir: string, from: string, to: string): void {
  const file = join(dir, "src", "lib.js");
  writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  git(dir, "commit", "-q", "-am", "fix: say what went wrong");
}

test("extract, check, apply and status drive the whole flow from the command line", async (t) => {
  const { run } = cliIn(t);
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
      "next: follow-me prompt, or follow-me plan --naive",
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
  const failed = failing.out.split("\n");
  assert.deepEqual(
    [failed[0], ...failed.slice(-2)],
    [
      `${readme}:3-5 (README.md) is in no commit`,
      "next: fix .follow-me/feature/draft.json, then follow-me check",
      "",
    ],
  );

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
      "syntax: 4 writes checked, 2 files skipped (no checker for .md, no checker for .txt)",
      "next: follow-me apply",
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
      "signing: off",
      `proof: feature-split^{tree} ${tree} equals feature^{tree} ${tree}`,
      "next: follow-me review",
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
      "writes to: feature-split",
      "lock: free",
      "units: 9 units",
      "draft: .follow-me/feature/draft.json",
      "plans: v1",
      "reviews: none",
      "signing: off",
      `applied: plan v1 as feature-split at ${head.slice(0, 12)}`,
      "",
    ].join("\n"),
    err: "",
  });
  assert.deepEqual(run(repo.dir, "report"), {
    code: 1,
    out: "",
    err: "follow-me: no review is open and none has ended; run `follow-me review` first\n",
  });
  const prompt = run(repo.dir, "prompt");
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /^# follow-me: plan the commits\n/);
  assert.match(prompt.out, /## Previous plan/);
});

test("check and apply refuse a commit that ends inside a function, until --allow-syntax-errors", async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const guard = [...diff.units.values()].find((u) => u.path === "src/guard.js")?.id;
  assert.ok(guard);
  const others = [...diff.units.keys()].filter((id) => id !== guard);
  const commits = [
    { message: "feat: open assertNumber", units: [`${guard}:0-1`] },
    { message: "feat: close it, then the rest", units: [guard, ...others] },
  ];
  writeFileSync(
    join(repo.dir, ".follow-me", "feature", "draft.json"),
    JSON.stringify({ schema: "follow-me/plan@1", base: repo.base, tip: repo.branch, commits }),
  );

  const checked = run(repo.dir, "check");
  assert.equal(checked.code, 1);
  assert.match(
    checked.out,
    /^\$\.commits\[0\]: src\/guard\.js: line 3: SyntaxError: Unexpected end of input\n/m,
  );
  const refused = run(repo.dir, "apply");
  assert.equal(refused.code, 1);
  assert.match(
    refused.out,
    /\nrefusing to apply: fix the commits above, or pass --allow-syntax-errors\n$/,
  );
  assert.equal(git(repo.dir, "branch", "--list", "feature-split"), "");

  const allowed = run(repo.dir, "apply", "--allow-syntax-errors");
  assert.equal(allowed.code, 0, allowed.err);
  assert.match(allowed.out, /^warning: \$\.commits\[0\]: src\/guard\.js: line 3: /);
  assert.match(allowed.out, /\nproof: feature-split\^\{tree\} (\w+) equals feature\^\{tree\} \1\n/);
});

test("plan --naive writes one commit per file, and check and apply accept it", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);

  const planned = run(repo.dir, "plan", "--naive");
  assert.deepEqual(planned, {
    code: 0,
    out: "wrote .follow-me/feature/draft.json (8 commits)\nnext: follow-me apply\n",
    err: "",
  });
  const checked = run(repo.dir, "check");
  assert.equal(checked.code, 0, checked.out);
  assert.deepEqual(checked.out.split("\n").slice(1, 9), [
    "  1  wip: README.md  (1 unit, 1 file)",
    "  2  wip: assets/logo.bin (binary)  (1 unit, 1 file)",
    "  3  wip: notes.txt  (1 unit, 1 file)",
    "  4  wip: scripts/run.sh (mode)  (1 unit, 1 file)",
    "  5  wip: src/guard.js  (1 unit, 1 file)",
    "  6  wip: src/lib.js  (2 units, 1 file)",
    "  7  wip: src/new-name.js  (1 unit, 1 file)",
    "  8  wip: src/old-name.js  (1 unit, 1 file)",
  ]);
  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /\nproof: feature-split\^\{tree\} (\w+) equals feature\^\{tree\} \1\n/);
  assert.equal(run(repo.dir, "plan", "--naive", "--walk").code, 1);
});

test("plan without --naive says there is no built-in planner", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.deepEqual(run(repo.dir, "plan"), {
    code: 1,
    out: "",
    err: "follow-me plan: there is no built-in model planner; your coding agent writes the draft from `follow-me prompt`, or use --naive for one commit per file\n",
  });
});

test("each step of a review names the next one, ending with report for the agent", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  assert.deepEqual(run(repo.dir, "check"), {
    code: 1,
    out: "",
    err: "follow-me: no draft at .follow-me/feature/draft.json yet; your coding agent writes it from `follow-me prompt`, or `follow-me plan --naive` writes one commit per file\n",
  });
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);

  const served = spawnCli(repo.dir, "review", "--no-open", "--port", "0");
  const url = await served.url;
  await fetch(new URL("api/end", url), { method: "POST" });
  assert.deepEqual(await served.exited, [0, null]);
  assert.deepEqual(served.out().split("\n").slice(1, 3), [
    "review v1 saved with 0 comments",
    "next: follow-me report",
  ]);
  const report = run(repo.dir, "report");
  assert.equal(report.code, 0, report.err);
  assert.equal(report.out, "# Review of plan v1\n\nNo comments.\n");
  const old = run(repo.dir, "feedback");
  assert.deepEqual(
    [old.code, old.out, old.err],
    [0, report.out, "follow-me: feedback is now report; printing the same\n"],
  );
  assert.equal(run(repo.dir, "report", "--json").out, "[]\n");
});

test("--version, --help and a directory outside any repo answer like other CLIs", (t) => {
  const { run } = cliIn(t);
  const outside = mkdtempSync(join(tmpdir(), "follow-me-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(run(outside, "--version"), {
    code: 0,
    out: `follow-me ${pkg.version}\n`,
    err: "",
  });
  for (const flag of ["--help", "-h", "help"]) {
    const help = run(outside, flag);
    assert.deepEqual([help.code, help.err], [0, ""]);
    assert.equal(help.out.split("\n")[0], "usage: follow-me [--wait <seconds>] [--branch <name>]");
    assert.equal(help.out.includes("\n  extract "), false);
    assert.equal(help.out.includes("\n  reply "), true);
  }
  const all = run(outside, "help", "--all");
  assert.equal(all.out.split("\n")[0], "usage: follow-me <command> [options]");
  assert.equal(all.out.includes("\n  extract "), true);
  assert.deepEqual(run(outside, "extract"), {
    code: 1,
    out: "",
    err: "follow-me: not a git repository (run it inside the repo you want to split)\n",
  });
});

test("split without a draft writes the prompt and hands off", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const tip = repo.branch.slice(0, 12);
  const base = repo.base.slice(0, 12);
  assert.deepEqual(run(repo.dir, "split", "--no-open"), {
    code: 1,
    out: [
      `feature ${tip} onto main ${base}: 8 files, 9 units`,
      "no draft for feature yet.",
      "Have your coding agent follow .follow-me/feature/prompt.md and write .follow-me/feature/draft.json, then run:",
      "  follow-me check",
      "  follow-me split",
      "next: hand .follow-me/feature/prompt.md to your agent",
      "",
    ].join("\n"),
    err: "",
  });
  const prompt = readFileSync(join(repo.dir, ".follow-me", "feature", "prompt.md"), "utf8");
  assert.equal(prompt.split("\n")[0], "# follow-me: plan the commits");
});

test("split with a valid draft applies it and hosts the review in the background", async (t) => {
  const { home, run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const split = run(repo.dir, "split", "--no-open");
  assert.equal(split.code, 0, split.err);
  const head = git(repo.dir, "rev-parse", "feature-split");
  const tree = git(repo.dir, "rev-parse", "feature^{tree}");
  const record = serverRecord(home);
  assert.ok(record, "split leaves a review server running");
  const out = split.out.split("\n");
  const [, url] = SESSION_URL.exec(split.out) ?? [];
  assert.ok(url);
  assert.match(out[1] ?? "", /^ok: 1 commit, plan [0-9a-f]{12}$/);
  assert.deepEqual(out.slice(2), [
    "  1  feat: everything  (9 units, 8 files)",
    `created feature-split at ${head.slice(0, 12)} from plan v1 (1 commit)`,
    "signing: off",
    `proof: feature-split^{tree} ${tree} equals feature^{tree} ${tree}`,
    `follow-me review: ${url}`,
    "next: end the review on the page, then follow-me report",
    "",
  ]);
  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.deepEqual([state.mode, state.version], ["split", 1]);
  assert.equal(new URL(url).port, String(record.port));
});

test("review --wait returns once the review attached to ends", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);
  assert.equal(run(repo.dir, "review", "--detach", "--no-open").code, 0);

  const timedOut = run(repo.dir, "review", "--wait", "--no-open", "--timeout", "0.3");
  assert.deepEqual(
    [timedOut.code, timedOut.err],
    [
      1,
      "follow-me: the review is still open after 0.3s; run `follow-me review --wait` again to keep waiting\n",
    ],
  );
  const waiting = spawnCli(repo.dir, "review", "--wait", "--no-open");
  const url = await waiting.url;
  const ended = await fetch(new URL("api/end", url), { method: "POST" });
  assert.equal(ended.status, 200);
  assert.deepEqual(await waiting.exited, [0, null]);
  assert.deepEqual(waiting.out().split("\n"), [
    `follow-me review: ${url}`,
    "review v1 saved with 0 comments",
    "next: follow-me report",
    "",
  ]);
  assert.equal(run(repo.dir, "report").code, 0);
});

test("prompt --walk writes for a reviewer and names the branch in the check command", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "checkout", "-q", "main");
  const prompt = run(repo.dir, "prompt", "--walk", "--branch", "feature");
  assert.equal(prompt.code, 0, prompt.err);
  assert.match(prompt.out, /^# follow-me: tell the story of this branch\n/);
  assert.ok(
    prompt.out.includes('"Writing the draft" in the follow-me skill says, in reviewer mode.'),
  );
  assert.ok(prompt.out.includes("- check: follow-me check --branch feature\n"));
});

test("walk without a plan prints the two commands to run instead", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.deepEqual(run(repo.dir, "walk", "--no-open"), {
    code: 1,
    out: [
      "no plan for feature yet.",
      "Have a coding agent follow the prompt, then review again:",
      "  follow-me prompt --walk",
      "  follow-me review",
      "",
    ].join("\n"),
    err: "follow-me: walk is now review; running review\n",
  });

  writeFileSync(join(repo.dir, "notes.txt"), "moved\n");
  git(repo.dir, "commit", "-qam", "move");
  const moved = run(repo.dir, "review", "--no-open", "--branch", "feature");
  assert.equal(moved.code, 1);
  const lines = moved.out.split("\n");
  assert.equal(
    lines[0],
    `feature moved, re-extracted at ${git(repo.dir, "rev-parse", "--short=12", "HEAD")}`,
  );
  assert.deepEqual(lines.slice(-3), [
    "  follow-me prompt --walk --branch feature",
    "  follow-me review --branch feature",
    "",
  ]);
});

test("review without an applied split is a reviewer's code review, saved beside the author's", async (t) => {
  const { home, run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const port = await freePort();
  const reviewer = spawnCli(repo.dir, "review", "--no-open", "--port", String(port));
  const url = await reviewer.url;
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/s/[0-9a-f]{12}/$`));
  assert.equal(serverRecord(home)?.pid, reviewer.child.pid);
  assert.equal(existsSync(join(repo.dir, ".follow-me", "feature", "applied.json")), false);

  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.mode, "walk");
  assert.equal(state.commits[0].narration, "I write it all at once.");
  const ended = await fetch(new URL("api/end", url), { method: "POST" });
  assert.equal(ended.status, 200);
  const [code] = await reviewer.exited;
  assert.equal(code, 0);
  assert.equal(
    reviewer.out().split("\n").slice(1, 3).join("\n"),
    "review v1 saved with 0 comments\nnext: follow-me report",
  );
  assert.equal(existsSync(join(home, "server.json")), false);
  const review = JSON.parse(
    readFileSync(join(repo.dir, ".follow-me", "feature", "reviews", "v1.json"), "utf8"),
  );
  assert.equal(review.mode, "walk");
  assert.equal(review.planVersion, 1);
  assert.equal(
    run(repo.dir, "report").out,
    "# Code review: feature (1 commit, no issues)\n\nThe reviewer raised no issues.\n",
  );
});

test("a code review stored in the old reviews/walk slot is still read by feedback --walk", async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "check").code, 0);
  assert.equal(run(repo.dir, "apply").code, 0);
  const slot = join(repo.dir, ".follow-me", "feature", "reviews", "walk");
  mkdirSync(slot, { recursive: true });
  writeFileSync(
    join(slot, "v1.json"),
    JSON.stringify({
      schema: "follow-me/review@1",
      mode: "walk",
      planVersion: 1,
      planHash: "x",
      endedAt: "2026-01-01T00:00:00.000Z",
      comments: [],
    }),
  );
  const old = run(repo.dir, "feedback", "--walk");
  assert.equal(old.code, 0, old.err);
  assert.equal(old.out.split("\n")[0], "# Code review: feature (1 commit, no issues)");
  assert.equal(
    run(repo.dir, "status").out.split("\n").includes("code reviews: v1 (latest has 0 comments)"),
    true,
  );
});

function writeTwoCommitDraft(dir: string, base: string, tip: string, ids: readonly string[]) {
  const [first, ...rest] = ids;
  assert.ok(first);
  const commits = [
    { message: "docs: readme", units: [first] },
    { message: "feat: everything else", units: rest },
  ];
  writeFileSync(
    join(dir, ".follow-me", "feature", "draft.json"),
    JSON.stringify({ schema: "follow-me/plan@1", base, tip, commits, responses: [] }),
  );
}

/** %G? per split commit, oldest first: G is a good signature, N is none. */
function signatures(dir: string, branch = "feature-split"): string {
  return git(dir, "log", "--reverse", "--format=%G?", `main..${branch}`);
}

function verifies(dir: string, commit: string): boolean {
  return spawnSync("git", ["verify-commit", commit], { cwd: dir }).status === 0;
}

const NO_SSH = sshSigningUnavailable() ?? false;

test("apply signs the split when the repo signs commits", { skip: NO_SSH }, async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  signWithSsh(repo, "ed25519");
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeTwoCommitDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  const head = git(repo.dir, "rev-parse", "feature-split");
  const tree = git(repo.dir, "rev-parse", "feature^{tree}");
  assert.equal(
    applied.out,
    [
      `created feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
      "signing: on (ssh)",
      `proof: feature-split^{tree} ${tree} equals feature^{tree} ${tree}`,
      "next: follow-me review",
      "",
    ].join("\n"),
  );
  assert.equal(signatures(repo.dir), "G\nG");
  const commits = git(repo.dir, "rev-list", "main..feature-split").split("\n");
  assert.deepEqual(
    commits.map((c) => verifies(repo.dir, c)),
    [true, true],
  );

  const again = run(repo.dir, "apply");
  assert.equal(
    again.out.split("\n")[0],
    `unchanged feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
  );
  assert.equal(git(repo.dir, "rev-parse", "feature-split"), head);
  assert.match(run(repo.dir, "status").out, /^signing: on \(ssh\)$/m);

  const unsigned = run(repo.dir, "apply", "--no-sign");
  assert.equal(unsigned.code, 0, unsigned.err);
  assert.deepEqual(unsigned.out.split("\n").slice(0, 2), [
    `updated feature-split at ${git(repo.dir, "rev-parse", "feature-split").slice(0, 12)} from plan v1 (2 commits)`,
    "signing: off",
  ]);
  assert.equal(signatures(repo.dir), "N\nN");
  assert.equal(git(repo.dir, "rev-parse", "feature-split^{tree}"), tree);
});

test("re-applying a signed split whose signatures differ per run is a no-op", {
  skip: NO_SSH,
}, async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  signWithSsh(repo, "ecdsa");
  git(repo.dir, "config", "commit.gpgsign", "false");
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeTwoCommitDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  assert.equal(run(repo.dir, "apply").out.split("\n")[1], "signing: off");
  assert.equal(signatures(repo.dir), "N\nN");
  assert.match(run(repo.dir, "status").out, /^signing: off$/m);

  const signed = run(repo.dir, "apply", "--sign");
  assert.equal(signed.code, 0, signed.err);
  const head = git(repo.dir, "rev-parse", "feature-split");
  assert.deepEqual(signed.out.split("\n").slice(0, 2), [
    `updated feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
    "signing: on (ssh)",
  ]);
  assert.equal(signatures(repo.dir), "G\nG");

  assert.equal(
    run(repo.dir, "apply", "--sign").out.split("\n")[0],
    `unchanged feature-split at ${head.slice(0, 12)} from plan v1 (2 commits)`,
  );
  assert.equal(git(repo.dir, "rev-parse", "feature-split"), head);

  assert.equal(run(repo.dir, "apply", "--sign", "--name", "feature-split-2").code, 0);
  assert.notEqual(
    git(repo.dir, "rev-parse", "feature-split-2"),
    head,
    "the same plan signed twice gives different commits",
  );
  assert.equal(signatures(repo.dir, "feature-split-2"), "G\nG");
  assert.deepEqual(run(repo.dir, "apply", "--sign", "--no-sign"), {
    code: 1,
    out: "",
    err: "follow-me: --sign and --no-sign cannot be used together\n",
  });
});

test("apply never writes the branch being split, even with --force", async (t) => {
  const { run } = cliIn(t);
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

test("two worktrees of one repo apply their own splits at the same time", async (t) => {
  const { run, runAsync } = cliIn(t);
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

test("while the server hosts a review, apply writes under the server and review prints the same page", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);

  const served = spawnCli(repo.dir, "review", "--no-open", "--port", "0");
  const url = await served.url;
  const pid = served.child.pid;
  // The plan is unchanged, so apply leaves the branch and finds the page already on v1.
  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  assert.ok(applied.out.includes(`plan v1 is already open: ${url}\n`));
  assert.deepEqual(run(repo.dir, "review", "--no-open"), {
    code: 0,
    out: `follow-me review: ${url}\nnext: end the review on the page, then follow-me report\n`,
    err: "",
  });
  assert.deepEqual(run(repo.dir, "status").out.split("\n").slice(2, 4), [
    `lock: held by pid ${pid} (follow-me review)`,
    `review page: ${url}`,
  ]);

  await fetch(new URL("api/end", url), { method: "POST" });
  assert.deepEqual(await served.exited, [0, null]);
  assert.equal(run(repo.dir, "apply").code, 0);
  assert.equal(existsSync(join(repo.dir, ".follow-me", "feature", "lock")), false);
});

test("a lock left by a dead process is taken over", async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  const dead = spawnSync("true").pid;
  const lock = join(repo.dir, ".follow-me", "feature", "lock");
  writeFileSync(lock, JSON.stringify({ pid: dead, command: "apply", token: "x" }));
  assert.equal(
    run(repo.dir, "status").out.split("\n")[2],
    `lock: stale, pid ${dead} (follow-me apply) is gone; follow-me clean removes it`,
  );

  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  assert.equal(applied.out.split(" ")[0], "created");
  assert.equal(existsSync(lock), false);
});

test("clean removes what no session can use and nothing else", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "branch", "gone", "feature");
  assert.equal(run(repo.dir, "extract", "--branch", "gone").code, 0);
  git(repo.dir, "branch", "-D", "-q", "gone");
  assert.equal(run(repo.dir, "extract").code, 0);
  const dead = spawnSync("true").pid;
  const session = join(repo.dir, ".follow-me", "feature");
  mkdirSync(join(session, "reviews"));
  for (const name of ["v1.json", "v1.draft.json", "v2.draft.json"]) {
    writeFileSync(join(session, "reviews", name), "{}");
  }
  writeFileSync(join(session, "lock"), JSON.stringify({ pid: dead, command: "review" }));
  writeFileSync(join(session, `draft.json.${dead}.0f.tmp`), "{");
  writeFileSync(join(session, `draft.json.${process.pid}.0f.tmp`), "{");
  mkdirSync(join(repo.dir, ".git", "objects", `follow-me-incoming-${dead}-abcdef`));

  const leftovers = [
    ".follow-me/feature/lock",
    `.follow-me/feature/draft.json.${dead}.0f.tmp`,
    ".follow-me/feature/reviews/v1.draft.json",
    ".follow-me/gone",
    `.git/objects/follow-me-incoming-${dead}-abcdef`,
    "",
  ].join("\n");
  assert.deepEqual(run(repo.dir, "clean", "--dry-run"), { code: 0, out: leftovers, err: "" });
  assert.equal(existsSync(join(repo.dir, ".follow-me", "gone")), true);
  assert.deepEqual(run(repo.dir, "clean"), { code: 0, out: leftovers, err: "" });
  assert.deepEqual(run(repo.dir, "clean"), { code: 0, out: "", err: "" });
  assert.deepEqual(readdirSync(join(session, "reviews")).sort(), ["v1.json", "v2.draft.json"]);

  assert.deepEqual(run(repo.dir, "clean", "--all"), { code: 0, out: ".follow-me\n", err: "" });
  assert.equal(existsSync(join(repo.dir, ".follow-me")), false);
});

function pairs(main: string, worktree: string): [string, string][] {
  return [
    [main, "feature"],
    [worktree, "other"],
  ];
}

/** A fixture repo plus a linked worktree on branch other, each with an applied one-commit plan. */
async function twoSessions(t: TestContext, run: (dir: string, ...args: string[]) => unknown) {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const outside = mkdtempSync(join(tmpdir(), "follow-me-worktree-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const worktree = join(outside, "other");
  git(repo.dir, "worktree", "add", "-q", "-b", "other", worktree, "main");
  writeFileSync(join(worktree, "notes.txt"), "other work\n");
  git(worktree, "commit", "-qam", "other work");
  for (const [dir, branch] of pairs(repo.dir, worktree)) {
    run(dir, "extract");
    const diff = await loadDiff(dir, "main", branch);
    const commits = [{ message: `feat: ${branch}`, units: [...diff.units.keys()] }];
    writeFileSync(
      join(dir, ".follow-me", branch, "draft.json"),
      JSON.stringify({ schema: "follow-me/plan@1", base: diff.base, tip: diff.tip, commits }),
    );
    run(dir, "apply");
  }
  return { repo, worktree };
}

test("two sessions share one server: detached first, attached second, both saved", async (t) => {
  const { home, run } = cliIn(t);
  const { repo, worktree } = await twoSessions(t, run);

  const first = run(repo.dir, "review", "--detach", "--no-open");
  assert.equal(first.code, 0, first.err);
  const record = serverRecord(home);
  assert.ok(record, "the detached server wrote server.json");
  const [, featureUrl, port] = SESSION_URL.exec(first.out) ?? [];
  assert.equal(Number(port), record.port);

  const second = run(worktree, "review", "--no-open");
  assert.equal(second.code, 0, second.err);
  const [, otherUrl, otherPort] = SESSION_URL.exec(second.out) ?? [];
  assert.equal(otherPort, port);
  assert.notEqual(otherUrl, featureUrl);
  assert.deepEqual(run(repo.dir, "review", "--no-open"), { code: 0, out: first.out, err: "" });

  assert.deepEqual(run(repo.dir, "server", "status").out.split("\n"), [
    `server pid ${record.pid} at http://127.0.0.1:${port}/ since ${JSON.parse(readFileSync(join(home, "server.json"), "utf8")).startedAt}`,
    `  ${featureUrl}  feature review of plan v1, 0 comments  ${realpathSync(repo.dir)}`,
    `  ${otherUrl}  other review of plan v1, 0 comments  ${realpathSync(worktree)}`,
    "",
  ]);

  for (const url of [featureUrl, otherUrl]) {
    assert.ok(url);
    const ended = await fetch(new URL("api/end", url), { method: "POST" });
    assert.equal(ended.status, 200);
  }
  for (const [dir, branch] of pairs(repo.dir, worktree)) {
    const review = JSON.parse(
      readFileSync(join(dir, ".follow-me", branch, "reviews", "v1.json"), "utf8"),
    );
    assert.deepEqual([review.mode, review.planVersion, review.comments], ["split", 1, []]);
  }
  await eventually("the idle server exits and removes server.json", () => {
    return !isAlive(record.pid) && !existsSync(join(home, "server.json"));
  });
});

test("a port held by another program falls back to a free one", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  t.after(() => blocker.close());
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  run(repo.dir, "extract");
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const served = spawnCli(repo.dir, "review", "--no-open", "--port", String(address.port));
  const url = await served.url;
  const used = new URL(url).port;
  assert.notEqual(used, String(address.port));
  assert.equal(
    served.out().split("\n")[0],
    `port ${address.port} is in use by another program, using ${used}`,
  );
  await fetch(new URL("api/end", url), { method: "POST" });
  assert.deepEqual(await served.exited, [0, null]);
});

test("server stop ends a detached server and releases the sessions it held", async (t) => {
  const { home, run } = cliIn(t);
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  t.after(() => blocker.close());
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  run(repo.dir, "extract");
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const started = run(repo.dir, "review", "--detach", "--no-open", "--port", String(address.port));
  assert.equal(started.code, 0, started.err);
  const record = serverRecord(home);
  assert.ok(record);
  assert.deepEqual(
    started.out.split("\n")[0],
    `port ${address.port} is in use by another program, using ${record.port}`,
  );
  assert.equal(
    run(repo.dir, "status").out.split("\n")[2],
    `lock: held by pid ${record.pid} (follow-me review)`,
  );

  assert.deepEqual(run(repo.dir, "server", "stop"), {
    code: 0,
    out: `stopped server pid ${record.pid}\n`,
    err: "",
  });
  assert.equal(isAlive(record.pid), false);
  assert.equal(existsSync(join(home, "server.json")), false);
  assert.equal(run(repo.dir, "status").out.split("\n")[2], "lock: free");
  assert.deepEqual(run(repo.dir, "server", "stop").out, "no server running\n");
  assert.deepEqual(run(repo.dir, "server", "status").out, "no server running\n");
});

const PLAN_COMMENT = {
  anchor: { kind: "plan" },
  context: { commitMessage: "", path: null },
  body: "Why one big commit?",
  kind: "question",
};

async function postJson(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function reviewing(t: TestContext) {
  const cli = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(cli.run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(cli.run(repo.dir, "apply").code, 0);
  const served = cli.spawnCli(repo.dir, "review", "--no-open", "--port", "0");
  const url = await served.url;
  const reviews = join(repo.dir, ".follow-me", "feature", "reviews");
  return { ...cli, repo, diff, served, url, reviews };
}

test("watch prints what the reviewer does and exits 0, and exits 2 when nothing happens", async (t) => {
  const { run, runAsync, repo, url } = await reviewing(t);

  const quiet = run(repo.dir, "watch", "--timeout", "0.4");
  assert.deepEqual(quiet, {
    code: 2,
    out: "",
    err: "follow-me: nothing new on the review page since event 0\n",
  });

  const watching = runAsync(repo.dir, "watch", "--json", "--timeout", "20");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const created = await postJson(url, "api/comments", PLAN_COMMENT);
  assert.equal(created.status, 201);
  const { id } = JSON.parse(await created.text());
  const seen = await watching;
  assert.equal(seen.code, 0, seen.err);
  const [line, ...more] = seen.out.trim().split("\n");
  assert.deepEqual(more, []);
  const event = JSON.parse(line ?? "");
  assert.equal(event.seq, 1);
  assert.equal(event.type, "comment");
  assert.equal(event.comment.id, id);
  assert.equal(event.comment.kind, "question");

  const digest = run(repo.dir, "watch", "--since", "0");
  assert.equal(digest.code, 0, digest.err);
  assert.ok(
    digest.out.startsWith(`- ${id} question on the whole plan\n  Why one big commit?\n`),
    digest.out,
  );
  assert.ok(digest.out.includes("next: follow-me reply <comment> --body <text>"));
  assert.ok(digest.out.includes("follow-me watch --since 1"));
  assert.equal(run(repo.dir, "watch", "--since", "x").code, 1);
});

test("explain starts an agent thread on the plan, a commit or picked lines, and watch does not echo it", async (t) => {
  const { run, repo, url, diff } = await reviewing(t);
  const state = async () => JSON.parse(await (await fetch(new URL("api/state", url))).text());

  const plan = run(repo.dir, "explain", "--body", "Start here: one commit, everything.");
  assert.equal(plan.code, 0, plan.err);
  assert.match(
    plan.out,
    /^explained c_[a-z2-7]{6}\nnext: run follow-me again; the reviewer is still working\n/,
  );
  const commit = run(repo.dir, "explain", "--commit", "1", "--body", "Why this is one commit.");
  assert.equal(commit.code, 0, commit.err);

  const hunk = [...diff.units.values()].find((u) => u.kind === "hunk");
  assert.ok(hunk && hunk.kind === "hunk");
  const file = join(repo.dir, "why.mmd");
  writeFileSync(file, "flowchart LR\n  a --> b\n");
  const lines = run(
    repo.dir,
    "explain",
    "--unit",
    hunk.id,
    "--lines",
    "0",
    "--body",
    "Look at this.",
    "--diagram",
    file,
  );
  assert.equal(lines.code, 0, lines.err);

  const { comments } = await state();
  assert.equal(comments.length, 3);
  assert.ok(comments.every((c: { author: string }) => c.author === "agent"));
  assert.deepEqual(comments[0].anchor, { kind: "plan" });
  assert.deepEqual(comments[1].anchor, { kind: "message", commit: 0 });
  assert.equal(comments[1].context.commitMessage, "feat: everything");
  const row = hunk.body.findIndex((l) => l.op !== " " && l.change === 0);
  assert.deepEqual(comments[2].anchor, {
    kind: "hunk",
    unit: hunk.id,
    commit: 0,
    changes: [0],
    offsets: [row],
  });
  assert.equal(comments[2].context.path, hunk.path);
  assert.equal(comments[2].diagram, "flowchart LR\n  a --> b\n");

  assert.equal(run(repo.dir, "watch", "--timeout", "0.3", "--json").code, 2);
  await postJson(url, "api/comments", PLAN_COMMENT);
  const woken = run(repo.dir, "watch", "--since", "0", "--json", "--timeout", "5");
  assert.equal(woken.code, 0, woken.err);
  assert.deepEqual(
    woken.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).seq),
    [4],
  );

  for (const bad of [
    ["--lines", "0"],
    ["--commit", "9"],
    ["--unit", "h_000000000000"],
    ["--unit", hunk.id, "--lines", "99"],
    ["--unit", hunk.id, "--lines", "3-1"],
  ]) {
    assert.equal(run(repo.dir, "explain", ...bad, "--body", "x").code, 1, bad.join(" "));
  }
  assert.equal(run(repo.dir, "explain").code, 1);
  assert.equal((await state()).comments.length, 4);
});

test("reply answers under a comment, watch skips the agent's own words, report shows both voices", async (t) => {
  const { run, repo, url, reviews, served } = await reviewing(t);
  const { id } = JSON.parse(await (await postJson(url, "api/comments", PLAN_COMMENT)).text());

  const file = join(repo.dir, "answer.mmd");
  writeFileSync(file, "flowchart LR\n  draft --> plan\n");
  const replied = run(
    repo.dir,
    "reply",
    id,
    "--body",
    "Everything lands at once.",
    "--diagram",
    file,
  );
  assert.equal(replied.code, 0, replied.err);
  assert.match(replied.out, new RegExp(`^replied r_[a-z2-7]{6} to ${id}\n`));
  assert.equal(run(repo.dir, "reply", "c_zzzzzz", "--body", "x").code, 1);
  assert.equal(run(repo.dir, "reply", id).code, 1);

  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.comments[0].replies[0].author, "agent");
  assert.equal(state.comments[0].replies[0].diagram, "flowchart LR\n  draft --> plan\n");

  // Event 1 is the comment and 2 the agent's reply; only the reviewer's words wake a watcher.
  assert.equal(run(repo.dir, "watch", "--since", "1", "--timeout", "0.3").code, 2);
  await postJson(url, `api/comments/${id}/replies`, { author: "reviewer", body: "Fair enough." });
  const woken = run(repo.dir, "watch", "--since", "1", "--json", "--timeout", "5");
  assert.equal(woken.code, 0, woken.err);
  const news = woken.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    news.map((e) => [e.seq, e.type, e.reply.author]),
    [[3, "reply", "reviewer"]],
  );

  const live = run(repo.dir, "report");
  assert.equal(live.code, 0, live.err);
  assert.ok(live.out.startsWith("# Review of plan v1\n"));
  assert.ok(
    live.out.includes(
      `## Questions\n\n### ${id} · whole plan\n\nReviewer asked: Why one big commit?\n`,
    ),
  );
  assert.ok(
    live.out.includes(
      "Agent replied: Everything lands at once.\n```mermaid\nflowchart LR\n  draft --> plan\n```\n",
    ),
  );
  assert.ok(live.out.includes("Reviewer replied: Fair enough.\n"));

  await fetch(new URL("api/end", url), { method: "POST" });
  assert.deepEqual(await served.exited, [0, null]);

  const saved = JSON.parse(readFileSync(join(reviews, "v1.json"), "utf8"));
  assert.deepEqual(
    saved.comments[0].replies.map((r: { author: string }) => r.author),
    ["agent", "reviewer"],
  );
  const after = run(repo.dir, "report");
  assert.equal(after.out, readFileSync(join(reviews, "v1.md"), "utf8"));
  assert.equal(after.out, live.out);
  assert.equal(run(repo.dir, "reply", id, "--body", "late").code, 1);
});

test("show expands a unit, a line in a commit, a concern and a comment thread", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const [first, second] = [...diff.units.values()].filter((u) => u.path === "src/lib.js");
  assert.ok(first?.kind === "hunk" && second !== undefined);
  const rest = [...diff.units.keys()].filter((id) => id !== first.id && id !== second.id);
  const concern = { severity: "minor", kind: "bug", text: "b may be a string.", lines: [3] };
  const commits = [
    { message: "Guard add", units: [{ unit: first.id, concerns: [concern] }] },
    { message: "The rest", units: [second.id, ...rest] },
  ];
  writeFileSync(
    join(repo.dir, ".follow-me", "feature", "draft.json"),
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: repo.base,
      tip: repo.branch,
      commits,
      responses: [],
    }),
  );
  assert.equal(run(repo.dir, "apply").code, 0);

  assert.equal(
    run(repo.dir, "show", first.id).out,
    [
      `${first.id}  src/lib.js  (4 change lines)`,
      "[0]+ import { assertNumber } from './guard.js';",
      "[1]+ ",
      "    export function add(a, b) {",
      "[2]+   assertNumber(a);",
      "[3]+   assertNumber(b);",
      "      return a + b;",
      "    }",
      "    ",
      `commit 1 takes ${first.id}:0-3`,
      "",
    ].join("\n"),
  );
  // Commit 1 guards add but leaves div alone; the tip has the division check.
  assert.equal(
    run(repo.dir, "show", "src/lib.js:18@1").out,
    "src/lib.js:18 in commit 1\n  15  }\n  16  \n  17  export function div(a, b) {\n> 18    return a / b;\n  19  }\n",
  );
  assert.match(run(repo.dir, "show", "src/lib.js:20").out, /^> 20 {4}if \(b === 0\)/m);
  assert.equal(
    run(repo.dir, "show", "src/lib.js:21@1").out,
    "src/lib.js has 19 lines in commit 1\n",
  );
  assert.equal(
    run(repo.dir, "show", "src/guard.js:1@base").out,
    "src/guard.js does not exist in the base\n",
  );
  const shownConcern = run(repo.dir, "show", "k_00000000");
  assert.equal(shownConcern.code, 1);
  assert.match(shownConcern.err, /no concern k_00000000/);

  const served = spawnCli(repo.dir, "review", "--no-open", "--port", "0");
  const url = await served.url;
  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  const kid = state.commits[0].concerns[0].id;
  assert.equal(
    run(repo.dir, "show", kid).out.split("\n").slice(-2).join("\n"),
    "b may be a string.\n",
  );
  assert.match(
    run(repo.dir, "show", kid).out,
    new RegExp(`^${kid} minor bug in commit 1, src/lib\\.js line 5\n`),
  );
  const { id } = JSON.parse(await (await postJson(url, "api/comments", PLAN_COMMENT)).text());
  run(repo.dir, "reply", id, "--body", "Each step is its own commit now.");
  assert.equal(
    run(repo.dir, "show", id).out,
    `${id} question on plan v1, on the whole plan\nreviewer: Why one big commit?\nagent replied: Each step is its own commit now.\n`,
  );
  assert.equal(run(repo.dir, "show", "c_zzzzzz").code, 1);
});

test("apply swaps the open page to the new plan in place and keeps the old comments", async (t) => {
  const { run, repo, url, reviews, served, diff } = await reviewing(t);
  const { id } = JSON.parse(await (await postJson(url, "api/comments", PLAN_COMMENT)).text());
  const answer = { comment: id, status: "answered", note: "It is one idea.", at: { commit: 1 } };
  const draftPath = join(repo.dir, ".follow-me", "feature", "draft.json");
  const commits = [
    {
      message: "feat: everything",
      narration: "I write it all at once.",
      units: [...diff.units.keys()],
    },
  ];
  writeFileSync(
    draftPath,
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: repo.base,
      tip: repo.branch,
      commits,
      responses: [answer],
    }),
  );

  const checked = run(repo.dir, "check");
  assert.equal(checked.code, 0, checked.out + checked.err);
  assert.ok(!checked.out.includes("warning"));

  const applied = run(repo.dir, "apply");
  assert.equal(applied.code, 0, applied.err);
  assert.ok(applied.out.includes(`\nfollow-me review: ${url}\n`));
  assert.ok(applied.out.includes("the page now shows plan v2; the comments on v1 are saved\n"));
  assert.ok(applied.out.endsWith("next: run follow-me again; the reviewer is still working\n"));

  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.version, 2);
  assert.deepEqual(state.comments, []);
  assert.equal(state.previous.version, 1);
  assert.equal(state.previous.comments[0].id, id);
  assert.deepEqual(state.previous.responses, [answer]);

  const old = JSON.parse(readFileSync(join(reviews, "v1.json"), "utf8"));
  assert.equal(old.mode, "split");
  assert.equal(old.comments[0].id, id);
  assert.equal(existsSync(join(reviews, "v1.draft.json")), false);
  const events = JSON.parse(
    await (await fetch(new URL("api/events?since=1&timeout=10", url))).text(),
  );
  assert.deepEqual(
    events.events.map((e: { type: string }) => e.type),
    ["version"],
  );

  // The same plan again changes nothing, and the server still owns the session.
  const again = run(repo.dir, "apply");
  assert.equal(again.code, 0, again.err);
  assert.ok(again.out.includes(`plan v2 is already open: ${url}\n`));
  assert.ok(run(repo.dir, "status").out.includes(`review page: ${url}`));

  await fetch(new URL("api/end", url), { method: "POST" });
  assert.deepEqual(await served.exited, [0, null]);
  assert.equal(JSON.parse(readFileSync(join(reviews, "v2.json"), "utf8")).comments.length, 0);
});

test("check counts the agent's concerns by severity and refuses a second one on a unit", async (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const all = [...diff.units.keys()];
  const draftPath = join(repo.dir, ".follow-me", "feature", "draft.json");
  const planWith = (concerns: unknown[]) =>
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: repo.base,
      tip: repo.branch,
      commits: [
        {
          message: "feat: everything",
          concerns: [{ severity: "minor", kind: "naming", text: "The title is vague." }],
          units: all.map((u, i) => (i === 0 ? { unit: u, concerns } : u)),
        },
      ],
      responses: [],
    });
  const one = { severity: "blocker", kind: "bug", text: "div never checks b." };

  writeFileSync(draftPath, planWith([one]));
  const ok = run(repo.dir, "check");
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.ok(ok.out.includes("\nconcerns: 1 blocker, 1 minor\n"));

  writeFileSync(draftPath, planWith([one, { ...one, text: "and add never checks a." }]));
  const two = run(repo.dir, "check");
  assert.equal(two.code, 1);
  assert.ok(two.out.includes(`${all[0]} has more than one concern, in commits 0;`));
});

test("watch --follow --json prints every event until the review ends, then exits 0", async (t) => {
  const { runAsync, repo, url, served } = await reviewing(t);
  await postJson(url, "api/comments", PLAN_COMMENT);
  const following = runAsync(repo.dir, "watch", "--follow", "--json");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await postJson(url, "api/comments", { ...PLAN_COMMENT, body: "And the second?" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fetch(new URL("api/end", url), { method: "POST" });
  const seen = await following;
  assert.equal(seen.code, 0, seen.err);
  const events = seen.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => [e.seq, e.type]),
    [
      [1, "comment"],
      [2, "comment"],
      [3, "ended"],
    ],
  );
  assert.equal(events[1].comment.body, "And the second?");
  assert.deepEqual(await served.exited, [0, null]);
});

test("follow-me with no command walks the states: prompt, issues, review, questions, report", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  mkdirSync(join(skillHome, ".claude"));
  const { run, runAsync } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  // The branch is the user's own, so the entry splits it instead of reviewing it as someone else's.
  git(repo.dir, "config", "user.email", "fixture@example.com");
  const sub = ".follow-me/feature";

  const first = run(repo.dir);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.out.split("\n"), [
    `wrote ${join(skillHome, ".claude", "skills", "follow-me", "SKILL.md")}`,
    `wrote ${join(skillHome, ".claude", "skills", "follow-me", "porting.md")}`,
    `wrote ${sub}/prompt.md`,
    `next: write ${sub}/draft.json from ${sub}/prompt.md, then run follow-me again`,
    "",
  ]);
  const prompt = readFileSync(join(repo.dir, sub, "prompt.md"), "utf8");
  assert.equal(prompt.split("\n")[0], "# follow-me: plan the commits");
  // Running it again changes nothing and the skill is not rewritten.
  assert.equal(run(repo.dir).out.split("\n")[0], `wrote ${sub}/prompt.md`);

  const diff = await loadDiff(repo.dir, "main", "feature");
  const ids = [...diff.units.keys()];
  writeWholeDraft(repo.dir, repo.base, repo.branch, ids.slice(1));
  const bad = run(repo.dir);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /is in no commit/);
  assert.equal(bad.out.endsWith("next: fix the draft, then run follow-me again\n"), true);

  writeWholeDraft(repo.dir, repo.base, repo.branch, ids);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(opened.code, 0, opened.err);
  const [, url] = SESSION_URL.exec(opened.out) ?? [];
  assert.ok(url, opened.out);
  assert.match(opened.out, /created feature-split at [0-9a-f]{12} from plan v1/);
  assert.equal(
    opened.out.endsWith(
      "follow-me is interactive: keep running it until it prints the report\nnext: the reviewer is still working; run follow-me again to keep listening\n",
    ),
    true,
    opened.out,
  );

  const anchor = { kind: "message", commit: 0 };
  const context = { commitMessage: "feat: everything", path: null };
  const comment = (body: string, more: object) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchor, context, body, ...more }),
  });
  await fetch(new URL("api/comments", url), comment("change this", { severity: "major" }));
  const flagged = run(repo.dir, "--wait", "0");
  assert.match(flagged.out, /change this/);

  // A question reaches a call that is already listening.
  const listening = runAsync(repo.dir, "--wait", "10");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fetch(new URL("api/comments", url), comment("why one commit?", { kind: "question" }));
  const heard = await listening;
  assert.equal(heard.code, 0, heard.err);
  assert.match(heard.out, /^- c_[a-z2-7]{6} question on the message of commit 1$/m);
  assert.match(heard.out, /why one commit\?/);
  assert.equal(heard.out.includes("change this"), false);
  assert.equal(
    heard.out.endsWith(
      'next: the reviewer is still working; answer with follow-me reply <id> --body "<markdown>" [--diagram file], then run follow-me again\n',
    ),
    true,
  );
  // The next call starts after what it already printed.
  assert.equal(
    run(repo.dir, "--wait", "0").out,
    "next: the reviewer is still working; run follow-me again to keep listening\n",
  );

  // A comment posted just before Submit is printed once, in the report that follows.
  await fetch(new URL("api/comments", url), comment("one more thing", { severity: "minor" }));
  await fetch(new URL("api/submit", url), { method: "POST" });
  const submitted = run(repo.dir, "--wait", "5");
  assert.equal(submitted.code, 0, submitted.err);
  assert.match(submitted.out, /the reviewer submitted the review/);
  assert.match(submitted.out, /change this/);
  assert.equal(submitted.out.split("one more thing").length, 2, submitted.out);
  assert.equal(
    submitted.out.endsWith("next: done; the user can port it with follow-me report --json\n"),
    true,
  );

  await fetch(new URL("api/end", url), { method: "POST" });
  const after = run(repo.dir, "--wait", "0");
  assert.equal(after.code, 0, after.err);
  assert.match(after.out, /^review v1 ended with 3 comments\n/);
  assert.match(after.out, /change this/);
  assert.equal(
    after.out.endsWith("next: done; the user can port it with follow-me report --json\n"),
    true,
  );
});

test("follow-me after the branch moved carries the plan over and asks only for the new units", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  const { run } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "config", "user.email", "fixture@example.com");
  const sub = ".follow-me/feature";
  const before = await loadDiff(repo.dir, "main", "feature");
  run(repo.dir, "extract");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...before.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);

  editLib(repo.dir, "division by zero", "cannot divide by zero");
  const tip = git(repo.dir, "rev-parse", "feature");
  const moved = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(moved.code, 0, moved.err);
  const handoff = `wrote ${sub}/prompt.md\nnext: assign the new units in ${sub}/draft.json, then run follow-me again\n`;
  assert.equal(moved.out.endsWith(handoff), true, moved.out);
  const draft = JSON.parse(readFileSync(join(repo.dir, sub, "draft.json"), "utf8"));
  assert.equal(draft.tip, tip);
  assert.equal(draft.commits[0].units.length, before.units.size - 1);
  const prompt = readFileSync(join(repo.dir, sub, "prompt.md"), "utf8");
  assert.match(prompt, /^## Changes since v1$/m);
  assert.match(prompt, /^- h_[0-9a-f]{12} {2}src\/lib\.js {2}was in commit 1$/m);
  assert.match(prompt, /cannot divide by zero/);
  // Only the new unit carries a body; the others are one line each, in their commit.
  assert.equal(prompt.includes("## Units\n"), false);
  assert.match(prompt, /^- h_[0-9a-f]{12} {2}README\.md {2}commit 1$/m);
  assert.equal(prompt.includes("[0]+ export function assertNumber(x) {"), false);
  // A second call before the agent acts says the same and keeps the draft.
  assert.equal(run(repo.dir, "--no-open", "--wait", "0").out.endsWith(handoff), true);

  const after = await loadDiff(repo.dir, "main", "feature");
  const added = [...after.units.keys()].filter((id) => !before.units.has(id));
  assert.equal(added.length, 1);
  draft.commits[0].units.push(...added);
  writeFileSync(join(repo.dir, sub, "draft.json"), JSON.stringify(draft));
  const applied = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /updated feature-split at [0-9a-f]{12} from plan v2/);
});

test("a fix the agent commits while the page is open swaps in with the threads carried", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  mkdirSync(join(skillHome, ".claude"));
  const { run } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "config", "user.email", "fixture@example.com");
  const sub = ".follow-me/feature";
  const before = await loadDiff(repo.dir, "main", "feature");
  run(repo.dir, "extract");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...before.units.keys()]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(opened.code, 0, opened.err);
  const [, url] = SESSION_URL.exec(opened.out) ?? [];
  assert.ok(url, opened.out);
  const skill = readFileSync(join(skillHome, ".claude", "skills", "follow-me", "SKILL.md"), "utf8");
  assert.deepEqual(skill.split("---\n")[2]?.split("\n").slice(0, 3), [
    "# follow-me",
    "follow-me is interactive. After it launches the review page, keep running `follow-me` until it prints the report. Each run waits up to 90 seconds for the reviewer.",
    "Do not stop, do not summarise, and do not ask the user whether to continue. The user is on the page.",
  ]);

  const units = [...before.units.values()];
  const [guarded] = units.filter((u) => u.path === "src/lib.js").slice(1);
  const readme = units.find((u) => u.path === "README.md");
  assert.ok(guarded?.kind === "hunk" && readme?.kind === "hunk");
  const guard = guarded.body.findIndex((r) => r.text.includes("division by zero"));
  const flag = async (unit: string, offsets: number[], path: string, body: string) => {
    const res = await fetch(new URL("api/comments", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor: { kind: "hunk", unit, commit: 0, changes: [], offsets },
        context: { commitMessage: "feat: everything", path },
        body,
        severity: "minor",
      }),
    });
    return JSON.parse(await res.text()).id;
  };
  const asked = await flag(guarded.id, [guard], "src/lib.js", "say what went wrong");
  const kept = await flag(readme.id, [0], "README.md", "fine as is");
  assert.match(run(repo.dir, "--wait", "0").out, /say what went wrong/);

  editLib(repo.dir, "division by zero", "cannot divide by zero");
  const moved = run(repo.dir, "--wait", "0");
  assert.equal(
    moved.out.endsWith(
      `next: assign the new units in ${sub}/draft.json, then run follow-me again; the reviewer is still working\n`,
    ),
    true,
    moved.out,
  );
  // The comment on the hunk that changed is quoted from the old hunk; the other is a ref.
  const replan = readFileSync(join(repo.dir, sub, "prompt.md"), "utf8").split(
    "## Open comments",
  )[1];
  assert.match(
    replan ?? "",
    new RegExp(`- ${asked} minor on src/lib\\.js:\\d+ .*"say what went wrong"\n`),
  );
  assert.match(replan ?? "", /> \+ {2}if \(b === 0\) throw new RangeError\('division by zero'\);/);
  assert.match(replan ?? "", new RegExp(`- ${kept} minor on README\\.md:1 .*"fine as is"\n?$`));
  const draft = JSON.parse(readFileSync(join(repo.dir, sub, "draft.json"), "utf8"));
  const after = await loadDiff(repo.dir, "main", "feature");
  const added = [...after.units.keys()].filter((id) => !before.units.has(id));
  draft.commits[0].units.push(...added);
  draft.responses = [
    { comment: asked, status: "addressed", note: "The error now says what went wrong." },
  ];
  writeFileSync(join(repo.dir, sub, "draft.json"), JSON.stringify(draft));

  const swapped = run(repo.dir, "--wait", "0");
  assert.equal(swapped.code, 0, swapped.err);
  assert.match(
    swapped.out,
    new RegExp(
      `swapped the open page to plan v2; carried 2 comments, 1 changed\n  ${asked} now on src/lib\\.js:20\n`,
    ),
  );
  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.version, 2);
  assert.deepEqual(
    state.carried.map(
      (c: { comment: { id: string }; unit: string; changed: boolean; newLine: number }) => [
        c.comment.id,
        c.unit,
        c.changed,
        c.newLine,
      ],
    ),
    [
      [asked, added[0], true, 20],
      [kept, readme.id, false, 1],
    ],
  );

  const replied = run(repo.dir, "reply", asked, "--body", "Changed the message in src/lib.js:20.");
  assert.equal(replied.code, 0, replied.err);
  const page = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.deepEqual(
    page.carried[0].comment.replies.map((r: { author: string; body: string }) => [
      r.author,
      r.body,
    ]),
    [["agent", "Changed the message in src/lib.js:20."]],
  );
  assert.equal(
    run(repo.dir, "--wait", "0").out,
    "next: the reviewer is still working; run follow-me again to keep listening\n",
  );
});

test("the report of a review that swapped twice lists everything said on every version, on the final tip", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  const { home, run } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "config", "user.email", "fixture@example.com");
  const sub = join(repo.dir, ".follow-me", "feature");
  const v1 = await loadDiff(repo.dir, "main", "feature");
  const units = [...v1.units.values()];
  const [head, guarded] = units.filter((u) => u.path === "src/lib.js");
  const readme = units.find((u) => u.path === "README.md");
  const notes = units.find((u) => u.path === "notes.txt");
  assert.ok(head && guarded && readme && notes);
  run(repo.dir, "extract");
  // The agent's concern sits on the first change of notes.txt, the reviewer's later flag on its last.
  const refs = units.map((u) =>
    u.id === notes.id
      ? {
          unit: u.id,
          concerns: [
            { severity: "major", kind: "risk", text: "the last line has no newline", lines: [0] },
          ],
        }
      : u.id,
  );
  writeFileSync(
    join(sub, "draft.json"),
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: repo.base,
      tip: repo.branch,
      commits: [{ message: "feat: everything", units: refs }],
      responses: [],
    }),
  );
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  const [, url] = SESSION_URL.exec(opened.out) ?? [];
  assert.ok(url, opened.out);
  const api = async (path: string, body?: object) => {
    const res = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    assert.equal(res.ok, true, `${path}: ${text}`);
    return JSON.parse(text);
  };
  const flag = async (unit: string, offset: number, path: string, body: string, severity: string) =>
    (
      await api("api/comments", {
        anchor: { kind: "hunk", unit, commit: 0, changes: [], offsets: [offset] },
        context: { commitMessage: "feat: everything", path },
        body,
        severity,
      })
    ).id;
  /** Commits the fix, lets follow-me carry the draft over, assigns the new units and swaps. */
  const fix = async (edit: () => void, version: number) => {
    const before = await loadDiff(repo.dir, "main", "feature");
    edit();
    run(repo.dir, "--wait", "0");
    const after = await loadDiff(repo.dir, "main", "feature");
    const draft = JSON.parse(readFileSync(join(sub, "draft.json"), "utf8"));
    draft.commits[0].units.push(...[...after.units.keys()].filter((id) => !before.units.has(id)));
    writeFileSync(join(sub, "draft.json"), JSON.stringify(draft));
    const swapped = run(repo.dir, "--wait", "0");
    assert.match(swapped.out, new RegExp(`swapped the open page to plan v${version};`));
  };

  // v1: a flag on the guard the agent will change, one on the README it leaves, a question, and
  // the agent's concern the reviewer keeps.
  const concern = (await api("api/state")).commits[0].concerns[0].id;
  const guard =
    guarded.kind === "hunk" ? guarded.body.findIndex((r) => r.text.includes("zero")) : -1;
  const changed = await flag(guarded.id, guard, "src/lib.js", "name the failure", "minor");
  const unchanged = await flag(readme.id, 3, "README.md", "reword the intro", "minor");
  const question = (
    await api("api/comments", {
      anchor: { kind: "plan" },
      context: { commitMessage: "feat: everything", path: null },
      body: "why one commit?",
      kind: "question",
    })
  ).id;
  await api(`api/concerns/${concern}`, { decision: "kept" });
  assert.equal(run(repo.dir, "reply", changed, "--body", "on it").code, 0);
  run(repo.dir, "--wait", "0");

  await fix(() => editLib(repo.dir, "division by zero", "cannot divide by zero"), 2);
  assert.equal(run(repo.dir, "reply", changed, "--body", "Changed the message.").code, 0);

  // The server dies on v2; the one that comes back keeps v1's threads in the session.
  const dead = serverRecord(home);
  assert.ok(dead);
  process.kill(dead.pid, "SIGKILL");
  await eventually("the server is gone", () => !isAlive(dead.pid));
  assert.equal(
    run(repo.dir, "--wait", "0").out.split("\n")[0],
    "review server restarted, nothing lost",
  );
  const restarted = await api("api/state");
  assert.deepEqual(
    restarted.carried.map((c: { comment: { id: string; replies?: unknown[] } }) => [
      c.comment.id,
      c.comment.replies?.length ?? 0,
    ]),
    [
      [changed, 2],
      [unchanged, 0],
      [question, 0],
    ],
  );

  // v2: a flag on lines no edit touches, and one on notes.txt, which the next fix reverts.
  const later = await flag(head.id, 3, "src/lib.js", "name the guard", "major");
  const doomed = await flag(notes.id, 3, "notes.txt", "end the file with a newline", "minor");
  await fix(() => {
    writeFileSync(join(repo.dir, "notes.txt"), "line one\nline two");
    editLib(repo.dir, "return a ** b;", "return Math.pow(a, b);");
  }, 3);

  // v3: the reviewer leaves a v1 flag out, resolves the v1 question and answers a v2 thread.
  await api("api/excluded", { comment: unchanged, excluded: true });
  await api("api/resolved", { comment: question, resolved: true });
  await api(`api/comments/${doomed}/replies`, { author: "reviewer", body: "never mind" });

  const flagged = (id: string, path: string | null, newLine: number | null, body: string) => ({
    id,
    path,
    oldPath: path,
    newLine,
    oldLine: null,
    startNewLine: null,
    startOldLine: null,
    kind: "flag",
    resolved: false,
    excluded: false,
    body,
  });
  const expected = [
    {
      ...flagged(unchanged, "README.md", 3, "**minor**\n\nreword the intro"),
      severity: "minor",
      thread: [],
      excluded: true,
    },
    {
      ...flagged(later, "src/lib.js", 4, "**major**\n\nname the guard"),
      severity: "major",
      thread: [],
    },
    {
      ...flagged(changed, "src/lib.js", 20, "**minor**\n\nname the failure"),
      severity: "minor",
      thread: [
        { author: "agent", body: "on it" },
        { author: "agent", body: "Changed the message." },
      ],
      changed: { since: 1, gone: false },
    },
    {
      ...flagged(concern, "notes.txt", null, "**major**\n\nthe last line has no newline"),
      kind: "concern",
      severity: "major",
      thread: [],
      changed: { since: 2, gone: true },
    },
    {
      ...flagged(doomed, "notes.txt", null, "**minor**\n\nend the file with a newline"),
      severity: "minor",
      thread: [{ author: "reviewer", body: "never mind" }],
      changed: { since: 2, gone: true },
    },
    {
      ...flagged(question, null, null, "why one commit?"),
      kind: "question",
      severity: null,
      thread: [],
      resolved: true,
    },
  ];
  assert.deepEqual(await api("api/report?format=json"), expected);
  assert.deepEqual(JSON.parse(run(repo.dir, "report", "--json").out), expected);

  await api("api/end", {});
  const ended = run(repo.dir, "--wait", "0");
  assert.equal(ended.code, 0, ended.err);
  const saved = run(repo.dir, "report");
  assert.equal(ended.out.includes(saved.out), true, ended.out);
  for (const body of [
    "reword the intro",
    "name the guard",
    "name the failure",
    "the last line has no newline",
    "end the file with a newline",
    "why one commit?",
    "Changed the message.",
    "never mind",
  ]) {
    assert.equal(saved.out.split(body).length, 2, `${body} once in:\n${saved.out}`);
  }
  assert.match(saved.out, /line 20 · the code changed after v1/);
  assert.equal(saved.out.split("the code is gone after v2").length, 3, saved.out);
  assert.deepEqual(JSON.parse(run(repo.dir, "report", "--json").out), expected);
  // Each version's review file holds what was said on it, and v1's stays as written at the swap.
  const v1Review = JSON.parse(readFileSync(join(sub, "reviews", "v1.json"), "utf8"));
  assert.deepEqual(
    v1Review.comments.map((c: { id: string }) => c.id),
    [changed, unchanged, question],
  );
  const v3Review = JSON.parse(readFileSync(join(sub, "reviews", "v3.json"), "utf8"));
  assert.deepEqual(v3Review.comments, []);
});

test("follow-me brings a killed server back on its port and prints only what the agent has not read", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  const { home, run } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "config", "user.email", "fixture@example.com");
  const diff = await loadDiff(repo.dir, "main", "feature");
  run(repo.dir, "extract");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  const [, url] = SESSION_URL.exec(opened.out) ?? [];
  assert.ok(url, opened.out);
  const send = async (path: string, body: object) => {
    const res = await fetch(new URL(path, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return JSON.parse(await res.text()).id;
  };
  const flag = (body: string) =>
    send("api/comments", {
      anchor: { kind: "message", commit: 0 },
      context: { commitMessage: "feat: everything", path: null },
      body,
    });
  const alpha = await flag("alpha");
  assert.match(run(repo.dir, "--wait", "0").out, /alpha/);
  await flag("bravo");
  await send(`api/comments/${alpha}/replies`, { author: "reviewer", body: "alpha, again" });

  const dead = serverRecord(home);
  assert.ok(dead);
  process.kill(dead.pid, "SIGKILL");
  await eventually("the server is gone", () => !isAlive(dead.pid));
  const back = run(repo.dir, "--wait", "0");
  assert.equal(back.code, 0, back.err);
  assert.equal(back.out.split("\n")[0], "review server restarted, nothing lost");
  assert.equal(serverRecord(home)?.port, dead.port);
  assert.match(back.out, /bravo/);
  assert.match(back.out, new RegExp(`${alpha} reviewer replied: alpha, again`));
  assert.equal(back.out.includes("\n  alpha\n"), false, back.out);

  await flag("charlie");
  const next = run(repo.dir, "--wait", "0");
  assert.match(next.out, /^- c_[a-z2-7]{6} \w+ on the message of commit 1\n {2}charlie\n/);
  assert.equal(next.out.includes("bravo"), false);

  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.deepEqual(
    state.comments.map((c: { body: string; replies?: { body: string }[] }) => [
      c.body,
      (c.replies ?? []).map((r) => r.body),
    ]),
    [
      ["alpha", ["alpha, again"]],
      ["bravo", []],
      ["charlie", []],
    ],
  );
});

test("follow-me on a branch someone else wrote plans a reviewer's reading and applies nothing", async (t) => {
  const skillHome = mkdtempSync(join(tmpdir(), "follow-me-skillhome-"));
  t.after(() => rmSync(skillHome, { recursive: true, force: true }));
  const { run } = cliIn(t, { HOME: skillHome });
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  git(repo.dir, "config", "user.email", "someone-else@example.com");
  const first = run(repo.dir);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out.split("\n")[0], "wrote .follow-me/feature/prompt.md");
  const prompt = readFileSync(join(repo.dir, ".follow-me", "feature", "prompt.md"), "utf8");
  assert.equal(prompt.split("\n")[0], "# follow-me: tell the story of this branch");

  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(opened.code, 0, opened.err);
  const [, url] = SESSION_URL.exec(opened.out) ?? [];
  assert.ok(url, opened.out);
  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.mode, "walk");
  assert.equal(git(repo.dir, "branch", "--list", "feature-split"), "");
});
