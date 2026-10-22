import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRepoPath, isSha, tipStartOf } from "./diff.ts";
import { GitError, pathsChanged } from "./git.ts";
import { isFields } from "./plan.ts";
import type {
  BranchHits,
  Coverage,
  FileCoverage,
  Loc,
  RepoPath,
  Sha,
  TestCoverage,
  Unit,
  UnitId,
} from "./types.ts";

/** lcov input that cannot be read, with the 1-based line it fails on. */
export class LcovError extends Error {
  override readonly name = "LcovError";
  readonly line: number;
  constructor(line: number, reason: string) {
    super(`lcov line ${line}: ${reason}`);
    this.line = line;
  }
}

/** One SF ... end_of_record block. branches maps a line to each branch id and whether it ran. */
export type LcovRecord = {
  readonly test: string | null;
  readonly path: string;
  readonly lines: ReadonlyMap<number, number>;
  readonly branches: ReadonlyMap<number, ReadonlyMap<string, boolean>>;
};

const RECORD = /^([A-Z][A-Z0-9_]*):(.*)$/;
const DA = /^([1-9][0-9]*),([0-9]+)(?:,.*)?$/;
const BRDA = /^([1-9][0-9]*),([^,]+),(.+),(-|[0-9]+)$/;

/**
 * Reads lcov's tracefile format: TN names the test of the records after it, SF opens a file, DA
 * and BRDA give line and branch hits, end_of_record closes it. Other records are skipped.
 */
export function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let test: string | null = null;
  let open: {
    path: string;
    test: string | null;
    lines: Map<number, number>;
    branches: Map<number, Map<string, boolean>>;
  } | null = null;
  const close = (): void => {
    if (open !== null) records.push(open);
    open = null;
  };
  const rows = text.split("\n");
  for (const [i, raw] of rows.entries()) {
    const n = i + 1;
    const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (row.trim() === "") continue;
    if (row === "end_of_record") {
      close();
      continue;
    }
    const m = RECORD.exec(row);
    if (m === null) throw new LcovError(n, `"${row.slice(0, 60)}" is not an lcov record`);
    const [, key = "", value = ""] = m;
    if (key === "TN") {
      test = value.trim() === "" ? null : value.trim();
      continue;
    }
    if (key === "SF") {
      close();
      if (value === "") throw new LcovError(n, "SF needs a path");
      open = { path: value, test, lines: new Map(), branches: new Map() };
      continue;
    }
    if (key !== "DA" && key !== "BRDA") continue;
    if (open === null) throw new LcovError(n, `${key} comes before any SF`);
    if (key === "DA") {
      const da = DA.exec(value);
      if (da === null) throw new LcovError(n, `DA needs <line>,<hits>, got "${value}"`);
      const line = Number(da[1]);
      open.lines.set(line, (open.lines.get(line) ?? 0) + Number(da[2]));
      continue;
    }
    const br = BRDA.exec(value);
    if (br === null) {
      throw new LcovError(n, `BRDA needs <line>,<block>,<branch>,<taken>, got "${value}"`);
    }
    const line = Number(br[1]);
    const id = `${br[2]},${br[3]}`;
    const taken = br[4] !== "-" && Number(br[4]) > 0;
    const branches = open.branches.get(line) ?? new Map<string, boolean>();
    branches.set(id, (branches.get(id) ?? false) || taken);
    open.branches.set(line, branches);
  }
  close();
  if (records.length === 0) throw new LcovError(rows.length, "no SF record; is this lcov?");
  return records;
}

/**
 * Where an lcov path is at the tip: absolute, or relative to cwd and failing that to the root,
 * symlinks resolved, then relative to the root. Null outside the repo or for a file the tip lacks.
 */
export function tipPlacer(
  root: string,
  cwd: string,
  atTip: ReadonlySet<RepoPath>,
): (raw: string) => RepoPath | null {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const tops = [root, real(root)];
  return (raw) => {
    const tried = isAbsolute(raw) ? [raw] : [resolve(cwd, raw), resolve(root, raw)];
    for (const abs of tried.flatMap((p) => [p, real(p)])) {
      for (const top of tops) {
        const rel = relative(top, abs);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
        const path = Buffer.from(rel.split(sep).join("/"), "utf8").toString("latin1");
        if (isRepoPath(path) && atTip.has(path)) return path;
      }
    }
    return null;
  };
}

/** One lcov file placed at the tip: the aggregate, and each TN-named test's lines. */
export type Run = {
  readonly files: ReadonlyMap<RepoPath, FileCoverage>;
  readonly tests: ReadonlyMap<string, ReadonlyMap<RepoPath, readonly number[]>>;
};

/** Sums hits and joins branches over records of the same file; drops what `place` rejects. */
export function runOf(
  records: readonly LcovRecord[],
  place: (raw: string) => RepoPath | null,
): Run {
  const lines = new Map<RepoPath, Map<number, number>>();
  const branches = new Map<RepoPath, Map<number, Map<string, boolean>>>();
  const tests = new Map<string, Map<RepoPath, Set<number>>>();
  for (const record of records) {
    const path = place(record.path);
    if (path === null) continue;
    const hits = lines.get(path) ?? new Map<number, number>();
    for (const [line, n] of record.lines) hits.set(line, (hits.get(line) ?? 0) + n);
    lines.set(path, hits);
    const joined = branches.get(path) ?? new Map<number, Map<string, boolean>>();
    for (const [line, ids] of record.branches) {
      const on = joined.get(line) ?? new Map<string, boolean>();
      for (const [id, taken] of ids) on.set(id, (on.get(id) ?? false) || taken);
      joined.set(line, on);
    }
    branches.set(path, joined);
    if (record.test === null) continue;
    const ran = tests.get(record.test) ?? new Map<RepoPath, Set<number>>();
    const set = ran.get(path) ?? new Set<number>();
    for (const [line, n] of record.lines) if (n > 0) set.add(line);
    ran.set(path, set);
    tests.set(record.test, ran);
  }
  const files = new Map<RepoPath, FileCoverage>();
  for (const [path, hits] of lines) {
    const counted = new Map<number, BranchHits>();
    for (const [line, ids] of branches.get(path) ?? []) {
      counted.set(line, [[...ids.values()].filter(Boolean).length, ids.size]);
    }
    files.set(path, { lines: sorted(hits), branches: sorted(counted) });
  }
  return {
    files,
    tests: new Map(
      [...tests].map(([id, ran]) => [
        id,
        new Map([...ran].map(([path, set]) => [path, [...set].sort((a, b) => a - b)])),
      ]),
    ),
  };
}

function sorted<T>(map: ReadonlyMap<number, T>): Map<number, T> {
  return new Map([...map].sort(([a], [b]) => a - b));
}

/** The lines of each file with at least one hit. */
function hitLines(files: ReadonlyMap<RepoPath, FileCoverage>): Map<RepoPath, number[]> {
  return new Map(
    [...files].map(([path, f]) => [path, [...f.lines].flatMap(([l, n]) => (n > 0 ? [l] : []))]),
  );
}

/**
 * Per-test runs only add: a line keeps the larger count, so they never inflate an aggregate run
 * of the same suite, and running the same test twice changes nothing.
 */
function mergeMax(
  a: ReadonlyMap<RepoPath, FileCoverage>,
  b: ReadonlyMap<RepoPath, FileCoverage>,
): Map<RepoPath, FileCoverage> {
  const out = new Map(a);
  for (const [path, f] of b) {
    const had = out.get(path);
    if (had === undefined) {
      out.set(path, f);
      continue;
    }
    const lines = new Map(had.lines);
    for (const [l, n] of f.lines) lines.set(l, Math.max(n, lines.get(l) ?? 0));
    const branches = new Map(had.branches);
    for (const [l, [taken, total]] of f.branches) {
      const [t, n] = branches.get(l) ?? [0, 0];
      branches.set(l, [Math.max(taken, t), Math.max(total, n)]);
    }
    out.set(path, { lines: sorted(lines), branches: sorted(branches) });
  }
  return out;
}

/** A run of one test, named by the agent with --test, and where that test is. */
export type NamedTest = { readonly id: string; readonly at?: Loc };

/**
 * The coverage after this run. A plain run replaces everything, its TN blocks becoming its tests.
 * A named test's run adds to what is already there for the same tip, and starts over otherwise.
 */
export function recordRun(
  prior: Coverage | null,
  run: Run,
  at: { readonly tip: Sha; readonly takenAt: string; readonly test?: NamedTest },
): Coverage {
  const { tip, takenAt, test } = at;
  if (test === undefined) {
    const tests = new Map(
      [...run.tests].map(([id, lines]): [string, TestCoverage] => [id, { lines }]),
    );
    return { tip, takenAt, files: run.files, tests };
  }
  const base = prior !== null && prior.tip === tip ? prior : null;
  const tests = new Map(base?.tests ?? []);
  const entry: TestCoverage = {
    ...(test.at === undefined ? {} : { at: test.at }),
    lines: hitLines(run.files),
  };
  tests.set(test.id, entry);
  const files = base === null ? run.files : mergeMax(base.files, run.files);
  return { tip, takenAt, files, tests };
}

/** Executable added rows of a file and how many of them ran. */
export type Tally = { readonly covered: number; readonly executable: number };

/**
 * Per file, the branch's added rows that lcov calls executable, and how many ran. Every added
 * row is a tip line, which is where the run was taken. Files without such rows are left out.
 */
export function changedLines(
  units: ReadonlyMap<UnitId, Unit>,
  files: ReadonlyMap<RepoPath, FileCoverage>,
): Map<RepoPath, Tally> {
  const out = new Map<RepoPath, Tally>();
  for (const unit of units.values()) {
    if (unit.kind !== "hunk") continue;
    const file = files.get(unit.path);
    if (file === undefined) continue;
    let line = tipStartOf(unit, units);
    let { covered, executable } = out.get(unit.path) ?? { covered: 0, executable: 0 };
    for (const row of unit.body) {
      const hits = row.op === "+" ? file.lines.get(line) : undefined;
      if (hits !== undefined) {
        executable += 1;
        if (hits > 0) covered += 1;
      }
      if (row.op !== "-") line += 1;
    }
    if (executable > 0) out.set(unit.path, { covered, executable });
  }
  return out;
}

export function totalOf(tallies: Iterable<Tally>): Tally {
  let covered = 0;
  let executable = 0;
  for (const t of tallies) {
    covered += t.covered;
    executable += t.executable;
  }
  return { covered, executable };
}

/**
 * Covered files whose content at `tip` differs from where the run was taken, in file order.
 * When the run's commit is gone from the repo, every file is stale.
 */
export async function staleFiles(repo: string, coverage: Coverage, tip: Sha): Promise<RepoPath[]> {
  if (coverage.tip === tip) return [];
  let changed: ReadonlySet<RepoPath>;
  try {
    changed = await pathsChanged(repo, coverage.tip, tip);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    changed = new Set(coverage.files.keys());
  }
  return [...coverage.files.keys()].filter((p) => changed.has(p));
}

/** The files whose coverage still describes the tip. */
export function freshFiles(
  coverage: Coverage,
  stale: readonly RepoPath[],
): Map<RepoPath, FileCoverage> {
  const gone = new Set(stale);
  return new Map([...coverage.files].filter(([path]) => !gone.has(path)));
}

/** coverage.json as written: maps become objects keyed by path, line or test id. */
export type CoverageJson = {
  readonly tip: string;
  readonly takenAt: string;
  readonly files: Record<
    string,
    { readonly lines: Record<string, number>; readonly branches?: Record<string, BranchHits> }
  >;
  readonly tests?: Record<string, { readonly at?: Loc; readonly lines: Record<string, number[]> }>;
};

export function serializeCoverage(c: Coverage): CoverageJson {
  const files = Object.fromEntries(
    [...c.files].map(([path, f]) => [
      path,
      {
        lines: Object.fromEntries(f.lines),
        ...(f.branches.size === 0 ? {} : { branches: Object.fromEntries(f.branches) }),
      },
    ]),
  );
  const tests = Object.fromEntries(
    [...c.tests].map(([id, t]) => [
      id,
      {
        ...(t.at === undefined ? {} : { at: t.at }),
        lines: Object.fromEntries([...t.lines].map(([p, ls]) => [p, [...ls]])),
      },
    ]),
  );
  return { tip: c.tip, takenAt: c.takenAt, files, ...(c.tests.size === 0 ? {} : { tests }) };
}

const LINE_KEY = /^[1-9][0-9]*$/;

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function entries(v: unknown): [string, unknown][] | null {
  return isFields(v) ? Object.entries(v) : null;
}

function parseLoc(v: unknown): Loc | null {
  if (!isFields<"path" | "start" | "end">(v)) return null;
  const { path, start, end } = v;
  if (typeof path !== "string" || !isRepoPath(path) || !isLine(start) || !isLine(end)) return null;
  return end < start ? null : { path, start, end };
}

/** Like parseLoc, for argv: "path:line" or "path:start-end", the path placed like lcov's. */
export function parseLocArg(raw: string, place: (raw: string) => RepoPath | null): Loc | string {
  const m = /^(.+):([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(raw);
  if (m === null) return `--at ${raw} is not <path>:<line> or <path>:<start>-<end>`;
  const path = place(m[1] ?? "");
  if (path === null) return `--at ${raw} names no file of the branch tip`;
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  return end < start ? `--at ${raw} runs backwards` : { path, start, end };
}

function parseFile(v: unknown): FileCoverage | string {
  if (!isFields<"lines" | "branches">(v)) return "a file is not an object";
  const lines = entries(v.lines);
  if (lines === null) return "lines is not an object";
  const hits = new Map<number, number>();
  for (const [key, n] of lines) {
    if (!LINE_KEY.test(key) || !isCount(n)) return `line ${key} has no hit count`;
    hits.set(Number(key), n);
  }
  const branchEntries = entries(v.branches ?? {});
  if (branchEntries === null) return "branches is not an object";
  const branches = new Map<number, BranchHits>();
  for (const [key, pair] of branchEntries) {
    if (!LINE_KEY.test(key) || !Array.isArray(pair) || pair.length !== 2) {
      return `branches of line ${key} are not [taken, total]`;
    }
    const [taken, total] = pair;
    if (!isCount(taken) || !isCount(total) || taken > total) {
      return `branches of line ${key} are not [taken, total]`;
    }
    branches.set(Number(key), [taken, total]);
  }
  return { lines: sorted(hits), branches: sorted(branches) };
}

function parseTest(v: unknown): TestCoverage | string {
  if (!isFields<"at" | "lines">(v)) return "a test is not an object";
  const at = v.at === undefined ? undefined : parseLoc(v.at);
  if (at === null) return "at is not a { path, start, end }";
  const lineEntries = entries(v.lines);
  if (lineEntries === null) return "lines is not an object";
  const lines = new Map<RepoPath, readonly number[]>();
  for (const [path, list] of lineEntries) {
    if (!isRepoPath(path) || !Array.isArray(list) || !list.every(isLine)) {
      return `lines of ${path} are not line numbers`;
    }
    lines.set(path, list);
  }
  return { ...(at === undefined ? {} : { at }), lines };
}

/** The one place coverage.json becomes a Coverage. */
export function parseCoverage(v: unknown): Coverage | string {
  if (!isFields<"tip" | "takenAt" | "files" | "tests">(v)) return "not an object";
  const { tip, takenAt } = v;
  if (typeof tip !== "string" || !isSha(tip)) return "tip is not an object id";
  if (typeof takenAt !== "string") return "takenAt is not a time";
  const fileEntries = entries(v.files);
  if (fileEntries === null) return "files is not an object";
  const files = new Map<RepoPath, FileCoverage>();
  for (const [path, raw] of fileEntries) {
    if (!isRepoPath(path)) return "a file has no path";
    const file = parseFile(raw);
    if (typeof file === "string") return `${path}: ${file}`;
    files.set(path, file);
  }
  const testEntries = entries(v.tests ?? {});
  if (testEntries === null) return "tests is not an object";
  const tests = new Map<string, TestCoverage>();
  for (const [id, raw] of testEntries) {
    const test = parseTest(raw);
    if (typeof test === "string") return `test ${id}: ${test}`;
    tests.set(id, test);
  }
  return { tip, takenAt, files, tests };
}
