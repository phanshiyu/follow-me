import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ValidPlan } from "./plan.ts";
import type { RepoPath } from "./types.ts";

/**
 * The syntax gate: every file a commit writes must parse, so each commit reads as code even when
 * it does not build or pass tests. A checker runs on a temp file holding the projected bytes.
 * Pure of git: it sees only the ValidPlan.
 */

export type SyntaxIssue = {
  readonly commit: number;
  readonly path: RepoPath;
  readonly message: string;
};

export type SkippedFile = { readonly path: RepoPath; readonly reason: string };

export type SyntaxReport = {
  /** Files that fail in a commit before the last. These are the split's doing. */
  readonly issues: readonly SyntaxIssue[];
  /** Files that fail in the last commit, which is the tip. The split did not cause these. */
  readonly tip: readonly SyntaxIssue[];
  readonly skipped: readonly SkippedFile[];
  /** File states handed to a checker, counting a path once per commit that writes it. */
  readonly checked: number;
};

type Outcome =
  | { readonly kind: "parses" }
  | { readonly kind: "fails"; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string };

/** Judges the temp file at the given path, which holds the bytes of text. */
type Checker = (file: string, text: string) => Promise<Outcome>;

const LIMIT = 4;
const TIMEOUT_MS = 30_000;

/**
 * node --check does not strip types, so .ts goes through module.stripTypeScriptTypes, which
 * parses the whole file and throws on a syntax error. An enum or namespace parses but cannot be
 * stripped, which is node's limit and not the file's, so that counts as parsing.
 */
const STRIP_TYPES = `
const { stripTypeScriptTypes } = require("node:module");
const { readFileSync } = require("node:fs");
try {
  stripTypeScriptTypes(readFileSync(process.argv[1], "utf8"), { mode: "strip" });
} catch (error) {
  if (error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") process.exit(0);
  console.error(error.message);
  process.exit(1);
}`;

/** Runs argv with {file} replaced; a program that is not installed skips the file. */
function command(argv: readonly string[]): Checker {
  return (file) =>
    run(
      argv.map((a) => (a === "{file}" ? file : a)),
      file,
      argv[0] ?? "",
    );
}

function run(argv: readonly string[], file: string, what: string): Promise<Outcome> {
  const [program, ...rest] = argv;
  if (program === undefined) return Promise.resolve({ kind: "parses" });
  return new Promise((resolve) => {
    execFile(program, rest, { timeout: TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return resolve({ kind: "parses" });
      if (error.code === "ENOENT") {
        return resolve({ kind: "skipped", reason: `${what} is not installed` });
      }
      const output = stderr.trim() === "" ? stdout : stderr;
      const message =
        error.killed === true
          ? `checker timed out after ${TIMEOUT_MS / 1000}s`
          : output.trim() === ""
            ? `checker exited ${error.code}`
            : complaint(output, file);
      resolve({ kind: "fails", message });
    });
  });
}

/**
 * The line of a parser's output that names the problem. node prints `file:LINE`, the source line,
 * a caret and then `SyntaxError: ...`; python prints a traceback ending in `SyntaxError: ...`;
 * sh and bash print one line. The temp path never leaks into the message.
 */
export function complaint(output: string, file: string): string {
  const lines = output
    .replaceAll(file, "file")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  const named = lines.find((l) => /^[A-Za-z]*Error\b/.test(l));
  if (named === undefined) return lines[0] ?? "does not parse";
  const where = /^file:(\d+)$/.exec(lines[0] ?? "")?.[1];
  return where === undefined ? named : `line ${where}: ${named}`;
}

const json: Checker = async (_file, text) => {
  try {
    JSON.parse(text);
    return { kind: "parses" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fails", message: message.split("\n")[0] ?? message };
  }
};

/** Bash scripts need bash -n; a plain .sh is held to POSIX unless its shebang names bash. */
const sh = command(["sh", "-n", "{file}"]);
const bash = command(["bash", "-n", "{file}"]);
const shell: Checker = (file, text) =>
  /^#!.*\bbash\b/.test(text) || file.endsWith(".bash") ? bash(file, text) : sh(file, text);

const node = command(["node", "--check", "{file}"]);
const types = command([
  "node",
  "--disable-warning=ExperimentalWarning",
  "-e",
  STRIP_TYPES,
  "{file}",
]);
const python = command(["python3", "-m", "py_compile", "{file}"]);

/**
 * Extension to checker. A missing extension is skipped, not guessed: .jsx and .tsx need a JSX
 * parser node does not have, and yaml has none installed.
 */
const CHECKERS: ReadonlyMap<string, Checker> = new Map([
  [".js", node],
  [".mjs", node],
  [".cjs", node],
  [".ts", types],
  [".mts", types],
  [".cts", types],
  [".json", json],
  [".sh", shell],
  [".bash", shell],
  [".py", python],
]);

function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The --syntax override: one shell command for every text file, {file} replaced by its path. */
function overrideChecker(template: string): Checker {
  return (file) =>
    run(["sh", "-c", template.replaceAll("{file}", quote(file))], file, "the --syntax command");
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

type Job = {
  readonly commit: number;
  readonly path: RepoPath;
  readonly bytes: string;
};

/**
 * Checks every file each commit writes. The last commit equals the tip by construction, so a
 * file that fails there is reported as the tip's own state and is not checked in earlier commits,
 * where the same failure would be blamed on the split.
 */
export async function checkSyntax(
  plan: ValidPlan,
  opts: { readonly override?: string },
): Promise<SyntaxReport> {
  const last = plan.commits.length - 1;
  const jobs: Job[] = plan.commits.flatMap((c) =>
    c.changes.flatMap((ch) =>
      ch.op === "write" ? [{ commit: c.index, path: ch.path, bytes: ch.bytes }] : [],
    ),
  );
  // node prints the resolved path, so the dir is resolved too for the message to find it.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "follow-me-syntax-")));
  try {
    const cache = new Map<string, Promise<Outcome>>();
    let serial = 0;
    const outcomeOf = (job: Job): Promise<Outcome> => {
      const ext = extname(job.path).toLowerCase();
      const checker =
        opts.override === undefined ? CHECKERS.get(ext) : overrideChecker(opts.override);
      if (checker === undefined) {
        return Promise.resolve({
          kind: "skipped",
          reason: `no checker for ${ext === "" ? "files without an extension" : ext}`,
        });
      }
      const key = `${ext}\0${job.bytes}`;
      const known = cache.get(key);
      if (known !== undefined) return known;
      const file = join(dir, `f${serial++}${ext}`);
      const fresh = writeFile(file, Buffer.from(job.bytes, "latin1")).then(() =>
        checker(file, job.bytes),
      );
      cache.set(key, fresh);
      return fresh;
    };

    const tipJobs = jobs.filter((j) => j.commit === last);
    const tipOutcomes = await mapLimit(tipJobs, LIMIT, outcomeOf);
    const tip: SyntaxIssue[] = [];
    const broken = new Set<RepoPath>();
    tipJobs.forEach((job, i) => {
      const outcome = tipOutcomes[i];
      if (outcome?.kind !== "fails") return;
      tip.push({ commit: job.commit, path: job.path, message: outcome.message });
      broken.add(job.path);
    });

    const rest = jobs.filter((j) => j.commit !== last && !broken.has(j.path));
    const outcomes = await mapLimit(rest, LIMIT, outcomeOf);
    const issues: SyntaxIssue[] = [];
    const skipped = new Map<RepoPath, string>();
    let checked = 0;
    const all = [
      ...tipJobs.map((j, i) => [j, tipOutcomes[i]] as const),
      ...rest.map((j, i) => [j, outcomes[i]] as const),
    ];
    for (const [job, outcome] of all) {
      if (outcome === undefined) continue;
      if (outcome.kind === "skipped") skipped.set(job.path, outcome.reason);
      else checked++;
      if (outcome.kind === "fails" && job.commit !== last) {
        issues.push({ commit: job.commit, path: job.path, message: outcome.message });
      }
    }
    issues.sort((a, b) => a.commit - b.commit || byPath(a, b));
    return {
      issues,
      tip,
      skipped: [...skipped].map(([path, reason]) => ({ path, reason })).sort(byPath),
      checked,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
