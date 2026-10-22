import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRepoPath, isSha, tipStartOf } from "./diff.ts";
import { GitError, pathsChanged } from "./git.ts";
import { isFields } from "./plan.ts";
import type {
  BranchCounts,
  BranchHits,
  Coverage,
  FileCoverage,
  FunctionSpan,
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

/**
 * One SF ... end_of_record block. branches maps a line to each branch id and how often it ran,
 * "-" (never evaluated) counting 0. functions are the FN records in the order lcov gives them.
 */
export type LcovRecord = {
  readonly test: string | null;
  readonly path: string;
  readonly lines: ReadonlyMap<number, number>;
  readonly branches: ReadonlyMap<number, ReadonlyMap<string, number>>;
  readonly functions: readonly FunctionSpan[];
};

const RECORD = /^([A-Z][A-Z0-9_]*):(.*)$/;
const DA = /^([1-9][0-9]*),([0-9]+)(?:,.*)?$/;
const BRDA = /^([1-9][0-9]*),([^,]+),(.+),(-|[0-9]+)$/;
/** FN:<start>,<name>, or lcov 2's FN:<start>,<end>,<name>. */
const FN = /^([1-9][0-9]*),(?:([1-9][0-9]*),)?(.+)$/;

/**
 * Reads lcov's tracefile format: TN names the test of the records after it, SF opens a file, DA
 * and BRDA give line and branch hits, FN a function's place, end_of_record closes it. Other
 * records are skipped.
 */
export function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let test: string | null = null;
  let open: {
    path: string;
    test: string | null;
    lines: Map<number, number>;
    branches: Map<number, Map<string, number>>;
    functions: FunctionSpan[];
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
      open = { path: value, test, lines: new Map(), branches: new Map(), functions: [] };
      continue;
    }
    if (key !== "DA" && key !== "BRDA" && key !== "FN") continue;
    if (open === null) throw new LcovError(n, `${key} comes before any SF`);
    if (key === "DA") {
      const da = DA.exec(value);
      if (da === null) throw new LcovError(n, `DA needs <line>,<hits>, got "${value}"`);
      const line = Number(da[1]);
      open.lines.set(line, (open.lines.get(line) ?? 0) + Number(da[2]));
      continue;
    }
    if (key === "FN") {
      const fn = FN.exec(value);
      if (fn === null) throw new LcovError(n, `FN needs <line>,<name>, got "${value}"`);
      const start = Number(fn[1]);
      const end = fn[2] === undefined ? undefined : Number(fn[2]);
      const name = fn[3] ?? "";
      if (end !== undefined && end < start) throw new LcovError(n, "FN ends before it starts");
      open.functions.push(end === undefined ? { name, start } : { name, start, end });
      continue;
    }
    const br = BRDA.exec(value);
    if (br === null) {
      throw new LcovError(n, `BRDA needs <line>,<block>,<branch>,<taken>, got "${value}"`);
    }
    const line = Number(br[1]);
    const id = `${br[2]},${br[3]}`;
    const taken = br[4] === "-" ? 0 : Number(br[4]);
    const branches = open.branches.get(line) ?? new Map<string, number>();
    branches.set(id, (branches.get(id) ?? 0) + taken);
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

/** What one test ran: its hit lines and its branch counts, per file. */
export type TestRun = {
  readonly lines: ReadonlyMap<RepoPath, readonly number[]>;
  readonly branches: ReadonlyMap<RepoPath, BranchCounts>;
};

/**
 * One lcov file placed at the tip: the aggregate, the branch counts of the whole run (what a
 * `--test` run keeps for its test), and each TN-named test's lines and branch counts.
 */
export type Run = {
  readonly files: ReadonlyMap<RepoPath, FileCoverage>;
  readonly counts: ReadonlyMap<RepoPath, BranchCounts>;
  readonly tests: ReadonlyMap<string, TestRun>;
};

type Counting = Map<RepoPath, Map<number, Map<string, number>>>;

/** Adds a record's branch counts into `into`, keeping lcov's branch order per line. */
function countInto(into: Counting, path: RepoPath, record: LcovRecord): void {
  const joined = into.get(path) ?? new Map<number, Map<string, number>>();
  for (const [line, ids] of record.branches) {
    const on = joined.get(line) ?? new Map<string, number>();
    for (const [id, n] of ids) on.set(id, (on.get(id) ?? 0) + n);
    joined.set(line, on);
  }
  into.set(path, joined);
}

function countsOf(counting: Counting): Map<RepoPath, BranchCounts> {
  const out = new Map<RepoPath, BranchCounts>();
  for (const [path, byLine] of counting) {
    if (byLine.size === 0) continue;
    out.set(path, sorted(new Map([...byLine].map(([line, ids]) => [line, [...ids.values()]]))));
  }
  return out;
}

/** Functions of both lists, once each by start and name, in line order. */
function joinFunctions(
  a: readonly FunctionSpan[],
  b: readonly FunctionSpan[],
): readonly FunctionSpan[] {
  const seen = new Map<string, FunctionSpan>();
  for (const f of [...a, ...b]) {
    const key = `${f.start}|${f.name}`;
    const had = seen.get(key);
    if (had === undefined || (had.end === undefined && f.end !== undefined)) seen.set(key, f);
  }
  return [...seen.values()].sort((x, y) => x.start - y.start);
}

/** Sums hits and joins branches over records of the same file; drops what `place` rejects. */
export function runOf(
  records: readonly LcovRecord[],
  place: (raw: string) => RepoPath | null,
): Run {
  const lines = new Map<RepoPath, Map<number, number>>();
  const branches: Counting = new Map();
  const functions = new Map<RepoPath, readonly FunctionSpan[]>();
  const tests = new Map<string, { lines: Map<RepoPath, Set<number>>; branches: Counting }>();
  for (const record of records) {
    const path = place(record.path);
    if (path === null) continue;
    const hits = lines.get(path) ?? new Map<number, number>();
    for (const [line, n] of record.lines) hits.set(line, (hits.get(line) ?? 0) + n);
    lines.set(path, hits);
    countInto(branches, path, record);
    functions.set(path, joinFunctions(functions.get(path) ?? [], record.functions));
    if (record.test === null) continue;
    const ran = tests.get(record.test) ?? { lines: new Map(), branches: new Map() };
    const set = ran.lines.get(path) ?? new Set<number>();
    for (const [line, n] of record.lines) if (n > 0) set.add(line);
    ran.lines.set(path, set);
    countInto(ran.branches, path, record);
    tests.set(record.test, ran);
  }
  const files = new Map<RepoPath, FileCoverage>();
  for (const [path, hits] of lines) {
    const counted = new Map<number, BranchHits>();
    for (const [line, ids] of branches.get(path) ?? []) {
      const n = [...ids.values()];
      counted.set(line, [n.filter((c) => c > 0).length, n.length]);
    }
    const fns = functions.get(path) ?? [];
    files.set(path, {
      lines: sorted(hits),
      branches: sorted(counted),
      ...(fns.length === 0 ? {} : { functions: fns }),
    });
  }
  return {
    files,
    counts: countsOf(branches),
    tests: new Map(
      [...tests].map(([id, ran]): [string, TestRun] => [
        id,
        {
          lines: new Map(
            [...ran.lines].map(([path, set]) => [path, [...set].sort((a, b) => a - b)]),
          ),
          branches: countsOf(ran.branches),
        },
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
    const functions = joinFunctions(had.functions ?? [], f.functions ?? []);
    out.set(path, {
      lines: sorted(lines),
      branches: sorted(branches),
      ...(functions.length === 0 ? {} : { functions }),
    });
  }
  return out;
}

/** A run of one test, named by the agent with --test, and where that test is. */
export type NamedTest = {
  readonly id: string;
  readonly at?: Loc;
  readonly preview?: readonly string[];
};

/** How many tip lines a test outside the branch's changes carries for the page's peek. */
export const PREVIEW_LINES = 8;

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
      [...run.tests].map(([id, ran]): [string, TestCoverage] => [id, testEntry(ran)]),
    );
    return { tip, takenAt, files: run.files, tests };
  }
  const base = prior !== null && prior.tip === tip ? prior : null;
  const tests = new Map(base?.tests ?? []);
  const entry: TestCoverage = {
    ...(test.at === undefined ? {} : { at: test.at }),
    ...(test.preview === undefined ? {} : { preview: test.preview }),
    ...testEntry({ lines: hitLines(run.files), branches: run.counts }),
  };
  tests.set(test.id, entry);
  const files = base === null ? run.files : mergeMax(base.files, run.files);
  return { tip, takenAt, files, tests };
}

/** A test's lines, and its branch counts when the run had any. */
function testEntry(ran: TestRun): TestCoverage {
  return { lines: ran.lines, ...(ran.branches.size === 0 ? {} : { branches: ran.branches }) };
}

/** Executable added rows of a file and how many of them ran. */
export type Tally = { readonly covered: number; readonly executable: number };

/** Calls visit with each added row's tip line, per hunk, for files the run covers. */
function eachAddedLine(
  units: ReadonlyMap<UnitId, Unit>,
  files: ReadonlyMap<RepoPath, FileCoverage>,
  visit: (path: RepoPath, file: FileCoverage, line: number) => void,
): void {
  for (const unit of units.values()) {
    if (unit.kind !== "hunk") continue;
    const file = files.get(unit.path);
    if (file === undefined) continue;
    let line = tipStartOf(unit, units);
    for (const row of unit.body) {
      if (row.op === "+") visit(unit.path, file, line);
      if (row.op !== "-") line += 1;
    }
  }
}

/**
 * Per file, the branch's added rows that lcov calls executable, and how many ran. Every added
 * row is a tip line, which is where the run was taken. Files without such rows are left out.
 */
export function changedLines(
  units: ReadonlyMap<UnitId, Unit>,
  files: ReadonlyMap<RepoPath, FileCoverage>,
): Map<RepoPath, Tally> {
  const out = new Map<RepoPath, Tally>();
  eachAddedLine(units, files, (path, file, line) => {
    const hits = file.lines.get(line);
    if (hits === undefined) return;
    const { covered, executable } = out.get(path) ?? { covered: 0, executable: 0 };
    out.set(path, { covered: covered + (hits > 0 ? 1 : 0), executable: executable + 1 });
  });
  return out;
}

/** How many branches the run took on the branch's added rows, summed over every decision. */
export function changedBranchesTaken(
  units: ReadonlyMap<UnitId, Unit>,
  files: ReadonlyMap<RepoPath, FileCoverage>,
): number {
  let taken = 0;
  eachAddedLine(units, files, (_, file, line) => {
    taken += file.branches.get(line)?.[0] ?? 0;
  });
  return taken;
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
    {
      readonly lines: Record<string, number>;
      readonly branches?: Record<string, BranchHits>;
      readonly functions?: readonly FunctionSpan[];
    }
  >;
  readonly tests?: Record<
    string,
    {
      readonly at?: Loc;
      readonly preview?: readonly string[];
      readonly lines: Record<string, number[]>;
      readonly branches?: Record<string, Record<string, readonly number[]>>;
    }
  >;
};

export function serializeCoverage(c: Coverage): CoverageJson {
  const files = Object.fromEntries(
    [...c.files].map(([path, f]) => [
      path,
      {
        lines: Object.fromEntries(f.lines),
        ...(f.branches.size === 0 ? {} : { branches: Object.fromEntries(f.branches) }),
        ...(f.functions === undefined ? {} : { functions: f.functions }),
      },
    ]),
  );
  const tests = Object.fromEntries(
    [...c.tests].map(([id, t]) => [
      id,
      {
        ...(t.at === undefined ? {} : { at: t.at }),
        ...(t.preview === undefined ? {} : { preview: [...t.preview] }),
        lines: Object.fromEntries([...t.lines].map(([p, ls]) => [p, [...ls]])),
        ...(t.branches === undefined
          ? {}
          : {
              branches: Object.fromEntries(
                [...t.branches].map(([p, byLine]) => [p, Object.fromEntries(byLine)]),
              ),
            }),
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

/** A { path, start, end } with 1 <= start <= end, or null. */
export function parseLoc(v: unknown): Loc | null {
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

function parseFunction(v: unknown): FunctionSpan | null {
  if (!isFields<"name" | "start" | "end">(v)) return null;
  const { name, start, end } = v;
  if (typeof name !== "string" || !isLine(start)) return null;
  if (end === undefined) return { name, start };
  return isLine(end) && end >= start ? { name, start, end } : null;
}

function parseFunctions(v: unknown): readonly FunctionSpan[] | undefined | string {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return "functions is not a list";
  const out: FunctionSpan[] = [];
  for (const raw of v) {
    const f = parseFunction(raw);
    if (f === null) return "a function is not a { name, start, end? }";
    out.push(f);
  }
  return out;
}

function parseCounts(v: unknown): Map<RepoPath, BranchCounts> | undefined | string {
  if (v === undefined) return undefined;
  const files = entries(v);
  if (files === null) return "branches is not an object";
  const out = new Map<RepoPath, BranchCounts>();
  for (const [path, raw] of files) {
    const lines = entries(raw);
    if (!isRepoPath(path) || lines === null) return `branches of ${path} are not by line`;
    const byLine = new Map<number, readonly number[]>();
    for (const [key, counts] of lines) {
      if (!LINE_KEY.test(key) || !Array.isArray(counts) || !counts.every(isCount)) {
        return `branches of ${path}:${key} are not counts`;
      }
      byLine.set(Number(key), counts.filter(isCount));
    }
    out.set(path, sorted(byLine));
  }
  return out;
}

function parseFile(v: unknown): FileCoverage | string {
  if (!isFields<"lines" | "branches" | "functions">(v)) return "a file is not an object";
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
  const functions = parseFunctions(v.functions);
  if (typeof functions === "string") return functions;
  return {
    lines: sorted(hits),
    branches: sorted(branches),
    ...(functions === undefined ? {} : { functions }),
  };
}

function parseTest(v: unknown): TestCoverage | string {
  if (!isFields<"at" | "preview" | "lines" | "branches">(v)) return "a test is not an object";
  const at = v.at === undefined ? undefined : parseLoc(v.at);
  if (at === null) return "at is not a { path, start, end }";
  const preview = v.preview;
  if (
    preview !== undefined &&
    !(Array.isArray(preview) && preview.every((l) => typeof l === "string"))
  ) {
    return "preview is not a list of lines";
  }
  const lineEntries = entries(v.lines);
  if (lineEntries === null) return "lines is not an object";
  const lines = new Map<RepoPath, readonly number[]>();
  for (const [path, list] of lineEntries) {
    if (!isRepoPath(path) || !Array.isArray(list) || !list.every(isLine)) {
      return `lines of ${path} are not line numbers`;
    }
    lines.set(path, list);
  }
  const branches = parseCounts(v.branches);
  if (typeof branches === "string") return branches;
  return {
    ...(at === undefined ? {} : { at }),
    ...(preview === undefined ? {} : { preview: preview.filter((l) => typeof l === "string") }),
    lines,
    ...(branches === undefined ? {} : { branches }),
  };
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
