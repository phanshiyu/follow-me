// Where the previous version's threads sit in the current plan. Pure.

import { type LineNumber, lineNumbers, ownership, ownersOf, rowsOf } from "./rows.ts";
import { lastShown } from "./selection.ts";
import type {
  Carried,
  HunkLine,
  ProjectedCommit,
  State,
  Unit,
  UnitId,
  WireComment,
} from "./wire.ts";

export type CarriedKind = "same" | "changed" | "gone";

export type Placement = {
  readonly comment: WireComment;
  readonly carried: Carried;
  readonly kind: CarriedKind;
  /** The commit the card sits in; null puts it in the branch discussion. */
  readonly commit: number | null;
  /** The hunk the card sits in, or null for the commit's own area under its message. */
  readonly unit: UnitId | null;
  /** The body row it sits under inside that hunk, or null when no row of it is shown. */
  readonly row: number | null;
};

function holders(commits: readonly ProjectedCommit[], unit: UnitId): number[] {
  return commits.flatMap((c) => (c.refs.some((r) => r.unit === unit) ? [c.index] : []));
}

/** The commit that last showed a file: the last one with any unit on that path. */
function lastHolder(
  commits: readonly ProjectedCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  path: string | null,
): number | null {
  if (path === null) return null;
  const at = commits.filter((c) => c.refs.some((r) => units.get(r.unit)?.path === path));
  return at.at(-1)?.index ?? null;
}

/**
 * The row of a hunk nearest a line of the branch tip. A changed hunk arrives without offsets, only
 * the tip line the comment now points at; a removed row has no tip line and is never chosen.
 */
export function rowsAtLine(
  body: readonly HunkLine[],
  numbers: readonly LineNumber[],
  line: number | null,
): number[] {
  if (line === null) return [];
  let best = -1;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [i, row] of body.entries()) {
    const at = numbers[i]?.new;
    if (row.op === "-" || at === null || at === undefined) continue;
    if (Math.abs(at - line) < nearest) {
      best = i;
      nearest = Math.abs(at - line);
    }
  }
  return best === -1 ? [] : [best];
}

/**
 * One placement per carried comment of the previous version.
 *
 * - Code still there: the commit that owns one of the carried rows, else the first to show the
 *   unit, and the last of those rows that commit shows. Changed code sits in the same place.
 * - Code gone: the commit that last held the path, else the branch discussion.
 */
export function placeCarried(state: State): Placement[] {
  const { carried = [], commits } = state;
  const units = new Map(state.units.map((u) => [u.id, u]));
  const owners = ownership(commits);
  const numbers = lineNumbers(state.units);
  return carried.flatMap((entry): Placement[] => {
    const { comment } = entry;
    const unit = entry.unit === null ? undefined : units.get(entry.unit);
    if (entry.unit === null || unit === undefined) {
      const commit = lastHolder(commits, units, entry.path);
      return [{ comment, carried: entry, kind: "gone", commit, unit: null, row: null }];
    }
    const kind: CarriedKind = entry.changed ? "changed" : "same";
    const shown = holders(commits, unit.id);
    if (unit.kind !== "hunk") {
      const commit = shown[0] ?? lastHolder(commits, units, entry.path);
      return [{ comment, carried: entry, kind, commit, unit: null, row: null }];
    }
    const offsets =
      entry.offsets ?? rowsAtLine(unit.body, numbers.get(unit.id) ?? [], entry.newLine);
    const own = ownersOf(unit, owners);
    const owning = shown.find((index) =>
      offsets.some((i) => {
        const line = unit.body[i];
        return line !== undefined && line.op !== " " && own[line.change] === index;
      }),
    );
    const commit = owning ?? shown[0] ?? null;
    if (commit === null) {
      const last = lastHolder(commits, units, entry.path);
      return [{ comment, carried: entry, kind: "gone", commit: last, unit: null, row: null }];
    }
    const visible = rowsOf(unit.body, own, commit).flatMap((r) =>
      r.kind === "line" ? [r.line] : [],
    );
    const row = lastShown(offsets, new Set(visible));
    return [{ comment, carried: entry, kind, commit, unit: unit.id, row }];
  });
}

/** "Plan v3 arrived: 2 threads moved to changed code", or just the arrival when none moved. */
export function arrival(version: number, carried: readonly Carried[]): string {
  const moved = carried.filter((c) => c.changed || c.unit === null).length;
  if (moved === 0) return `Plan v${version} arrived`;
  return `Plan v${version} arrived: ${moved} thread${moved === 1 ? "" : "s"} moved to changed code`;
}
