// Coverage while reading: what each shown row's tip line did in the suite, the tallies the headers
// show, and the uncovered added rows x and X step through. Pure.

import { filesOf } from "./commit.ts";
import { type LineNumber, ownersOf, rowsOf } from "./rows.ts";
import type { Candidate, ProjectedCommit, RepoPath, Unit, UnitId } from "./wire.ts";

/** Tip lines of one file, both ends included. */
export type Loc = { readonly path: RepoPath; readonly start: number; readonly end: number };

/** GET api/coverage. Line numbers are tip lines; `stale` lists paths changed since `tip`. */
export type Coverage = {
  readonly tip: string;
  readonly takenAt: string;
  readonly files: Readonly<
    Record<
      string,
      {
        readonly lines: Readonly<Record<string, number>>;
        readonly branches?: Readonly<Record<string, readonly [number, number]>>;
        readonly functions?: readonly {
          readonly name: string;
          readonly start: number;
          readonly end?: number;
        }[];
      }
    >
  >;
  readonly tests?: Readonly<
    Record<
      string,
      {
        readonly at?: Loc;
        /** Tip lines from at.start, sent when the branch does not change the test's file. */
        readonly preview?: readonly string[];
        readonly lines: Readonly<Record<string, readonly number[]>>;
        /** Per file and branch line, this test's count for each branch, in lcov's order. */
        readonly branches?: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
      }
    >
  >;
  readonly stale: readonly string[];
};

export type MarkKind = "covered" | "partly" | "uncovered";

export type Mark = {
  readonly kind: MarkKind;
  readonly hits: number;
  /** Branches taken and branches in all, when the run recorded them for this line. */
  readonly branches: readonly [number, number] | null;
  /** The file changed after the run, so the mark may sit on the wrong line. */
  readonly stale: boolean;
};

/** A tip line's mark, or null for a line the run did not record: it is not executable. */
export function markOf(coverage: Coverage, path: string, line: number): Mark | null {
  const file = coverage.files[path];
  const hits = file?.lines[line];
  if (file === undefined || hits === undefined) return null;
  const branches = file.branches?.[line] ?? null;
  const kind: MarkKind =
    hits === 0
      ? "uncovered"
      : branches !== null && branches[0] < branches[1]
        ? "partly"
        : "covered";
  return { kind, hits, branches, stale: coverage.stale.includes(path) };
}

const times = (n: number) => (n === 1 ? "1 hit" : `${n} hits`);

/** What a screen reader hears for a mark: "covered, 14 hits". */
export function describeMark(mark: Mark): string {
  const what =
    mark.kind === "uncovered"
      ? "not covered"
      : mark.kind === "partly"
        ? `partly covered, ${times(mark.hits)}, ${mark.branches?.[0]} of ${mark.branches?.[1]} branches`
        : `covered, ${times(mark.hits)}`;
  return mark.stale ? `${what}, coverage is stale` : what;
}

/** Executable added rows: how many there are, how many the suite ran, how many of those only in part. */
export type Tally = { readonly total: number; readonly run: number; readonly partly: number };

const EMPTY: Tally = { total: 0, run: 0, partly: 0 };

function add(tally: Tally, mark: Mark): Tally {
  return {
    total: tally.total + 1,
    run: tally.run + (mark.kind === "uncovered" ? 0 : 1),
    partly: tally.partly + (mark.kind === "partly" ? 1 : 0),
  };
}

/** Rounded down, so one missed line never reads as 100%. */
export function percentOf(tally: Tally): number {
  return tally.total === 0 ? 100 : Math.floor((100 * tally.run) / tally.total);
}

/** Red when anything was not run, amber when something ran only in part. */
export function toneOf(tally: Tally): MarkKind {
  return tally.run < tally.total ? "uncovered" : tally.partly > 0 ? "partly" : "covered";
}

/** An added row the suite did not run, in document order. */
export type Target = {
  readonly commit: number;
  readonly path: string;
  readonly unit: UnitId;
  readonly row: number;
};

export type PageCoverage = {
  readonly tip: string;
  readonly takenAt: string;
  /** Every row with a tip line the run recorded, per hunk and body index, whatever commit shows it. */
  readonly marks: ReadonlyMap<UnitId, ReadonlyMap<number, Mark>>;
  readonly commits: readonly Tally[];
  /** Keyed by `${commit}|${path}`. */
  readonly files: ReadonlyMap<string, Tally>;
  readonly branch: Tally;
  readonly uncovered: readonly Target[];
  readonly stale: ReadonlySet<string>;
  readonly tests: Coverage["tests"];
};

export const fileKey = (commit: number, path: string) => `${commit}|${path}`;

/**
 * The run laid over the page. A row maps through its tip number, so base-only rows (removed lines,
 * and context a later commit removes) get no mark. Tallies count only the rows a commit adds,
 * which is Codecov's "patch" idea: context belongs to whichever commit added it.
 */
export function pageCoverage(
  coverage: Coverage,
  commits: readonly ProjectedCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
  numbers: ReadonlyMap<UnitId, readonly LineNumber[]>,
): PageCoverage {
  const marks = new Map<UnitId, Map<number, Mark>>();
  for (const unit of units.values()) {
    if (unit.kind !== "hunk") continue;
    const byRow = new Map<number, Mark>();
    (numbers.get(unit.id) ?? []).forEach((n, row) => {
      const mark = n.new === null ? null : markOf(coverage, unit.path, n.new);
      if (mark !== null) byRow.set(row, mark);
    });
    if (byRow.size > 0) marks.set(unit.id, byRow);
  }
  const files = new Map<string, Tally>();
  const uncovered: Target[] = [];
  let branch = EMPTY;
  const perCommit = commits.map((commit) => {
    let tally = EMPTY;
    for (const file of filesOf(commit, units)) {
      for (const { unit } of file.parts) {
        if (unit.kind !== "hunk") continue;
        for (const row of rowsOf(unit.body, ownersOf(unit, owners), commit.index)) {
          if (row.kind !== "line" || !row.mine || unit.body[row.line]?.op !== "+") continue;
          const mark = marks.get(unit.id)?.get(row.line);
          if (mark === undefined) continue;
          tally = add(tally, mark);
          branch = add(branch, mark);
          const key = fileKey(commit.index, file.path);
          files.set(key, add(files.get(key) ?? EMPTY, mark));
          if (mark.kind === "uncovered")
            uncovered.push({ commit: commit.index, path: file.path, unit: unit.id, row: row.line });
        }
      }
    }
    return tally;
  });
  return {
    tip: coverage.tip,
    takenAt: coverage.takenAt,
    marks,
    commits: perCommit,
    files,
    branch,
    uncovered,
    stale: new Set(coverage.stale),
    tests: coverage.tests,
  };
}

/** Where a target sits against the reading line. */
export type Place = "above" | "at" | "below";

/**
 * The target x (1) or X (-1) goes to. From the one we are at, its neighbour; otherwise the first
 * below the reading line or the last above it. Either way round to the other end.
 */
export function stepUncovered(places: readonly Place[], dir: 1 | -1): number | null {
  const n = places.length;
  if (n === 0) return null;
  const at = places.indexOf("at");
  if (at !== -1) return (at + dir + n) % n;
  if (dir === 1) {
    const next = places.indexOf("below");
    return next === -1 ? 0 : next;
  }
  const previous = places.lastIndexOf("above");
  return previous === -1 ? n - 1 : previous;
}

/** The tests that ran a tip line, by id, or null when the run kept no per-test detail. */
export function testsOf(
  tests: Coverage["tests"],
  path: string,
  line: number,
):
  | {
      readonly id: string;
      readonly at: Loc | null;
      readonly preview: readonly string[] | null;
    }[]
  | null {
  if (tests === undefined) return null;
  return Object.entries(tests)
    .filter(([, test]) => test.lines[path]?.includes(line) ?? false)
    .map(([id, test]) => ({ id, at: test.at ?? null, preview: test.preview ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Where a test's first line shows on the page: the hunk row with that tip number and the commit
 * that shows it, its own commit for an added line, else the first commit with the hunk.
 */
export function locate(
  at: Loc,
  commits: readonly ProjectedCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
  numbers: ReadonlyMap<UnitId, readonly LineNumber[]>,
): { readonly unit: UnitId; readonly row: number; readonly commit: number } | null {
  for (const unit of units.values()) {
    if (unit.kind !== "hunk" || unit.path !== at.path) continue;
    const rows = numbers.get(unit.id) ?? [];
    const row = rows.findIndex((n) => n.new !== null && n.new >= at.start && n.new <= at.end);
    const line = unit.body[row];
    if (line === undefined) continue;
    const own = line.op === " " ? undefined : ownersOf(unit, owners)[line.change];
    const commit = own ?? commits.find((c) => c.refs.some((r) => r.unit === unit.id))?.index;
    if (commit !== undefined) return { unit: unit.id, row, commit };
  }
  return null;
}

/** A place for the jump or the peek, from where `locate` found it on the page. */
export function candidateAt(
  at: Loc,
  shown: ReturnType<typeof locate>,
  preview: readonly string[] = [],
): Candidate {
  return {
    path: at.path,
    newLine: at.start,
    kind: "other",
    unit: shown?.unit ?? null,
    row: shown?.row ?? null,
    commit: shown?.commit ?? null,
    preview,
  };
}

/** "2026-10-22 14:05" in the reader's time zone. */
export function takenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The body a Flag as missing test box starts with. */
export function missingTestDraft(path: string, line: number): string {
  return `Missing test: no test runs ${path}:${line}.`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * What a test id says about where the test lives: "tests/test_x.py::TestA::test_b" names the file
 * and test_b, "TestParse" only a name, "add rejects strings" neither the server can look up.
 */
export function testNameOf(id: string): {
  readonly path: string | null;
  readonly name: string | null;
} {
  const parts = id.split("::");
  const last = parts.at(-1) ?? id;
  return {
    path: parts.length > 1 ? (parts[0] ?? null) : null,
    name: IDENTIFIER.test(last) ? last : null,
  };
}
