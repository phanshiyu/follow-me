// Test data shared by the logic and page tests. Every call returns fresh objects.
// JSON.parse is the one brand-free way to build branded ids without a cast.

import type { Coverage } from "../lib/coverage.ts";
import type {
  Candidate,
  HunkLine,
  ProjectedCommit,
  Reply,
  ReportItem,
  Section,
  State,
  TextHunk,
  WireComment,
} from "../lib/wire.ts";

function branded<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}

export const HUNK = "h_7da8387be1bf";

/** src/lib.js with an import, a guard in add and one in mul, as the fixture branch writes it. */
export function aHunk(overrides: Partial<Omit<TextHunk, "kind">> = {}): TextHunk {
  const body: HunkLine[] = [
    { op: "+", text: "import { assertNumber } from './guard.js';\n", change: 0 },
    { op: "+", text: "\n", change: 1 },
    { op: " ", text: "export function add(a, b) {\n" },
    { op: "+", text: "  assertNumber(a);\n", change: 2 },
    { op: "+", text: "  assertNumber(b);\n", change: 3 },
    { op: " ", text: "  return a + b;\n" },
    { op: " ", text: "}\n" },
  ];
  return branded({
    kind: "hunk",
    id: HUNK,
    path: "src/lib.js",
    oldStart: 0,
    body,
    changeCount: 4,
    ...overrides,
  });
}

export function aCommit(
  index: number,
  overrides: Partial<ProjectedCommit> & { section?: Section } = {},
): ProjectedCommit {
  return branded({
    index,
    message: `Commit ${index + 1}\n\nWhy commit ${index + 1} exists.`,
    refs: [],
    changes: [],
    ...overrides,
  });
}

/** Two commits over one hunk: the import lands in the first, the guards in the second. */
export function aState(overrides: Partial<State> = {}): State {
  return branded({
    mode: "split",
    anchor: {
      schema: "follow-me/session@1",
      branch: "feature",
      baseRef: "main",
      base: "a".repeat(40),
      tip: "b".repeat(40),
      tipTree: "c".repeat(40),
    },
    version: 1,
    planHash: "hash",
    commits: [
      aCommit(0, {
        message: "Add the number guard import",
        refs: [{ unit: aHunk().id, select: { kind: "lines", changes: [0, 1] } }],
      }),
      aCommit(1, {
        message: "Guard add\n\nadd now rejects strings.",
        narration: "Look at the order of the checks.",
        refs: [{ unit: aHunk().id, select: { kind: "lines", changes: [2, 3] } }],
      }),
    ],
    units: [aHunk()],
    comments: [],
    concerns: [],
    resolved: [],
    seq: 0,
    previous: null,
    ...overrides,
  });
}

export function aComment(overrides: Partial<WireComment> = {}): WireComment {
  return branded({
    id: "c_aaaaaa",
    anchor: { kind: "hunk", unit: HUNK, commit: 1, changes: [2], offsets: [3] },
    context: { commitMessage: "Guard add", path: "src/lib.js", lines: ["  assertNumber(a);"] },
    body: "Why check a before b?",
    createdAt: "2026-10-21T10:00:00.000Z",
    kind: "question",
    ...overrides,
  });
}

export function aReply(overrides: Partial<Reply> = {}): Reply {
  return branded({
    id: "r_aaaaaa",
    author: "agent",
    body: "Because **a** is read first.",
    createdAt: "2026-10-21T10:01:00.000Z",
    ...overrides,
  });
}

export function aReportItem(overrides: Partial<ReportItem> = {}): ReportItem {
  return branded({
    path: "src/lib.js",
    oldPath: "src/lib.js",
    newLine: 5,
    oldLine: null,
    startNewLine: 4,
    startOldLine: null,
    severity: "major",
    kind: "flag",
    body: "**major**\n\nGuard both arguments in one call.",
    thread: [{ author: "reviewer", body: "Guard both arguments in one call." }],
    resolved: false,
    excluded: false,
    ...overrides,
  });
}

/** The two-commit state with six more commits after it, so the page is long enough to scroll. */
export function aLongState(overrides: Partial<State> = {}): State {
  const base = aState();
  return aState({
    commits: [
      ...base.commits,
      ...Array.from({ length: 6 }, (_, i) =>
        aCommit(i + 2, {
          message: `Step ${i + 3}`,
          refs: [{ unit: aHunk().id, select: { kind: "lines", changes: [i + 10] } }],
        }),
      ),
    ],
    ...overrides,
  });
}

/** Where `assertNumber` is defined: src/guard.js, added by commit 1 of a long state. */
export function aCandidate(
  overrides: Partial<Omit<Candidate, "path">> & { path?: string } = {},
): Candidate {
  return branded({
    path: "src/guard.js",
    newLine: 1,
    kind: "function",
    unit: null,
    row: null,
    commit: null,
    preview: [
      "export function assertNumber(x) {",
      "  if (typeof x !== 'number') throw new TypeError('not a number');",
      "}",
    ],
    ...overrides,
  });
}

/**
 * A run over aState's src/lib.js at the tip. The import ran, the blank line is not executable,
 * assertNumber(a) ran with one of its two branches, assertNumber(b) never ran.
 */
export function aCoverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    tip: "b164dd3".padEnd(40, "0"),
    takenAt: "2026-10-22T06:05:00.000Z",
    files: {
      "src/lib.js": {
        lines: { "1": 1, "3": 1, "4": 14, "5": 0, "6": 14 },
        branches: { "4": [1, 2] },
      },
    },
    stale: [],
    ...overrides,
  };
}
