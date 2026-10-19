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

/** Without API credentials, so no test can reach the Anthropic API. */
const OFFLINE = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")),
);

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
function cliIn(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "follow-me-home-"));
  t.after(() => {
    const pid = serverRecord(home)?.pid;
    if (pid !== undefined && isAlive(pid)) process.kill(pid);
    rmSync(home, { recursive: true, force: true });
  });
  const env = { ...OFFLINE, FOLLOW_ME_HOME: home, FOLLOW_ME_IDLE_MS: "200" };
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
      "next: follow-me prompt, or follow-me plan with an Anthropic key",
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

test("each step of a review names the next one, ending with feedback for the agent", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  assert.deepEqual(run(repo.dir, "check"), {
    code: 1,
    out: "",
    err: "follow-me: no draft at .follow-me/feature/draft.json yet; your coding agent writes it from `follow-me prompt`, or `follow-me plan` has the Anthropic API write it\n",
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
    "next: follow-me feedback",
  ]);
  const feedback = run(repo.dir, "feedback");
  assert.equal(feedback.code, 0, feedback.err);
  assert.deepEqual(feedback.out.split("\n").slice(-3), [
    "",
    "next: hand this to your agent, then follow-me check",
    "",
  ]);
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
    assert.equal(help.out.split("\n")[0], "usage: follow-me <command> [options]");
  }
  assert.deepEqual(run(outside, "extract"), {
    code: 1,
    out: "",
    err: "follow-me: not a git repository (run it inside the repo you want to split)\n",
  });
});

test("split without a draft or API credentials writes the prompt and hands off", (t) => {
  const { run } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const tip = repo.branch.slice(0, 12);
  const base = repo.base.slice(0, 12);
  assert.deepEqual(run(repo.dir, "split", "--no-open"), {
    code: 1,
    out: [
      `feature ${tip} onto main ${base}: 8 files, 9 units`,
      "no draft for feature yet, and neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set to ask the API for one.",
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
    "next: end the review on the page, then follow-me feedback",
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
    "next: follow-me feedback",
    "",
  ]);
  assert.equal(run(repo.dir, "feedback").code, 0);
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
    prompt.out.includes("The reader is a reviewer meeting this branch for the first time."),
  );
  assert.ok(prompt.out.includes("Check your work with `follow-me check --branch feature`"));
});

test("walk without a plan or API credentials prints the two commands to run instead", (t) => {
  const { run } = cliIn(t);
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
  const { home, run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);
  assert.equal(run(repo.dir, "apply").code, 0);

  const port = await freePort();
  const walk = spawnCli(repo.dir, "walk", "--no-open", "--port", String(port));
  const url = await walk.url;
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/s/[0-9a-f]{12}/$`));
  assert.equal(serverRecord(home)?.pid, walk.child.pid);

  const state = JSON.parse(await (await fetch(new URL("api/state", url))).text());
  assert.equal(state.mode, "walk");
  assert.equal(state.commits[0].narration, "I write it all at once.");
  const ended = await fetch(new URL("api/end", url), { method: "POST" });
  assert.equal(ended.status, 200);
  const [code] = await walk.exited;
  assert.equal(code, 0);
  assert.equal(
    walk.out().split("\n").slice(1).join("\n"),
    [
      "code review saved to .follow-me/feature/reviews/v1.json with 0 comments",
      "next: follow-me feedback, which prints it as a code review for the author",
      "the server exits in 1s unless another review starts; ctrl-c stops it now",
      "",
    ].join("\n"),
  );
  assert.equal(existsSync(join(home, "server.json")), false);
  const review = JSON.parse(
    readFileSync(join(repo.dir, ".follow-me", "feature", "reviews", "v1.json"), "utf8"),
  );
  assert.equal(review.mode, "walk");
  assert.equal(review.planVersion, 1);
  assert.equal(
    run(repo.dir, "feedback").out,
    "# Code review\n\nThe reviewer left no comments.\n\nnext: hand this to the branch's author\n",
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

test("while the server hosts a review, apply waits and review prints the same page", async (t) => {
  const { run, spawnCli } = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  assert.equal(run(repo.dir, "extract").code, 0);
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeWholeDraft(repo.dir, repo.base, repo.branch, [...diff.units.keys()]);

  const served = spawnCli(repo.dir, "review", "--no-open", "--port", "0");
  const url = await served.url;
  const pid = served.child.pid;
  const busy = `follow-me: the session for feature is busy: pid ${pid} is running follow-me review; wait for it to finish or stop it\n`;
  assert.deepEqual(run(repo.dir, "apply"), { code: 1, out: "", err: busy });
  assert.deepEqual(run(repo.dir, "review", "--no-open"), {
    code: 0,
    out: `follow-me review: ${url}\nnext: end the review on the page, then follow-me feedback\n`,
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
