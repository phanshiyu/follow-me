// How a hunk reads inside one commit: which rows are its own change, which are context, which fold
// away to the commit that brings them, and the file line numbers each row carries. Pure.

import type { HunkLine, ProjectedCommit, TextHunk, Unit, UnitId } from "./wire.ts";

export type Row =
  | { readonly kind: "line"; readonly line: number; readonly mine: boolean }
  | { readonly kind: "fold"; readonly lines: readonly number[]; readonly commit: number };

export type LineNumber = { readonly old: number | null; readonly new: number | null };

/** The commit that owns each change index, per unit. A "rest" ref owns what no other ref takes. */
export function ownership(commits: readonly ProjectedCommit[]): Map<UnitId, Map<number, number>> {
  const owners = new Map<UnitId, Map<number, number>>();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.select.kind !== "lines") continue;
      const byChange = owners.get(ref.unit) ?? new Map<number, number>();
      for (const change of ref.select.changes) byChange.set(change, commit.index);
      owners.set(ref.unit, byChange);
    }
  }
  return owners;
}

/** Owning commit per change index of one hunk, undefined for a line nobody owns. */
export function ownersOf(
  hunk: TextHunk,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
): (number | undefined)[] {
  const byChange = owners.get(hunk.id);
  return Array.from({ length: hunk.changeCount }, (_, c) => byChange?.get(c));
}

/**
 * How a hunk reads in one commit. The commit's own lines are the change. Lines earlier commits
 * added are now part of the file and read as context; lines they removed are gone. Lines later
 * commits remove are still there as context, and lines later commits add fold into one row per
 * run and owner.
 */
export function rowsOf(
  body: readonly HunkLine[],
  owners: readonly (number | undefined)[],
  commit: number,
): Row[] {
  const rows: Row[] = [];
  body.forEach((line, i) => {
    const owner = line.op === " " ? undefined : owners[line.change];
    if (line.op === " " || owner === undefined || owner === commit) {
      rows.push({ kind: "line", line: i, mine: owner === commit });
      return;
    }
    const later = owner > commit;
    if (line.op === "-" ? later : !later) {
      rows.push({ kind: "line", line: i, mine: false });
      return;
    }
    if (line.op === "-") return;
    const last = rows.at(-1);
    if (last?.kind === "fold" && last.commit === owner) {
      rows[rows.length - 1] = { ...last, lines: [...last.lines, i] };
    } else rows.push({ kind: "fold", lines: [i], commit: owner });
  });
  return rows;
}

/**
 * File line numbers of every hunk row, 1-based: old in the base, new in the branch tip. These are
 * the numbers a merge request shows against the same base. A hunk's tip start is its base start
 * shifted by what earlier hunks of the same file add or remove.
 */
export function lineNumbers(units: readonly Unit[]): Map<UnitId, LineNumber[]> {
  const numbers = new Map<UnitId, LineNumber[]>();
  const hunks = units.flatMap((u) => (u.kind === "hunk" ? [u] : []));
  const shift = new Map<string, number>();
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    let oldLine = hunk.oldStart + 1;
    let newLine = hunk.oldStart + 1 + (shift.get(hunk.path) ?? 0);
    numbers.set(
      hunk.id,
      hunk.body.map((line) => {
        if (line.op === "-") return { old: oldLine++, new: null };
        if (line.op === "+") return { old: null, new: newLine++ };
        return { old: oldLine++, new: newLine++ };
      }),
    );
    const delta = hunk.body.reduce((d, l) => d + (l.op === "+" ? 1 : l.op === "-" ? -1 : 0), 0);
    shift.set(hunk.path, (shift.get(hunk.path) ?? 0) + delta);
  }
  return numbers;
}

const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|def|fn|func|interface|struct|enum|impl|trait|module)\s+([A-Za-z_$][\w$]*)/;

/** The function or class a row sits in: the nearest declaration at or above it, removals skipped. */
export function scopeOf(body: readonly HunkLine[], last: number): string | null {
  for (let i = last; i >= 0; i -= 1) {
    const line = body[i];
    if (line === undefined || line.op === "-") continue;
    const name = DECLARATION.exec(line.text)?.[1];
    if (name !== undefined) return name;
  }
  return null;
}

/** "17", "17-18" or "17-18, 20": ascending numbers with runs collapsed. */
function ranges(ns: readonly number[]): string {
  const parts: [number, number][] = [];
  for (const n of ns) {
    const last = parts.at(-1);
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else parts.push([n, n]);
  }
  return parts.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/**
 * How a comment names its rows: tip numbers, removed rows by their base number. "line 4",
 * "lines 4-5", "lines 4-5, old 3", "old line 3".
 */
export function describeRows(
  body: readonly HunkLine[],
  numbers: readonly LineNumber[],
  rows: readonly number[],
): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const added: number[] = [];
  const removed: number[] = [];
  for (const i of sorted) {
    const at = numbers[i];
    if (body[i]?.op === "-") {
      if (at?.old != null) removed.push(at.old);
    } else if (at?.new != null) added.push(at.new);
  }
  const many = added.length + removed.length > 1;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${many ? "lines" : "line"} ${ranges(added)}`);
  if (removed.length > 0) {
    const label = added.length > 0 ? "old" : many ? "old lines" : "old line";
    parts.push(`${label} ${ranges(removed)}`);
  }
  return parts.join(", ");
}

/** Lines changed in one commit: added and removed rows it owns. */
export function commitStats(
  commit: ProjectedCommit,
  units: ReadonlyMap<UnitId, Unit>,
  owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>,
): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const ref of commit.refs) {
    const unit = units.get(ref.unit);
    if (unit?.kind !== "hunk") continue;
    const own = ownersOf(unit, owners);
    for (const line of unit.body) {
      if (line.op === " " || own[line.change] !== commit.index) continue;
      if (line.op === "+") added += 1;
      else removed += 1;
    }
  }
  return { added, removed };
}
