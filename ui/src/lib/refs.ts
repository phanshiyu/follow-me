// Where the code an agent's words point at sits on this page: which rows of which commit show it,
// or why none do. Pure.

import { type LineNumber, ownersOf, rowsOf } from "./rows.ts";
import type { CodeRef, ProjectedCommit, Unit, UnitId } from "./wire.ts";

/** One hunk row a ref covers, in the commit that shows it. */
export type RefTarget = { readonly commit: number; readonly unit: UnitId; readonly row: number };

/**
 * "on": the page shows the lines; commit is where the whole range reads, and the jump lands on
 * its first target there. "off": the branch leaves the lines alone, so only the quote shows them.
 * "stale": the tip moved since the agent wrote it, so the lines may be different code now.
 */
export type PlacedRef =
  | {
      readonly kind: "on";
      readonly ref: CodeRef;
      readonly commit: number;
      readonly targets: readonly RefTarget[];
    }
  | { readonly kind: "off"; readonly ref: CodeRef }
  | { readonly kind: "stale"; readonly ref: CodeRef };

const GRAMMAR = /^(.+):(\d+)(?:-(\d+))?(?:@(\d+|base))?$/;

function keyOf(path: string, start: number, end: number, at: CodeRef["at"]): string {
  return `${path}:${start}-${end}@${at ?? "tip"}`;
}

/** The number of the ref an inline code span writes, or null when it writes none of them. */
export function refNumberOf(text: string, refs: readonly CodeRef[]): number | null {
  const m = GRAMMAR.exec(text);
  const [, path, startRaw, endRaw, atRaw] = m ?? [];
  if (path === undefined || startRaw === undefined) return null;
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  const at = atRaw === undefined ? null : atRaw === "base" ? "base" : Number(atRaw);
  const key = keyOf(path, start, end, at);
  return refs.find((r) => keyOf(r.path, r.start, r.end, r.at) === key)?.n ?? null;
}

const within = (n: number | null | undefined, span: CodeRef["lines"]) =>
  n !== null && n !== undefined && span !== null && n >= span.start && n <= span.end;

/** Where a ref's lines show on the page for this plan and tip. */
export function placeRef(
  ref: CodeRef,
  tip: string,
  commits: readonly ProjectedCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
  numbers: ReadonlyMap<UnitId, readonly LineNumber[]>,
): PlacedRef {
  if (ref.tip !== tip) return { kind: "stale", ref };
  const found: { unit: UnitId; row: number; owner: number; shownIn: (c: number) => boolean }[] = [];
  for (const unit of units.values()) {
    if (unit.kind !== "hunk" || unit.path !== ref.path) continue;
    const at = numbers.get(unit.id) ?? [];
    const own = ownersOf(unit, owners);
    const first = commits.find((c) => c.refs.some((r) => r.unit === unit.id))?.index;
    const shownIn = (row: number) => (c: number) =>
      commits[c]?.refs.some((r) => r.unit === unit.id) === true &&
      rowsOf(unit.body, own, c).some((r) => r.kind === "line" && r.line === row);
    unit.body.forEach((line, row) => {
      const n = at[row];
      const hit =
        (line.op !== "-" && within(n?.new, ref.lines)) ||
        (line.op !== "+" && within(n?.old, ref.old));
      const owner = line.op === " " ? first : own[line.change];
      if (hit && owner !== undefined)
        found.push({ unit: unit.id, row, owner, shownIn: shownIn(row) });
    });
  }
  if (found.length === 0) return { kind: "off", ref };
  // Lines an earlier commit wrote read as context in a later one, so the last owner shows them all.
  const commit = Math.max(...found.map((f) => f.owner));
  const targets = found.map((f) => ({
    commit: f.shownIn(commit) ? commit : f.owner,
    unit: f.unit,
    row: f.row,
  }));
  return { kind: "on", ref, commit, targets };
}

/** The first row a jump to the ref lands on. */
export function landing(placed: PlacedRef): RefTarget | null {
  return placed.kind === "on"
    ? (placed.targets.find((t) => t.commit === placed.commit) ?? null)
    : null;
}

function lines(ref: CodeRef): string {
  return ref.end > ref.start ? `${ref.start}-${ref.end}` : `${ref.start}`;
}

/** "checkout.ts:42-48", the chip's words; the full path is its title. */
export function refLabel(ref: CodeRef): string {
  return `${ref.path.split("/").at(-1) ?? ref.path}:${lines(ref)}`;
}

/** "src/checkout.ts:42-48@5", as the agent wrote it. */
export function refPlace(ref: CodeRef): string {
  return `${ref.path}:${lines(ref)}${ref.at === null ? "" : `@${ref.at}`}`;
}

/**
 * What the chip says after the place: the commit that shows it when that is not the reply's own,
 * the tip it was written on when it went stale, nothing otherwise.
 */
export function refWhere(placed: PlacedRef, own: number | null): string | null {
  if (placed.kind === "stale") return `from ${placed.ref.tip.slice(0, 7)}`;
  if (placed.kind === "off" || placed.commit === own) return null;
  return `commit ${placed.commit + 1}`;
}
