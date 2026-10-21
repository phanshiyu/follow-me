import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { loadDiff } from "../src/git.ts";
import { PLAN_SCHEMA, type ValidPlan, validatePlan } from "../src/plan.ts";
import { checkSyntax } from "../src/syntax.ts";
import type { Diff } from "../src/types.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const repo = makeFixtureRepo();
let diff: Diff;
before(async () => {
  diff = await loadDiff(repo.dir, "main", "feature");
});
after(repo.cleanup);

function unit(d: Diff, path: string): string {
  const id = [...d.units.values()].find((u) => u.path === path)?.id;
  assert.ok(id, `a unit of ${path}`);
  return id;
}

function planOf(d: Diff, commits: readonly { message: string; units: string[] }[]): ValidPlan {
  const verdict = validatePlan(d, {
    schema: PLAN_SCHEMA,
    base: d.base,
    tip: d.tip,
    commits,
    responses: [],
  });
  assert.ok(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.issues));
  return verdict.plan;
}

function rest(d: Diff, ...except: string[]): string[] {
  return [...d.units.keys()].filter((id) => !except.includes(id));
}

test("a function opened in one commit and closed in the next fails, naming commit and file", async () => {
  const guard = unit(diff, "src/guard.js");
  const plan = planOf(diff, [
    { message: "feat: open assertNumber", units: [`${guard}:0-1`] },
    { message: "feat: close it and the rest", units: [guard, ...rest(diff, guard)] },
  ]);
  const report = await checkSyntax(plan, {});
  assert.deepEqual(report.issues, [
    { commit: 0, path: "src/guard.js", message: "line 3: SyntaxError: Unexpected end of input" },
  ]);
  assert.deepEqual(report.tip, []);
});

test("closing the function in the same commit passes", async () => {
  const guard = unit(diff, "src/guard.js");
  const plan = planOf(diff, [
    { message: "feat: assertNumber", units: [guard] },
    { message: "feat: the rest", units: rest(diff, guard) },
  ]);
  const report = await checkSyntax(plan, {});
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.tip, []);
});

test("extensions without a checker are listed as skipped, once per path", async () => {
  const plan = planOf(diff, [
    { message: "docs: notes", units: [unit(diff, "notes.txt")] },
    { message: "feat: the rest", units: rest(diff, unit(diff, "notes.txt")) },
  ]);
  const report = await checkSyntax(plan, {});
  assert.deepEqual(report.skipped, [
    { path: "README.md", reason: "no checker for .md" },
    { path: "notes.txt", reason: "no checker for .txt" },
  ]);
});

test("--syntax replaces the table for every text file", async () => {
  const guard = unit(diff, "src/guard.js");
  const readme = unit(diff, "README.md");
  const plan = planOf(diff, [
    { message: "feat: guard and readme", units: [guard, readme] },
    { message: "feat: the rest", units: rest(diff, guard, readme) },
  ]);
  const report = await checkSyntax(plan, { override: "grep -q TypeError {file}" });
  assert.deepEqual(report.issues, [{ commit: 0, path: "README.md", message: "checker exited 1" }]);
  assert.deepEqual(report.skipped, []);
});

/** A repo whose tip holds a .ts that parses and a .json that does not. */
function tsRepo() {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-syntax-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  put("keep.txt", "keep\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  put("util.ts", "export function twice(n: number): number {\n  return n * 2;\n}\n");
  put("broken.json", '{\n  "a": 1,\n}\n');
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a .ts file is parsed with types stripped: whole passes, a missing brace fails", async (t) => {
  const r = tsRepo();
  t.after(r.cleanup);
  const d = await loadDiff(r.dir, "main", "feature");
  const ts = unit(d, "util.ts");
  const json = unit(d, "broken.json");
  const whole = await checkSyntax(
    planOf(d, [{ message: "feat: everything", units: [ts, json] }]),
    {},
  );
  assert.deepEqual(whole.issues, []);
  const split = await checkSyntax(
    planOf(d, [
      { message: "feat: twice, opened", units: [`${ts}:0-1`] },
      { message: "feat: twice, closed", units: [ts, json] },
    ]),
    {},
  );
  assert.deepEqual(split.issues, [
    { commit: 0, path: "util.ts", message: "Expected '}', got '<eof>'" },
  ]);
});

test("a file that does not parse at the tip is the tip's own state, not blamed on the split", async (t) => {
  const r = tsRepo();
  t.after(r.cleanup);
  const d = await loadDiff(r.dir, "main", "feature");
  const ts = unit(d, "util.ts");
  const json = unit(d, "broken.json");
  const plan = planOf(d, [
    { message: "feat: json, started", units: [`${json}:0-1`, ts] },
    { message: "feat: json, finished", units: [json] },
  ]);
  const report = await checkSyntax(plan, {});
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.tip, [
    {
      commit: 1,
      path: "broken.json",
      message: "Expected double-quoted property name in JSON at position 12 (line 3 column 1)",
    },
  ]);
});
