// Picking rows of a hunk to comment on, and the anchor a pick becomes on the wire. Pure.

import type { Anchor, HunkLine, UnitId } from "./wire.ts";

/** from is the row a range started at; lines are the picked rows as body indices, sorted. */
export type Pick = { readonly from: number; readonly lines: readonly number[] };

/** Every shown row between two rows, both ends included. Folded rows are not shown, so skip. */
export function selectionRange(visible: readonly number[], from: number, to: number): number[] {
  const [low, high] = from <= to ? [from, to] : [to, from];
  return visible.filter((row) => row >= low && row <= high);
}

/**
 * The pick after a click or a key on a row. Extending keeps where the range started and moves the
 * other end. Choosing the only picked row again clears the pick.
 */
export function pickRow(
  visible: readonly number[],
  current: Pick | null,
  row: number,
  extend: boolean,
): Pick | null {
  if (extend && current !== null) {
    return { from: current.from, lines: selectionRange(visible, current.from, row) };
  }
  if (current !== null && current.lines.length === 1 && current.lines[0] === row) return null;
  return { from: row, lines: [row] };
}

/** The shown row an arrow key moves to, or the same row at an end. */
export function stepRow(visible: readonly number[], row: number, delta: 1 | -1): number {
  const at = visible.indexOf(row);
  if (at === -1) return visible[0] ?? row;
  return visible[Math.max(0, Math.min(visible.length - 1, at + delta))] ?? row;
}

/**
 * A pick on the wire. offsets are the picked rows; changes the change indices among them this
 * commit owns, so context and other commits' lines add an offset and no change.
 */
export function anchorFor(
  hunk: {
    readonly id: UnitId;
    readonly commit: number;
    readonly body: readonly HunkLine[];
    readonly owners: readonly (number | undefined)[];
  },
  picked: readonly number[],
): Anchor {
  const offsets = [...new Set(picked)].sort((a, b) => a - b);
  const changes = offsets.flatMap((i) => {
    const row = hunk.body[i];
    return row === undefined || row.op === " " || hunk.owners[row.change] !== hunk.commit
      ? []
      : [row.change];
  });
  return { kind: "hunk", unit: hunk.id, commit: hunk.commit, changes, offsets };
}

/** The picked rows as text, for the comment's snapshot. */
export function snapshotRows(body: readonly HunkLine[], picked: readonly number[]): string[] {
  return [...picked]
    .sort((a, b) => a - b)
    .flatMap((i) => {
      const row = body[i];
      return row === undefined ? [] : [row.text.replace(/\n$/, "")];
    });
}

/** Body indices of the change lines asked for, skipping any the unit does not have. */
export function bodyIndexes(body: readonly HunkLine[], changes: readonly number[]): number[] {
  const wanted = new Set(changes);
  return body.flatMap((line, i) => (line.op !== " " && wanted.has(line.change) ? [i] : []));
}

/**
 * The rows a hunk anchor points at. Offsets name them exactly; older comments carry change
 * indices only, and a whole-hunk comment points at none in particular.
 */
export function rowsOfAnchor(
  anchor: { readonly changes: readonly number[] | null; readonly offsets?: readonly number[] },
  body: readonly HunkLine[],
): number[] {
  if (anchor.offsets !== undefined) return anchor.offsets.filter((i) => i < body.length);
  if (anchor.changes === null) return [];
  return bodyIndexes(body, anchor.changes);
}

/** The shown row a card sits under: the last of its rows that is shown, else null. */
export function lastShown(rows: readonly number[], shown: ReadonlySet<number>): number | null {
  return rows.filter((i) => shown.has(i)).at(-1) ?? null;
}

/**
 * The rows a text selection covers, given the rows its two ends sit in. Either end may be outside
 * any row (null), and then the selection is not a pick.
 */
export function rowsBetween(
  visible: readonly number[],
  anchorRow: number | null,
  focusRow: number | null,
): Pick | null {
  if (anchorRow === null || focusRow === null) return null;
  return { from: anchorRow, lines: selectionRange(visible, anchorRow, focusRow) };
}
