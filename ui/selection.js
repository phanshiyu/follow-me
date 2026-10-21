// @ts-check
// Pure logic for picking rows of a hunk to comment on: which rows a click, a shift-click, a drag
// or an arrow key picks, and the anchor a pick becomes on the wire. No DOM, no fetch.

import { bodyIndexes } from "./concerns.js";

/**
 * @typedef {{ op: " ", text: string } | { op: "+" | "-", text: string, change: number }} BodyRow
 * @typedef {{ from: number, lines: number[] }} Pick from is the row a range started at, lines
 *   the picked rows as hunk body indices, sorted
 * @typedef {{ id: string, commit: number, body: readonly BodyRow[],
 *   owners: readonly (number | undefined)[] }} Hunk one hunk as one commit shows it; owners
 *   holds the commit that owns each change index
 */

/**
 * Every row between two rows of a hunk, both ends included, among the rows the hunk shows.
 * Folded rows are not shown, so a range across a fold skips them.
 * @param {readonly number[]} visible body indices of the shown rows, in order
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
export function selectionRange(visible, from, to) {
  const [low, high] = from <= to ? [from, to] : [to, from];
  return visible.filter((row) => row >= low && row <= high);
}

/**
 * The pick after a click or a key on a row. Extending keeps the row the range started at and
 * moves its other end. Choosing the only picked row again clears the pick. A pick never crosses
 * hunks, so the caller passes null as the current pick when the row is in another one.
 * @param {readonly number[]} visible
 * @param {Pick | null} current
 * @param {number} row
 * @param {{ extend: boolean }} how
 * @returns {Pick | null}
 */
export function pickRow(visible, current, row, { extend }) {
  if (extend && current !== null) {
    return { from: current.from, lines: selectionRange(visible, current.from, row) };
  }
  if (current !== null && current.lines.length === 1 && current.lines[0] === row) return null;
  return { from: row, lines: [row] };
}

/**
 * The row an arrow key moves to: the next shown row in that direction, or the same row at an end.
 * @param {readonly number[]} visible
 * @param {number} row
 * @param {1 | -1} delta
 */
export function stepRow(visible, row, delta) {
  const at = visible.indexOf(row);
  if (at === -1) return visible[0] ?? row;
  return visible[Math.max(0, Math.min(visible.length - 1, at + delta))] ?? row;
}

/**
 * What a pick is on the wire. offsets are the picked rows, changes the change indices among them
 * that this commit owns. Context, and lines other commits own, add an offset and no change, so a
 * pick of context alone has changes [].
 * @param {Hunk} hunk
 * @param {readonly number[]} picked
 */
export function anchorFor(hunk, picked) {
  const offsets = [...new Set(picked)].sort((a, b) => a - b);
  const changes = offsets.flatMap((i) => {
    const row = hunk.body[i];
    return row === undefined || row.op === " " || hunk.owners[row.change] !== hunk.commit
      ? []
      : [row.change];
  });
  return {
    kind: /** @type {const} */ ("hunk"),
    unit: hunk.id,
    commit: hunk.commit,
    changes,
    offsets,
  };
}

/**
 * The picked rows as text, for the comment's snapshot.
 * @param {readonly BodyRow[]} body
 * @param {readonly number[]} picked
 * @returns {string[]}
 */
export function snapshotRows(body, picked) {
  return [...picked]
    .sort((a, b) => a - b)
    .flatMap((i) => (body[i] === undefined ? [] : [body[i].text.replace(/\n$/, "")]));
}

/**
 * The rows a hunk anchor points at. Offsets name them exactly; older comments carry change
 * indices only, and a whole-hunk comment points at none in particular.
 * @param {{ changes: readonly number[] | null, offsets?: readonly number[] }} anchor
 * @param {readonly BodyRow[]} body
 * @returns {number[]}
 */
export function rowsOfAnchor(anchor, body) {
  if (anchor.offsets !== undefined) return anchor.offsets.filter((i) => i < body.length);
  if (anchor.changes === null) return [];
  return bodyIndexes(body, anchor.changes);
}

/**
 * The shown row a comment sits under: its last row, or the last one of them that is shown.
 * null when none is, and the comment then goes under the hunk.
 * @param {readonly number[]} rows
 * @param {ReadonlySet<number>} shown
 */
export function lastShown(rows, shown) {
  return rows.filter((i) => shown.has(i)).at(-1) ?? null;
}
