import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LcovError, parseLcov, recordRun, runOf, tipPlacer } from "../src/coverage.ts";
import { isRepoPath, isSha } from "../src/diff.ts";
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

/** Runs the CLI with its own state dir, so no review server of the user is touched. */
function cliIn(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "follow-me-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return (dir: string, ...args: string[]) => {
    const r = spawnSync(BIN, args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FOLLOW_ME_HOME: home, FOLLOW_ME_IDLE_MS: "200" },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
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
              ["0,0", true],
              ["0,1", false],
              ["e0,2", false],
            ]),
          ],
        ],
      },
      {
        test: "adds",
        path: "src/a.js",
        lines: [
          [1, 1],
          [2, 1],
        ],
        branches: [],
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
    runOf([{ test: null, path: a, lines: new Map(lines), branches: new Map() }], (p) =>
      repoPath(p),
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

test("follow-me coverage records the run at the tip and counts the changed lines it ran", (t) => {
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
  assert.equal(
    named.out,
    `coverage for 2 files at ${tip.slice(0, 12)}; 4 of 4 changed lines covered\n`,
  );
  const withTest = readCoverage(repo.dir);
  assert.ok(typeof withTest === "object" && withTest !== null && "tests" in withTest);
  assert.deepEqual(withTest.tests, {
    "add rejects strings": {
      at: { path: "src/lib.js", start: 3, end: 7 },
      lines: { "src/lib.js": [4, 5] },
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
    "follow-me: --at needs --test\nusage: follow-me coverage <lcov> [--test <id> [--at <path:line>]]\n",
  );
});
