import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { definitionIndex } from "../src/definition.ts";
import { isRepoPath } from "../src/diff.ts";
import { loadDiff, resolveCommit } from "../src/git.ts";
import { PLAN_SCHEMA, validatePlan } from "../src/plan.ts";
import { type Loaded, type Loader, type ReviewState, startServer } from "../src/server.ts";
import type { Diff, PlanVersion } from "../src/types.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

function write(dir: string, path: string, lines: readonly string[]): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), `${lines.join("\n")}\n`);
}

const APP_BASE = [
  'import { format } from "./view/format.ts";',
  "",
  "export function main(rows) {",
  "  return format(rows);",
  "}",
];
const APP_TIP = [
  'import { format } from "./view/format.ts";',
  'import { run } from "./run.ts";',
  "",
  "export function main(rows) {",
  "  run(rows);",
  "  return format(rows);",
  "}",
];
const RUN = ["export function run(rows) {", "  return rows.length;", "}"];

/**
 * main.ts on `feature` calls run, which a new file defines; format is defined four times outside
 * the diff, in four languages, and called once. Returns the first tip and a second one that moves
 * run two lines down.
 */
function makeRepo(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-definition-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "src/app.ts", APP_BASE);
  write(dir, "src/view/format.ts", ["export const format = (rows) => rows.join(',');"]);
  write(dir, "src/view/table.ts", [
    "export class Table {",
    "  format(rows) {",
    "    return rows.map(String);",
    "  }",
    "}",
  ]);
  write(dir, "lib/format.py", ["def format(rows):", "    return rows"]);
  write(dir, "cmd/main.go", [
    "package main",
    "",
    "func format(rows []string) string {",
    '\treturn ""',
    "}",
  ]);
  write(dir, "README.md", ["function format(rows) is documented here"]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/app.ts", APP_TIP);
  write(dir, "src/run.ts", RUN);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "run rows");
  const first = git(dir, "rev-parse", "HEAD");
  write(dir, "src/run.ts", ["// Counts rows.", "", ...RUN]);
  git(dir, "commit", "-q", "-am", "document run");
  const second = git(dir, "rev-parse", "HEAD");
  // The working tree differs from both tips, so a lookup that read it would show.
  write(dir, "src/run.ts", ["", "", "", "", "", ...RUN]);
  return { dir, first, second };
}

/** Commit 1 takes the change to app.ts, the caller; commit 2 takes run.ts, the definition. */
function stateOf(diff: Diff, version: number): ReviewState {
  const units = [...diff.units.values()];
  const app = units.filter((u) => u.path === "src/app.ts").map((u) => u.id);
  const rest = units.filter((u) => u.path !== "src/app.ts").map((u) => u.id);
  const verdict = validatePlan(diff, {
    schema: PLAN_SCHEMA,
    base: diff.base,
    tip: diff.tip,
    commits: [
      { message: "Call run from main", units: app },
      { message: "Add run", units: rest },
    ],
    responses: [],
  });
  assert.ok(verdict.ok, JSON.stringify(!verdict.ok && verdict.issues));
  return JSON.parse(
    JSON.stringify({
      mode: "split",
      anchor: {
        schema: "follow-me/session@1",
        branch: "feature",
        baseRef: "main",
        base: diff.base,
        tip: diff.tip,
        tipTree: diff.tipTree,
      },
      version,
      planHash: `hash-of-v${version}`,
      commits: verdict.plan.commits,
      units,
      comments: [],
    }),
  );
}

async function serve(t: TestContext) {
  const repo = makeRepo(t);
  const diffs = [
    await loadDiff(repo.dir, "main", repo.first),
    await loadDiff(repo.dir, "main", repo.second),
  ];
  const session = join(repo.dir, ".follow-me", "feature");
  const load: Loader = async (r) => {
    const diff = diffs[r.version - 1];
    assert.ok(diff, `a plan v${r.version}`);
    const loaded: Loaded = {
      repo: repo.dir,
      reviewsDir: join(session, "reviews"),
      state: stateOf(diff, r.version),
      release: () => {},
      previous: null,
      carried: [],
      earlier: null,
    };
    return loaded;
  };
  const host = await startServer({ port: 0, idleMs: 60_000, load });
  t.after(() => host.close());
  const version: PlanVersion = JSON.parse("1");
  const { summary } = await host.register({
    dir: session,
    mode: "split",
    version,
    hash: "hash-of-v1",
    lockToken: null,
  });
  const base = new URL(summary.url, host.url);
  const unitOf = (k: number, path: string) =>
    [...(diffs[k]?.units.values() ?? [])].find((u) => u.path === path)?.id;
  const define = async (query: string) => {
    const res = await fetch(new URL(`api/definition?${query}`, base));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  return { base, define, unitOf };
}

test("a definition in a later commit than its caller lands in that commit's hunk", async (t) => {
  const { define, unitOf } = await serve(t);
  assert.deepEqual(await define("name=run&from=src/app.ts"), {
    status: 200,
    body: {
      candidates: [
        {
          path: "src/run.ts",
          newLine: 1,
          kind: "function",
          unit: unitOf(0, "src/run.ts"),
          row: 0,
          commit: 1,
          preview: [],
        },
      ],
    },
  });
  // main's line is context in the hunk commit 1 shows.
  assert.deepEqual((await define("name=main")).body.candidates, [
    {
      path: "src/app.ts",
      newLine: 4,
      kind: "function",
      unit: unitOf(0, "src/app.ts"),
      row: 3,
      commit: 0,
      preview: [],
    },
  ]);
});

test("definitions outside the diff carry a preview and rank by the asking file", async (t) => {
  const { define } = await serve(t);
  const outside = (path: string, newLine: number, kind: string, preview: string[]) => ({
    path,
    newLine,
    kind,
    unit: null,
    row: null,
    commit: null,
    preview,
  });
  const table = outside("src/view/table.ts", 2, "method", [
    "  format(rows) {",
    "    return rows.map(String);",
    "  }",
    "}",
  ]);
  const view = outside("src/view/format.ts", 1, "const", [
    "export const format = (rows) => rows.join(',');",
  ]);
  const go = outside("cmd/main.go", 3, "function", [
    "func format(rows []string) string {",
    '\treturn ""',
    "}",
  ]);
  const py = outside("lib/format.py", 1, "function", ["def format(rows):", "    return rows"]);
  assert.deepEqual((await define("name=format&from=src/view/table.ts")).body.candidates, [
    table,
    view,
    go,
    py,
  ]);
  assert.deepEqual((await define("name=format&from=src/app.ts")).body.candidates, [
    go,
    py,
    view,
    table,
  ]);
  assert.deepEqual((await define("name=nowhere")).body, { candidates: [] });
});

test("a name that is not an identifier is a 400", async (t) => {
  const { define } = await serve(t);
  const refused = { status: 400, body: { error: "name must be an identifier" } };
  assert.deepEqual(await define("name=a-b"), refused);
  assert.deepEqual(await define("name=.*"), refused);
  assert.deepEqual(await define("from=src/app.ts"), refused);
});

test("a version swap answers from the new tip", async (t) => {
  const { base, define, unitOf } = await serve(t);
  assert.equal((await define("name=run")).body.candidates[0].newLine, 1);
  const swapped = await fetch(new URL("api/version", base), {
    method: "POST",
    body: JSON.stringify({ version: 2, hash: "hash-of-v2" }),
  });
  assert.equal(swapped.status, 200);
  assert.deepEqual((await define("name=run")).body.candidates, [
    {
      path: "src/run.ts",
      newLine: 3,
      kind: "function",
      unit: unitOf(1, "src/run.ts"),
      row: 2,
      commit: 1,
      preview: [],
    },
  ]);
});

test("each language's definitions are found and its call sites are not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "follow-me-definition-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "a.rs", [
    "pub struct parse;",
    "impl Display for parse {",
    "    pub fn parse(&self) {",
    "        parse();",
    "    }",
    "}",
    "pub(crate) async fn parse() {}",
    "trait parse {}",
  ]);
  write(dir, "A.java", [
    "public class parse {",
    "  public static List<String> parse(String s) {",
    "    return parse(s);",
    "  }",
    "}",
  ]);
  write(dir, "a.kt", ["interface parse", "suspend fun parse(s: String) = parse(s)"]);
  write(dir, "a.rb", ["module parse", "  def self.parse(s)", "    parse(s)", "  end", "end"]);
  write(dir, "a.c", [
    "struct parse {",
    "};",
    "static int parse(const char *s) {",
    "  return parse(s);",
    "}",
    "int parse(const char *s);",
  ]);
  write(dir, "a.go", ["type parse struct{}", "func (p *T) parse() {", "\tparse()", "}"]);
  write(dir, "a.py", ["class parse:", "    async def parse(self):", "        parse()"]);
  write(dir, "a.ts", [
    "export interface parse {}",
    "export default async function parse() {",
    "  if (parse(x)) {",
    "  }",
    "}",
    "let parse: Parser = make();",
  ]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const tip = await resolveCommit(dir, "HEAD");
  const found = await definitionIndex(dir, tip, new Map(), []).lookup("parse", null);
  assert.deepEqual(
    found.map((c) => `${c.path}:${c.newLine} ${c.kind}`),
    [
      "A.java:1 class",
      "A.java:2 method",
      "a.c:1 class",
      "a.c:3 function",
      "a.go:1 type",
      "a.go:2 method",
      "a.kt:1 type",
      "a.kt:2 function",
      "a.py:1 class",
      "a.py:2 method",
    ],
  );
  const first = async (from: string, n: number) =>
    (await definitionIndex(dir, tip, new Map(), []).lookup("parse", isRepoPath(from) ? from : null))
      .slice(0, n)
      .map((c) => `${c.path}:${c.newLine} ${c.kind}`);
  assert.deepEqual(await first("a.rs", 5), [
    "a.rs:1 class",
    "a.rs:2 other",
    "a.rs:3 method",
    "a.rs:7 function",
    "a.rs:8 type",
  ]);
  assert.deepEqual(await first("a.rb", 2), ["a.rb:1 other", "a.rb:2 method"]);
  assert.deepEqual(await first("a.ts", 3), ["a.ts:1 type", "a.ts:2 function", "a.ts:6 const"]);
});
