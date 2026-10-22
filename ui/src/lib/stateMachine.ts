// A state diagram tied to code: each state's and transition's coverage, derived only from the test
// run over its mapped tip lines, the rows of the table under the diagram, and the Mermaid node
// that draws each state. Pure.

import { type Coverage, candidateAt, type Loc, locate, markOf, testsOf } from "./coverage.ts";
import type { LineNumber } from "./rows.ts";
import type { Candidate, ProjectedCommit, StateMap, Unit, UnitId } from "./wire.ts";

export type StateMarkKind = "covered" | "partly" | "uncovered" | "unknown";

export type StateMark = {
  readonly kind: StateMarkKind;
  /** Executable mapped lines, and how many of them the run reached. */
  readonly run: number;
  readonly total: number;
  /** The tests that reached any mapped line, when the run kept per-test detail. */
  readonly tests: readonly string[];
};

const UNKNOWN: StateMark = { kind: "unknown", run: 0, total: 0, tests: [] };

/**
 * Covered when the run hit every executable mapped line with every branch taken; partly when it
 * hit some, or took only some branches; not covered when it hit none. Unknown without a run, with
 * nothing executable, or when a mapped file changed since the run.
 */
export function markOfPlaces(coverage: Coverage | null, at: readonly Loc[]): StateMark {
  if (coverage === null || at.some((loc) => coverage.stale.includes(loc.path))) return UNKNOWN;
  let run = 0;
  let total = 0;
  let partly = false;
  const tests = new Set<string>();
  for (const loc of at) {
    for (let line = loc.start; line <= loc.end; line += 1) {
      const mark = markOf(coverage, loc.path, line);
      if (mark === null) continue;
      total += 1;
      if (mark.kind === "uncovered") continue;
      run += 1;
      if (mark.kind === "partly") partly = true;
      for (const test of testsOf(coverage.tests, loc.path, line) ?? []) tests.add(test.id);
    }
  }
  if (total === 0) return UNKNOWN;
  const kind = run === 0 ? "uncovered" : run < total || partly ? "partly" : "covered";
  return { kind, run, total, tests: [...tests].sort() };
}

/** The shape each mark has besides its colour, in the SVG badge, the table and the legend. */
export const BADGE: Readonly<Record<StateMarkKind, string>> = {
  covered: "✓",
  partly: "◐",
  uncovered: "✕",
  unknown: "",
};

const WORDS: Readonly<Record<StateMarkKind, string>> = {
  covered: "covered",
  partly: "partly covered",
  uncovered: "not covered",
  unknown: "coverage unknown",
};

/** "partly covered, 3 of 5 lines" for a screen reader and the table. */
export function describeStateMark(mark: StateMark): string {
  if (mark.kind === "unknown") return WORDS.unknown;
  const lines = mark.total === 1 ? "line" : "lines";
  return `${WORDS[mark.kind]}, ${mark.run} of ${mark.total} ${lines}`;
}

/** One row of the table under the diagram: a state, or a move from one state to another. */
export type MachineRow = {
  readonly key: string;
  readonly kind: "state" | "move";
  /** "Uploading", or "Uploading → Done". */
  readonly name: string;
  readonly event: string | null;
  readonly at: readonly Loc[];
};

/** Every state in the map's order, then every transition. */
export function rowsOfMap(map: StateMap): MachineRow[] {
  const states = Object.entries(map.states).map(
    ([name, at]): MachineRow => ({ key: `s:${name}`, kind: "state", name, event: null, at }),
  );
  const moves = (map.transitions ?? []).map(
    (t, i): MachineRow => ({
      key: `t:${i}`,
      kind: "move",
      name: `${t.from} → ${t.to}`,
      event: t.event ?? null,
      at: t.at,
    }),
  );
  return [...states, ...moves];
}

/** "src/upload.tsx:30-41", or ":30" for one line. */
export function placeLabel(loc: Loc): string {
  return `${loc.path}:${loc.start}${loc.end > loc.start ? `-${loc.end}` : ""}`;
}

/**
 * Where each mapped place shows on the page, for the definition jump: a hunk row when a commit
 * shows the lines, a peek otherwise. Places that land on the same row count once.
 */
export function candidatesOf(
  at: readonly Loc[],
  commits: readonly ProjectedCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
  numbers: ReadonlyMap<UnitId, readonly LineNumber[]>,
): Candidate[] {
  const seen = new Set<string>();
  return at.flatMap((loc) => {
    const candidate = candidateAt(loc, locate(loc, commits, units, owners, numbers));
    const key =
      candidate.unit === null
        ? `${loc.path}:${loc.start}`
        : `${candidate.commit}|${candidate.unit}|${candidate.row}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate];
  });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The SVG element id of each state Mermaid drew, by the name the map uses. Mermaid's
 * stateDiagram-v2 (12.x) ids its nodes `<svg id>-state-<state id>-<n>`; a map that names a state
 * by its label ("Retry wait" for `state "Retry wait" as RetryWait`) matches by the node's text.
 * A name that matches nothing is left out, and the table still reaches it.
 */
export function stateNodes(
  svgId: string,
  nodes: readonly { readonly id: string; readonly text: string }[],
  names: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of names) {
    const byId = new RegExp(`^${escapeRegExp(svgId)}-state-${escapeRegExp(name)}-\\d+$`);
    const node =
      nodes.find((n) => byId.test(n.id)) ??
      nodes.find((n) => n.id.startsWith(`${svgId}-state-`) && n.text.trim() === name);
    if (node !== undefined) found.set(name, node.id);
  }
  return found;
}
