import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LcovError,
  parseCoverage,
  parseLcov,
  recordRun,
  runOf,
  serializeCoverage,
  tipPlacer,
} from "../src/coverage.ts";
import { isRepoPath, isSha } from "../src/diff.ts";
import { loadDiff } from "../src/git.ts";
import type { RepoPath } from "../src/types.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const BIN = fileURLToPath(new URL("../bin/follow-me.ts", import.meta.url));

function repoPath(p: string): RepoPath {
  assert.ok(isRepoPath(p));
  return p;
}

const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);
function sha(s: string) {
  assert.ok(isSha(s));
  return s;
}

/**
 * Runs the CLI with its own state dir and HOME, so no review server or skill copy of the user is
 * touched. A server the test leaves running is stopped when it ends.
 */
function cliIn(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "follow-me-home-"));
  t.after(() => {
    spawnSync(BIN, ["server", "stop"], { env: { ...process.env, FOLLOW_ME_HOME: home } });
    rmSync(home, { recursive: true, force: true });
  });
  return (dir: string, ...args: string[]) => {
    const r = spawnSync(BIN, args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: home, FOLLOW_ME_HOME: home, FOLLOW_ME_IDLE_MS: "200" },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
}

function writeDraft(dir: string, base: string, tip: string, commits: readonly unknown[]): void {
  writeFileSync(
    join(dir, ".follow-me", "feature", "draft.json"),
    JSON.stringify({ schema: "follow-me/plan@1", base, tip, commits, responses: [] }),
  );
}

async function getJson(url: string, path: string) {
  const res = await fetch(new URL(path, url));
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function lcov(dir: string, name: string, ...lines: string[]): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function readCoverage(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, ".follow-me", "feature", "coverage.json"), "utf8"));
}

test("lcov lines, partly taken branches and TN blocks parse; unknown records are skipped", () => {
  const records = parseLcov(
    [
      "VER:2.0",
      "TN:",
      "SF:src/a.js",
      "FN:1,f",
      "FNDA:3,f",
      "DA:1,3",
      "DA:2,0,abc",
      "BRDA:2,0,0,1",
      "BRDA:2,0,1,-",
      "BRDA:2,e0,2,0",
      "LF:2",
      "LH:1",
      "end_of_record",
      "TN:adds",
      "SF:src/a.js",
      "DA:1,1",
      "DA:2,1",
      "end_of_record",
    ].join("\r\n"),
  );
  assert.deepEqual(
    records.map((r) => ({ ...r, lines: [...r.lines], branches: [...r.branches] })),
    [
      {
        test: null,
        path: "src/a.js",
        lines: [
          [1, 3],
          [2, 0],
        ],
        branches: [
          [
            2,
            new Map([
              ["0,0", 1],
              ["0,1", 0],
              ["e0,2", 0],
            ]),
          ],
        ],
        functions: [{ name: "f", start: 1 }],
      },
      {
        test: "adds",
        path: "src/a.js",
        lines: [
          [1, 1],
          [2, 1],
        ],
        branches: [],
        functions: [],
      },
    ],
  );
  const run = runOf(records, (raw) => repoPath(raw));
  assert.deepEqual(
    [...run.files].map(([p, f]) => [p, [...f.lines], [...f.branches]]),
    [
      [
        "src/a.js",
        [
          [1, 4],
          [2, 1],
        ],
        [[2, [1, 3]]],
      ],
    ],
  );
  const tests = recordRun(null, run, { tip: sha(TIP), takenAt: "t" }).tests;
  assert.deepEqual(
    [...tests].map(([id, t]) => [id, [...t.lines]]),
    [["adds", [["src/a.js", [1, 2]]]]],
  );
});

/**
 * Real output of `node --test --experimental-test-coverage --test-reporter=lcov
 * --test-name-pattern '^<name>$'`, one run per test, over this module:
 *
 *   1 export function step(state, event) {
 *   2   if (state === "idle" && event === "submit") {
 *   3     return "checking";
 *   4   }
 *   5   if (state === "checking") {
 *   6     return event === "ok" ? "done" : "failed";
 *   7   }
 *   8   return state;
 *   9 }
 */
const FIXTURES = fileURLToPath(new URL("fixtures/lcov/", import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

test("per-test runs keep each test's branch counts and the file's functions, and round-trip", () => {
  const machine = repoPath("src/machine.js");
  const place = (raw: string) => (raw === "machine.js" ? machine : null);
  const tip = sha(TIP);
  const submits = runOf(parseLcov(fixture("submits.info")), place);
  const fails = runOf(parseLcov(fixture("fails.info")), place);
  const one = recordRun(null, submits, { tip, takenAt: "t1", test: { id: "submits" } });
  const both = recordRun(one, fails, { tip, takenAt: "t2", test: { id: "fails" } });

  const json = serializeCoverage(both);
  assert.deepEqual(json.files["src/machine.js"]?.functions, [{ name: "step", start: 1 }]);
  assert.deepEqual(json.tests, {
    submits: {
      lines: { "src/machine.js": [1, 2, 3, 4, 9] },
      branches: { "src/machine.js": { 1: [1, 1], 4: [0] } },
    },
    fails: {
      lines: { "src/machine.js": [1, 2, 5, 6, 7, 9] },
      branches: { "src/machine.js": { 1: [1, 1], 2: [0, 0], 6: [0], 7: [0] } },
    },
  });
  const back = parseCoverage(JSON.parse(JSON.stringify(json)));
  assert.ok(typeof back !== "string", String(back));
  assert.deepEqual(serializeCoverage(back), json);

  // One lcov with a TN block per test gives the same per-test detail.
  const blocks = `TN:submits\n${fixture("submits.info").replace(/^TN:\n/, "")}TN:fails\n${fixture("fails.info").replace(/^TN:\n/, "")}`;
  const plain = serializeCoverage(
    recordRun(null, runOf(parseLcov(blocks), place), { tip, takenAt: "t" }),
  );
  assert.deepEqual(plain.tests, json.tests);
  assert.deepEqual(plain.files["src/machine.js"]?.functions, [{ name: "step", start: 1 }]);
});

test("lcov 2 FN records carry the end line; a bad one names its line", () => {
  const [record] = parseLcov("SF:a.js\nFN:3,9,go\nFN:12,(anonymous_0)\nend_of_record\n");
  assert.deepEqual(record?.functions, [
    { name: "go", start: 3, end: 9 },
    { name: "(anonymous_0)", start: 12 },
  ]);
  assert.throws(() => parseLcov("SF:a.js\nFN:x\n"), /lcov line 2: FN needs <line>,<name>/);
  assert.throws(() => parseLcov("SF:a.js\nFN:9,3,go\n"), /lcov line 2: FN ends before it starts/);
  assert.equal(
    parseCoverage({
      tip: TIP,
      takenAt: "t",
      files: {},
      tests: { a: { lines: {}, branches: { "a.js": { 2: [1, -1] } } } },
    }),
    "test a: branches of a.js:2 are not counts",
  );
});

test("malformed lcov names the line that is wrong", () => {
  const fails = (text: string) => {
    try {
      parseLcov(text);
    } catch (error) {
      assert.ok(error instanceof LcovError);
      return error.message;
    }
    assert.fail("parsed");
  };
  assert.equal(fails("SF:a\nDA:1\n"), 'lcov line 2: DA needs <line>,<hits>, got "1"');
  assert.equal(fails("TN:\nDA:1,1\n"), "lcov line 2: DA comes before any SF");
  assert.equal(
    fails("SF:a\nBRDA:3,0,0\n"),
    'lcov line 2: BRDA needs <line>,<block>,<branch>,<taken>, got "3,0,0"',
  );
  assert.equal(fails('{ "total": {} }'), 'lcov line 1: "{ "total": {} }" is not an lcov record');
  assert.equal(fails("TN:\n"), "lcov line 2: no SF record; is this lcov?");
});

test("lcov paths become repo-relative at the tip; outside the repo or not at the tip they drop", (t) => {
  const root = mkdtempSync(join(tmpdir(), "follow-me-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "pkg", "src"), { recursive: true });
  writeFileSync(join(root, "pkg", "src", "a.js"), "");
  const atTip = new Set([repoPath("pkg/src/a.js"), repoPath("README.md")]);
  const place = tipPlacer(root, join(root, "pkg"), atTip);
  assert.equal(place(join(realpathSync(root), "pkg", "src", "a.js")), "pkg/src/a.js");
  assert.equal(place("src/a.js"), "pkg/src/a.js");
  assert.equal(place("README.md"), "README.md");
  assert.equal(place("src/generated.js"), null);
  assert.equal(place("/usr/lib/node/x.js"), null);
  assert.equal(place("../../elsewhere.js"), null);
});

test("a plain run replaces the last; --test runs add up until the next plain run", () => {
  const a = repoPath("src/a.js");
  const run = (lines: [number, number][]) =>
    runOf(
      [{ test: null, path: a, lines: new Map(lines), branches: new Map(), functions: [] }],
      (p) => repoPath(p),
    );
  const tip = sha(TIP);
  const plain = recordRun(
    null,
    run([
      [1, 5],
      [2, 0],
      [3, 2],
    ]),
    { tip, takenAt: "t1" },
  );
  const one = recordRun(
    plain,
    run([
      [1, 1],
      [2, 0],
      [3, 1],
    ]),
    {
      tip,
      takenAt: "t2",
      test: { id: "adds", at: { path: a, start: 9, end: 9 } },
    },
  );
  const two = recordRun(
    one,
    run([
      [1, 1],
      [2, 1],
      [3, 0],
    ]),
    { tip, takenAt: "t3", test: { id: "subs" } },
  );
  const view = (c: typeof two) => ({
    tip: c.tip,
    files: [...c.files].map(([p, f]) => [p, [...f.lines]]),
    tests: [...c.tests].map(([id, t]) => [id, t.at, [...t.lines]]),
  });
  assert.deepEqual(view(two), {
    tip: TIP,
    files: [
      [
        "src/a.js",
        [
          [1, 5],
          [2, 1],
          [3, 2],
        ],
      ],
    ],
    tests: [
      ["adds", { path: "src/a.js", start: 9, end: 9 }, [["src/a.js", [1, 3]]]],
      ["subs", undefined, [["src/a.js", [1, 2]]]],
    ],
  });
  const again = recordRun(two, run([[1, 0]]), { tip, takenAt: "t4" });
  assert.deepEqual(view(again), { tip: TIP, files: [["src/a.js", [[1, 0]]]], tests: [] });
  const moved = recordRun(two, run([[1, 1]]), {
    tip: sha(OTHER_TIP),
    takenAt: "t5",
    test: { id: "subs" },
  });
  assert.deepEqual(view(moved), {
    tip: OTHER_TIP,
    files: [["src/a.js", [[1, 1]]]],
    tests: [["subs", undefined, [["src/a.js", [1]]]]],
  });
});

test("follow-me coverage records the run at the tip and counts the changed lines it ran", async (t) => {
  const run = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  execFileSync("git", ["checkout", "-q", "feature"], { cwd: repo.dir });
  const tip = repo.branch;
  // Lines 4 and 5 of lib.js and 1 and 2 of guard.js are added; 3 and 6 are context.
  const aggregate = lcov(
    repo.dir,
    "coverage/lcov.info",
    "TN:",
    `SF:${join(repo.dir, "src", "lib.js")}`,
    "DA:3,2",
    "DA:4,2",
    "DA:5,0",
    "DA:6,2",
    "BRDA:20,0,0,1",
    "BRDA:20,0,1,0",
    "end_of_record",
    "SF:src/guard.js",
    "DA:1,2",
    "DA:2,2",
    "end_of_record",
    "SF:/usr/lib/node/internal.js",
    "DA:1,1",
    "end_of_record",
  );
  const first = run(repo.dir, "coverage", aggregate);
  assert.equal(first.code, 0, first.err);
  assert.equal(
    first.out,
    `coverage for 2 files at ${tip.slice(0, 12)}; 3 of 4 changed lines covered\n`,
  );
  const taken = readCoverage(repo.dir);
  assert.ok(typeof taken === "object" && taken !== null && "takenAt" in taken);
  assert.deepEqual(taken, {
    tip,
    takenAt: taken.takenAt,
    files: {
      "src/lib.js": { lines: { 3: 2, 4: 2, 5: 0, 6: 2 }, branches: { 20: [1, 2] } },
      "src/guard.js": { lines: { 1: 2, 2: 2 } },
    },
  });

  const one = lcov(
    repo.dir,
    "coverage/one.info",
    "SF:src/lib.js",
    "DA:4,1",
    "DA:5,1",
    "BRDA:4,0,0,1",
    "BRDA:4,0,1,0",
    "end_of_record",
  );
  const named = run(
    repo.dir,
    "coverage",
    one,
    "--test",
    "add rejects strings",
    "--at",
    "src/lib.js:3-7",
  );
  assert.equal(named.code, 0, named.err);
  // What this test ran is said apart from the total, which also holds the run before it.
  assert.equal(
    named.out,
    [
      'recorded test "add rejects strings": 2 changed lines, 1 branch',
      `running total of 1 test: coverage for 2 files at ${tip.slice(0, 12)}; 4 of 4 changed lines covered`,
      "",
    ].join("\n"),
  );
  const withTest = readCoverage(repo.dir);
  assert.ok(typeof withTest === "object" && withTest !== null && "tests" in withTest);
  assert.deepEqual(withTest.tests, {
    "add rejects strings": {
      at: { path: "src/lib.js", start: 3, end: 7 },
      lines: { "src/lib.js": [4, 5] },
      branches: { "src/lib.js": { 4: [1, 0] } },
    },
  });

  writeFileSync(join(repo.dir, "src", "guard.js"), "export {};\n");
  const dirty = run(repo.dir, "coverage", aggregate);
  assert.equal(dirty.code, 1);
  assert.equal(
    dirty.err,
    "follow-me: coverage must be taken on the tip; these files differ: src/guard.js\n",
  );
  assert.deepEqual(readCoverage(repo.dir), withTest);

  lcov(repo.dir, "coverage/elsewhere.info", "SF:lib/x.js", "DA:1,1", "end_of_record");
  assert.equal(
    run(repo.dir, "coverage", "coverage/elsewhere.info").err,
    "follow-me: none of the 1 file in coverage/elsewhere.info is in feature at the tip; run follow-me coverage from the directory the tests ran in\n",
  );
  const bad = lcov(repo.dir, "coverage/bad.info", "SF:src/lib.js", "DA:four,1");
  assert.equal(
    run(repo.dir, "coverage", bad).err,
    'follow-me: lcov line 2: DA needs <line>,<hits>, got "four,1"\n',
  );
  assert.equal(
    run(repo.dir, "coverage", one, "--at", "src/lib.js:3").err,
    "follow-me: --at needs --test\nusage: follow-me coverage <lcov> [--test <id> [--at <path:line>]] [--reset]\n       follow-me coverage --reset\n",
  );

  // With a run on record, launching the review does not ask for one.
  execFileSync("git", ["checkout", "--", "src/guard.js"], { cwd: repo.dir });
  const units = [...(await loadDiff(repo.dir, "main", "feature")).units.keys()];
  writeDraft(repo.dir, repo.base, tip, [{ message: "feat: everything", units }]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  assert.match(opened.out, /^follow-me review: http/m, opened.err);
  assert.equal(opened.out.includes("follow-me coverage"), false);
});

test("on an open review the run reaches the page, outlives a re-plan and goes stale only where the tip moved", async (t) => {
  const run = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" });
  git("checkout", "-q", "feature");
  git("config", "user.email", "fixture@example.com");
  run(repo.dir, "extract");
  const before = await loadDiff(repo.dir, "main", "feature");
  const units = [...before.units.keys()];
  writeDraft(repo.dir, repo.base, repo.branch, [{ message: "feat: everything", units }]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  assert.equal(opened.code, 0, opened.err);
  const url = /^follow-me review: (\S+)$/m.exec(opened.out)?.[1];
  assert.ok(url, opened.out);
  assert.match(
    opened.out,
    /^next: if the project has tests, run them with coverage at the tip, lcov to \.follow-me\/feature\/lcov\/all\.info, and pass it to follow-me coverage$/m,
  );
  assert.equal((await getJson(url, "api/coverage")).status, 404);

  const file = lcov(
    repo.dir,
    "coverage/lcov.info",
    "SF:src/lib.js",
    "DA:4,1",
    "DA:5,0",
    "end_of_record",
    "SF:src/guard.js",
    "DA:1,1",
    "DA:2,1",
    "end_of_record",
  );
  assert.equal(run(repo.dir, "coverage", file).code, 0);
  const taken = readCoverage(repo.dir);
  assert.ok(typeof taken === "object" && taken !== null && "takenAt" in taken);
  const events = await getJson(url, "api/events?since=0&timeout=0");
  assert.deepEqual(events.body.events, [
    { seq: 1, type: "coverage", tip: repo.branch, takenAt: taken.takenAt },
  ]);
  assert.deepEqual((await getJson(url, "api/coverage")).body, { ...taken, stale: [] });
  const add = [...before.units.values()].find(
    (u) => u.kind === "hunk" && u.body.some((r) => r.text === "  assertNumber(b);\n"),
  );
  assert.ok(add?.kind === "hunk");
  const row = add.body.findIndex((r) => r.text === "  assertNumber(b);\n");
  const picked = add.body[row];
  assert.ok(picked !== undefined && picked.op === "+");
  const flagged = await fetch(new URL("api/comments", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchor: { kind: "hunk", unit: add.id, commit: 0, changes: [picked.change], offsets: [row] },
      context: { commitMessage: "feat: everything", path: "src/lib.js" },
      body: "check b too",
      severity: "major",
    }),
  });
  const { id } = JSON.parse(await flagged.text());
  const covered = async () =>
    (await getJson(url, "api/report?format=json")).body.map(
      (i: { id: string; covered?: boolean }) => [i.id, i.covered],
    );
  assert.deepEqual(await covered(), [[id, false]]);
  const markdown = async () => (await fetch(new URL("api/report", url))).text();
  assert.match(await markdown(), /## src\/lib\.js\n\ncoverage: 1 of 2 changed lines\n/);
  run(repo.dir, "--wait", "0");

  // The agent's own run is not news for the agent.
  assert.equal(
    run(repo.dir, "--wait", "0").out,
    "next: the reviewer is still working; run follow-me again to keep listening\n",
  );

  // A new plan for the same tip reorders commits and leaves every mark where it was.
  const [first = "", ...rest] = units;
  writeDraft(repo.dir, repo.base, repo.branch, [
    { message: "feat: the first part", units: [first] },
    { message: "feat: the rest", units: rest },
  ]);
  const replanned = run(repo.dir, "apply");
  assert.equal(replanned.code, 0, replanned.err);
  assert.equal((await getJson(url, "api/state")).body.version, 2);
  assert.deepEqual((await getJson(url, "api/coverage")).body, { ...taken, stale: [] });

  const lib = join(repo.dir, "src", "lib.js");
  writeFileSync(
    lib,
    readFileSync(lib, "utf8").replace("division by zero", "cannot divide by zero"),
  );
  git("commit", "-q", "-am", "fix: say what went wrong");
  run(repo.dir, "--wait", "0");
  const after = await loadDiff(repo.dir, "main", "feature");
  const tip = git("rev-parse", "feature").trim();
  writeDraft(repo.dir, repo.base, tip, [
    { message: "feat: everything", units: [...after.units.keys()] },
  ]);
  const swapped = run(repo.dir, "--wait", "0");
  assert.match(swapped.out, /swapped the open page to plan v3/, swapped.err);
  assert.deepEqual((await getJson(url, "api/coverage")).body, { ...taken, stale: ["src/lib.js"] });
  // A stale file gives no counts and no verdicts.
  assert.deepEqual(await covered(), [[id, undefined]]);
  assert.equal((await markdown()).includes("coverage:"), false);
});

test("a state map asks for one run per test, lcov under .follow-me, until a per-test run arrives", async (t) => {
  const run = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" });
  git("checkout", "-q", "feature");
  git("config", "user.email", "fixture@example.com");
  run(repo.dir, "extract");
  const diff = await loadDiff(repo.dir, "main", "feature");
  writeDraft(repo.dir, repo.base, repo.branch, [
    { message: "feat: everything", units: [...diff.units.keys()] },
  ]);
  const opened = run(repo.dir, "--no-open", "--wait", "0");
  const url = /^follow-me review: (\S+)$/m.exec(opened.out)?.[1];
  assert.ok(url, opened.out);
  const dir = ".follow-me/feature/lcov";
  const perTest = `the state machine needs one coverage run per test: follow-me coverage --reset, then for each test run it alone with lcov to ${dir}/<n>.info and follow-me coverage ${dir}/<n>.info --test "<test name>" --at <path:line>; then run follow-me again`;

  const asked = await fetch(new URL("api/comments", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchor: { kind: "plan" },
      context: { commitMessage: "", path: null },
      body: "Draw it as a state machine",
      kind: "question",
    }),
  });
  const { id } = JSON.parse(await asked.text());
  run(repo.dir, "--wait", "0");
  const diagram = join(repo.dir, ".follow-me", "machine.mmd");
  writeFileSync(diagram, "stateDiagram-v2\n  [*] --> Checking\n  Checking --> Adding\n");
  const map = join(repo.dir, ".follow-me", "map.json");
  const place = (start: number) => ({ path: "src/lib.js", start, end: start });
  writeFileSync(
    map,
    JSON.stringify({
      states: { Checking: [place(1)], Adding: [place(6)] },
      transitions: [{ from: "Checking", to: "Adding", at: [place(4)] }],
    }),
  );
  const replied = run(repo.dir, "reply", id, "--diagram", diagram, "--map", map);
  assert.equal(replied.code, 0, replied.err);
  assert.match(
    replied.out,
    new RegExp(`\nnext: ${escapeRegExp(perTest)}; the reviewer is still working\n$`),
  );
  assert.ok(existsSync(join(repo.dir, dir)));
  assert.equal(git("status", "--porcelain"), "");

  // An aggregate run is not enough for the map, and the loop keeps saying so.
  const all = lcov(repo.dir, `${dir}/all.info`, "SF:src/lib.js", "DA:4,1", "end_of_record");
  const aggregate = run(repo.dir, "coverage", all);
  assert.equal(aggregate.code, 0, aggregate.err);
  assert.match(aggregate.out, new RegExp(`\nnext: ${escapeRegExp(perTest)}\n$`));
  run(repo.dir, "--wait", "0");
  assert.equal(
    run(repo.dir, "--wait", "0").out,
    `next: the reviewer is still working; ${perTest}\n`,
  );

  assert.equal(run(repo.dir, "coverage", "--reset").code, 0);
  const one = lcov(repo.dir, `${dir}/1.info`, "SF:src/lib.js", "DA:4,1", "end_of_record");
  const test1 = run(repo.dir, "coverage", one, "--test", "adds", "--at", "src/lib.js:3");
  assert.equal(test1.code, 0, test1.err);
  assert.doesNotMatch(test1.out, /next:/);
  run(repo.dir, "--wait", "0");
  assert.equal(
    run(repo.dir, "--wait", "0").out,
    "next: the reviewer is still working; run follow-me again to keep listening\n",
  );
  assert.equal(git("status", "--porcelain"), "");
  await fetch(new URL("api/end", url), { method: "POST" });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("--reset starts per-test runs fresh, and a test outside the branch carries a preview", (t) => {
  const run = cliIn(t);
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  // A test file both sides share, so the branch does not change it.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, encoding: "utf8" });
  git("checkout", "-q", "main");
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1} ✓`);
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "test", "add.test.js"), `${body.join("\n")}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "tests");
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-edit", "main");

  const aggregate = lcov(repo.dir, "coverage/all.info", "SF:src/lib.js", "DA:3,5", "end_of_record");
  assert.equal(run(repo.dir, "coverage", aggregate).code, 0);
  const one = lcov(repo.dir, "coverage/one.info", "SF:src/lib.js", "DA:4,1", "end_of_record");
  const outside = run(repo.dir, "coverage", one, "--test", "adds", "--at", "test/add.test.js:3");
  assert.equal(outside.code, 0, outside.err);
  const inside = run(repo.dir, "coverage", one, "--test", "guards", "--at", "src/lib.js:3");
  assert.equal(inside.code, 0, inside.err);
  const kept = readCoverage(repo.dir);
  assert.ok(typeof kept === "object" && kept !== null && "files" in kept && "tests" in kept);
  assert.deepEqual(kept.files, { "src/lib.js": { lines: { 3: 5, 4: 1 } } });
  assert.deepEqual(kept.tests, {
    adds: {
      at: { path: "test/add.test.js", start: 3, end: 3 },
      preview: body.slice(2, 10),
      lines: { "src/lib.js": [4] },
    },
    guards: { at: { path: "src/lib.js", start: 3, end: 3 }, lines: { "src/lib.js": [4] } },
  });

  // Without --reset the per-test runs fold into the last aggregate; with it they start over.
  assert.deepEqual(run(repo.dir, "coverage", "--reset"), {
    code: 0,
    out: "coverage cleared; the next run starts fresh\n",
    err: "",
  });
  assert.equal(run(repo.dir, "coverage", one, "--test", "adds").code, 0);
  const fresh = readCoverage(repo.dir);
  assert.ok(typeof fresh === "object" && fresh !== null && "files" in fresh && "tests" in fresh);
  assert.deepEqual(fresh.files, { "src/lib.js": { lines: { 4: 1 } } });
  assert.deepEqual(Object.keys(fresh.tests ?? {}), ["adds"]);
  assert.equal(run(repo.dir, "coverage", aggregate, "--test", "all", "--reset").code, 0);
  const restarted = readCoverage(repo.dir);
  assert.ok(typeof restarted === "object" && restarted !== null && "tests" in restarted);
  assert.deepEqual(Object.keys(restarted.tests ?? {}), ["all"]);
});
