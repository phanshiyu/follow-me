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

/**
 * Every state in the map's order, then every transition. With `edges`, the transitions no test
 * takes come first, so the gaps head the moves.
 */
export function rowsOfMap(map: StateMap, edges?: readonly EdgeMark[]): MachineRow[] {
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
  const gap = (i: number) => (edges?.[i]?.kind === "uncovered" ? 0 : 1);
  const order = moves.map((_, i) => i).sort((a, b) => gap(a) - gap(b));
  return [...states, ...order.flatMap((i) => moves[i] ?? [])];
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

export type EdgeMarkKind = "covered" | "uncovered" | "unknown";

/**
 * What the run says about one transition. With per-test runs, its tests are those that ran every
 * executable line of its `at`, and it is covered when there is one. With an aggregate run only,
 * it is covered when every such line ran, and names no tests.
 */
export type EdgeMark = {
  readonly kind: EdgeMarkKind;
  /** Executable mapped lines, and how many of them the run reached. */
  readonly run: number;
  readonly total: number;
  readonly tests: readonly string[];
};

const UNKNOWN_EDGE: EdgeMark = { kind: "unknown", run: 0, total: 0, tests: [] };

/** Whether the run kept one entry per test, which edge tests and sequences need. */
export function hasPerTest(coverage: Coverage | null): boolean {
  return coverage !== null && Object.keys(coverage.tests ?? {}).length > 0;
}

/** A transition's mark. Unknown without a run, an empty `at`, nothing executable, or a stale file. */
export function markOfEdge(coverage: Coverage | null, at: readonly Loc[]): EdgeMark {
  if (coverage === null || at.some((loc) => coverage.stale.includes(loc.path))) return UNKNOWN_EDGE;
  const lines: { readonly path: string; readonly line: number }[] = [];
  let run = 0;
  for (const loc of at) {
    for (let line = loc.start; line <= loc.end; line += 1) {
      const mark = markOf(coverage, loc.path, line);
      if (mark === null) continue;
      lines.push({ path: loc.path, line });
      if (mark.kind !== "uncovered") run += 1;
    }
  }
  const total = lines.length;
  if (total === 0) return UNKNOWN_EDGE;
  if (!hasPerTest(coverage)) {
    return { kind: run === total ? "covered" : "uncovered", run, total, tests: [] };
  }
  const tests = Object.entries(coverage.tests ?? {})
    .filter(([, test]) => lines.every(({ path, line }) => test.lines[path]?.includes(line)))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
  return { kind: tests.length > 0 ? "covered" : "uncovered", run, total, tests };
}

/** "taken by 2 tests", "no test takes it", or "covered" without per-test runs. */
export function describeEdgeMark(mark: EdgeMark, perTest: boolean): string {
  if (mark.kind === "unknown") return "coverage unknown";
  if (!perTest) return mark.kind === "covered" ? "covered" : "not covered";
  if (mark.kind === "uncovered") return "no test takes it";
  return `taken by ${mark.tests.length === 1 ? "1 test" : `${mark.tests.length} tests`}`;
}

/** A run of transitions from the initial state, by their index in the map, and the states it visits. */
export type Sequence = { readonly moves: readonly number[]; readonly states: readonly string[] };

/** The longest sequence considered, in transitions. */
const MAX_STEPS = 5;

/** The states a stateDiagram starts in (`[*] --> X`) and ends in (`X --> [*]`). */
export function endsOf(source: string): { initial: string[]; final: string[] } {
  const initial: string[] = [];
  const final: string[] = [];
  for (const line of source.split("\n")) {
    const start = /^\s*\[\*\]\s*-->\s*([^\s:[]+)/.exec(line)?.[1];
    const end = /^\s*([^\s:[]+)\s*-->\s*\[\*\]/.exec(line)?.[1];
    if (start !== undefined) initial.push(start);
    if (end !== undefined) final.push(end);
  }
  return { initial, final };
}

/**
 * Sequences every step of which some test takes, but no one test takes them all: walks from the
 * initial state (the diagram's `[*] -->`, else the map's first state) to a final state (`--> [*]`,
 * or one nothing leaves), up to five transitions, never repeating one, so each cycle is taken at
 * most once. A sequence with a step no test takes is left out; its red edge already says so.
 * Shortest first.
 */
export function notDriven(map: StateMap, source: string, marks: readonly EdgeMark[]): Sequence[] {
  const transitions = map.transitions ?? [];
  const names = Object.keys(map.states);
  const { initial, final } = endsOf(source);
  const starts = initial.filter((name) => names.includes(name));
  const first = names[0];
  const from = starts.length > 0 ? starts : first === undefined ? [] : [first];
  const leaving = (state: string) => transitions.flatMap((t, i) => (t.from === state ? [i] : []));
  const ends = new Set([...final, ...names.filter((name) => leaving(name).length === 0)]);
  const testsOf = (i: number) => marks[i]?.tests ?? [];
  const found: Sequence[] = [];
  const walk = (state: string, moves: readonly number[], states: readonly string[]) => {
    if (moves.length >= 2 && ends.has(state)) {
      const [head = -1, ...rest] = moves;
      const driven = testsOf(head).some((test) => rest.every((i) => testsOf(i).includes(test)));
      if (!driven) found.push({ moves, states });
    }
    if (moves.length === MAX_STEPS) return;
    for (const i of leaving(state)) {
      const to = transitions[i]?.to;
      if (to === undefined || moves.includes(i) || testsOf(i).length === 0) continue;
      walk(to, [...moves, i], [...states, to]);
    }
  };
  for (const start of new Set(from)) walk(start, [], [start]);
  return found.sort(
    (a, b) => a.moves.length - b.moves.length || a.states.join().localeCompare(b.states.join()),
  );
}

/** An edge Mermaid drew: its SVG id, the states nearest its two ends, and its label text. */
export type DrawnEdge = {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly label: string;
};

/**
 * The drawn edge of each transition, by its index in the map. An edge matches on its two states;
 * when several join the same pair, the one labelled with the event wins. A transition whose ends
 * could not be placed falls back to the one edge carrying its event as label. Each edge is used
 * once, and a transition that matches nothing is left out: the table still reaches it.
 */
export function edgesOfMap(
  transitions: readonly { readonly from: string; readonly to: string; readonly event?: string }[],
  drawn: readonly DrawnEdge[],
): Map<number, string> {
  const used = new Set<string>();
  const found = new Map<number, string>();
  transitions.forEach((t, i) => {
    const event = t.event?.trim() ?? "";
    const pair = drawn.filter((e) => !used.has(e.id) && e.from === t.from && e.to === t.to);
    const labelled = drawn.filter((e) => event !== "" && e.label.trim() === event);
    const only = labelled.length === 1 ? labelled[0] : undefined;
    const edge =
      pair.find((e) => e.label.trim() === event) ??
      pair[0] ??
      (only !== undefined && !used.has(only.id) ? only : undefined);
    if (edge === undefined) return;
    used.add(edge.id);
    found.set(i, edge.id);
  });
  return found;
}
