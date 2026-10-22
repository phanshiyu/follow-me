#!/usr/bin/env node
/**
 * Drives one agent session non-interactively and records every byte follow-me hands the agent,
 * per step, on two inputs: the test fixture and a real branch (this repo's 20 commits before a
 * pinned tip, so runs stay comparable while the repo moves on). Tokens are estimated as bytes / 4.
 *
 * usage: node scripts/measure-tokens.ts [--out <dir>] [--bin <follow-me.ts>] [--skill <SKILL.md>]
 *   --out keeps each step's text as <dir>/<input>/<nn>-<step>.txt
 *   --bin and --skill measure another build, such as a worktree of an older commit
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tipStartOf } from "../src/diff.ts";
import { loadDiff } from "../src/git.ts";
import type { Diff, TextHunk } from "../src/types.ts";
import { makeFixtureRepo } from "../test/fixture-repo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The real branch: the 20 commits up to v0.4.1, the tip before any token cut. */
const REAL_TIP = "8acfcfc";
const REAL_DEPTH = 20;

type Step = { readonly step: string; readonly text: string };
type Run = { readonly input: string; readonly steps: readonly Step[] };

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const BIN = resolve(option("bin") ?? join(ROOT, "bin", "follow-me.ts"));
const SKILL = resolve(option("skill") ?? join(ROOT, "skills", "follow-me", "SKILL.md"));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function record(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(v));
}

function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("not a list");
  return v;
}

function text(v: unknown): string {
  if (typeof v !== "string") throw new Error("not a string");
  return v;
}

type Env = Record<string, string | undefined>;

function cli(dir: string, env: Env, ...args: string[]): string {
  const r = spawnSync(BIN, args, { cwd: dir, encoding: "utf8", env });
  if (r.status !== 0) {
    throw new Error(`follow-me ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

async function api(url: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${raw}`);
  return JSON.parse(raw);
}

function hunks(diff: Diff): TextHunk[] {
  return [...diff.units.values()].flatMap((u) => (u.kind === "hunk" ? [u] : []));
}

/** The draft an agent might write: one commit per file, with one concern on `concernOn`. */
function draftFor(diff: Diff, concernOn: TextHunk, responses: readonly unknown[]): string {
  const byPath = new Map<string, unknown[]>();
  for (const unit of diff.units.values()) {
    const ref =
      unit.id === concernOn.id
        ? {
            unit: unit.id,
            concerns: [
              {
                severity: "minor",
                kind: "missing-test",
                text: "No test covers this branch of the change.",
                lines: [0],
              },
            ],
          }
        : unit.id;
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), ref]);
  }
  const commits = [...byPath].map(([path, units]) => ({
    message: `Change ${path}\n\nThe branch needs ${path} as it is at the tip.`,
    units,
  }));
  const plan = { schema: "follow-me/plan@1", base: diff.base, tip: diff.tip, commits, responses };
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** A hunk of a script file with an added row ending in ";" and a context row. */
function pickFlag(diff: Diff): { hunk: TextHunk; row: number } {
  for (const hunk of hunks(diff)) {
    if (!/\.(ts|js)$/.test(hunk.path) || hunk.path.startsWith("test/")) continue;
    if (!hunk.body.some((r) => r.op === " ")) continue;
    const row = hunk.body.findIndex((r) => r.op === "+" && /;\s*$/.test(r.text));
    if (row !== -1) return { hunk, row };
  }
  throw new Error("no hunk to flag");
}

function tipLineOf(hunk: TextHunk, diff: Diff, row: number): number {
  let line = tipStartOf(hunk, diff.units);
  for (const r of hunk.body.slice(0, row)) if (r.op !== "-") line += 1;
  return line;
}

function hunkComment(hunk: TextHunk, row: number, message: string, body: string, more: object) {
  const at = hunk.body[row];
  const changes = at === undefined || at.op === " " ? [] : [at.change];
  // The page snapshots the picked rows, so a comment can still be quoted after its hunk changes.
  const lines = at === undefined ? [] : [at.text.replace(/\n$/, "")];
  return {
    anchor: { kind: "hunk", unit: hunk.id, commit: 0, changes, offsets: [row] },
    context: { commitMessage: message, path: hunk.path, lines },
    body,
    ...more,
  };
}

async function session(input: string, dir: string): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "measure-home-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env: Env = {
    ...process.env,
    HOME: home,
    FOLLOW_ME_HOME: join(work, "state"),
    FOLLOW_ME_IDLE_MS: "200",
  };
  const steps: Step[] = [];
  const take = (step: string, out: string) => {
    steps.push({ step, text: out });
    return out;
  };
  const fm = (...args: string[]) => cli(dir, env, ...args);
  const sub = join(dir, ".follow-me", git(dir, "branch", "--show-current"));
  try {
    take("skill", readFileSync(SKILL, "utf8"));
    take("first follow-me", fm("--no-open"));
    take("prompt.md", readFileSync(join(sub, "prompt.md"), "utf8"));

    const diff = await loadDiff(dir, "main", "HEAD");
    const flag = pickFlag(diff);
    const others = hunks(diff).filter((h) => h.id !== flag.hunk.id);
    const onContext = others.find((h) => h.body.some((r) => r.op === " "));
    const asked = others.find((h) => h !== onContext && h.body.some((r) => r.op !== " "));
    if (onContext === undefined || asked === undefined) throw new Error("too few hunks");
    writeFileSync(join(sub, "draft.json"), draftFor(diff, asked, []));
    take("check", fm("check"));
    const launched = take("launch", fm("--no-open", "--wait", "0"));
    const url = /^follow-me review: (\S+)$/m.exec(launched)?.[1];
    if (url === undefined) throw new Error(`no page URL in:\n${launched}`);
    // The skill asks for a test run at the tip once the page is open; one covered line will do.
    const lcov = join(work, "lcov.info");
    const covered = tipLineOf(flag.hunk, diff, flag.row);
    writeFileSync(lcov, `SF:${flag.hunk.path}\nDA:${covered},1\nend_of_record\n`);
    take("coverage", fm("coverage", lcov));

    const state = record(await api(url, "api/state", "GET"));
    const commits = list(state["commits"]).map(record);
    const commitOf = (unit: string) =>
      commits.findIndex((c) => list(c["refs"]).some((r) => record(r)["unit"] === unit));
    const messageOf = (unit: string) => text(commits[commitOf(unit)]?.["message"]);
    const withCommit = (c: ReturnType<typeof hunkComment>, unit: string) => ({
      ...c,
      anchor: { ...c.anchor, commit: commitOf(unit) },
    });
    const flagBody = withCommit(
      hunkComment(flag.hunk, flag.row, messageOf(flag.hunk.id), "Say why this line is here.", {
        severity: "minor",
      }),
      flag.hunk.id,
    );
    const contextRow = onContext.body.findIndex((r) => r.op === " ");
    const contextBody = withCommit(
      hunkComment(
        onContext,
        contextRow,
        messageOf(onContext.id),
        "Does this old code still hold?",
        {},
      ),
      onContext.id,
    );
    const askedRow = asked.body.findIndex((r) => r.op !== " ");
    const questionBody = withCommit(
      hunkComment(asked, askedRow, messageOf(asked.id), "Why does this change come first?", {
        kind: "question",
      }),
      asked.id,
    );
    const id = async (body: unknown) =>
      text(record(await api(url, "api/comments", "POST", body))["id"]);
    const flagId = await id(flagBody);
    const contextId = await id(contextBody);
    const questionId = await id(questionBody);
    take("batch: 2 comments, 1 question", fm("--wait", "0"));

    take(
      "reply",
      fm("reply", questionId, "--body", "It comes first because later commits build on it."),
    );
    await api(url, `api/comments/${flagId}/replies`, "POST", {
      author: "reviewer",
      body: "Please also say what fails without it.",
    });
    const stored = list(record(await api(url, "api/state", "GET"))["comments"])
      .map(record)
      .find((c) => c["id"] === contextId);
    await api(url, `api/comments/${contextId}`, "PUT", {
      ...stored,
      body: "Does this old code still hold after the change?",
    });
    const concern = list(commits[commitOf(asked.id)]?.["concerns"] ?? [])
      .map(record)
      .find((k) => k["unit"] === asked.id);
    if (concern !== undefined) {
      await api(url, `api/concerns/${text(concern["id"])}`, "POST", { decision: "kept" });
    }
    take("reply round", fm("--wait", "0"));
    take("idle call", fm("--wait", "0"));

    const file = join(dir, flag.hunk.path);
    const lines = readFileSync(file, "utf8").split("\n");
    const at = tipLineOf(flag.hunk, diff, flag.row);
    const indent = /^\s*/.exec(lines[at - 1] ?? "")?.[0] ?? "";
    lines.splice(at, 0, `${indent}// Without this line the next one has nothing to read.`);
    writeFileSync(file, lines.join("\n"));
    git(dir, "commit", "-q", "-am", "fix: say why the line is there");
    take("re-plan", fm("--wait", "0"));
    take("re-plan prompt.md", readFileSync(join(sub, "prompt.md"), "utf8"));

    const moved = await loadDiff(dir, "main", "HEAD");
    const fixed = hunks(moved).find(
      (h) => h.path === flag.hunk.path && !diff.units.has(h.id) && h.body.length > 0,
    );
    if (fixed === undefined) throw new Error("the edit made no new hunk");
    const response = { comment: flagId, status: "addressed", note: "Added the reason above it." };
    writeFileSync(join(sub, "draft.json"), draftFor(moved, asked, [response]));
    take("swap", fm("--wait", "0"));
    take("reply on changed thread", fm("reply", flagId, "--body", "Added the reason above it."));

    await api(url, "api/resolved", "POST", { comment: questionId, resolved: true });
    const v2 = list(record(await api(url, "api/state", "GET"))["commits"]).map(record);
    const lateCommit = v2.findIndex((c) =>
      list(c["refs"]).some((r) => record(r)["unit"] === fixed.id),
    );
    const late = hunkComment(fixed, 0, text(v2[lateCommit]?.["message"]), "Good, thanks.", {
      severity: "minor",
    });
    await id({ ...late, anchor: { ...late.anchor, commit: lateCommit } });
    await api(url, "api/submit", "POST");
    take("final report", fm("--wait", "0"));
    await api(url, "api/end", "POST");
    return { input, steps };
  } finally {
    spawnSync(BIN, ["server", "stop"], { cwd: dir, env });
    rmSync(work, { recursive: true, force: true });
  }
}

async function fixture(): Promise<Run> {
  const repo = makeFixtureRepo();
  try {
    git(repo.dir, "config", "user.email", "fixture@example.com");
    git(repo.dir, "config", "user.name", "fixture");
    return await session("fixture", repo.dir);
  } finally {
    repo.cleanup();
  }
}

async function realBranch(): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "measure-real-"));
  const dir = join(work, "follow-me");
  try {
    git(work, "clone", "--quiet", "--no-local", ROOT, dir);
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "user.name", "measure");
    git(dir, "config", "user.email", git(dir, "log", "-1", "--format=%ae", REAL_TIP));
    git(dir, "switch", "--quiet", "-c", "work", REAL_TIP);
    git(dir, "branch", "--quiet", "-f", "main", `${REAL_TIP}~${REAL_DEPTH}`);
    return await session("real branch", dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const tokens = (bytes: number) => Math.round(bytes / 4);
const size = (s: string) => Buffer.byteLength(s, "utf8");

function table(runs: readonly Run[]): string {
  const names = [...new Set(runs.flatMap((r) => r.steps.map((s) => s.step)))];
  const head = `| step | ${runs.map((r) => `${r.input} bytes | ~tokens`).join(" | ")} |`;
  const rule = `|---|${runs.map(() => "---:|---:").join("|")}|`;
  const rows = names.map((name) => {
    const cells = runs.map((r) => {
      const bytes = r.steps.filter((s) => s.step === name).reduce((n, s) => n + size(s.text), 0);
      return `${bytes} | ${tokens(bytes)}`;
    });
    return `| ${name} | ${cells.join(" | ")} |`;
  });
  const totals = runs.map((r) => {
    const bytes = r.steps.reduce((n, s) => n + size(s.text), 0);
    return `**${bytes}** | **${tokens(bytes)}**`;
  });
  return [head, rule, ...rows, `| **total** | ${totals.join(" | ")} |`].join("\n");
}

const runs = [await fixture(), await realBranch()];
const out = option("out");
if (out !== undefined) {
  for (const run of runs) {
    const dir = join(out, run.input.replace(/\W+/g, "-"));
    mkdirSync(dir, { recursive: true });
    run.steps.forEach((s, i) => {
      const name = `${String(i).padStart(2, "0")}-${s.step.replace(/\W+/g, "-")}.txt`;
      writeFileSync(join(dir, name), s.text);
    });
  }
}
process.stdout.write(`${table(runs)}\n\nTokens are an estimate: bytes / 4, no tokenizer.\n`);
