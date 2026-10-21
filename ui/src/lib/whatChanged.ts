// A small diff of what the reviewer commented on against the rows now at that place. Pure.

import type { HunkLine } from "./wire.ts";

export type DiffLine = { readonly op: " " | "-" | "+"; readonly text: string };

export const MAX_DIFF_LINES = 6;

/** The text of the picked rows the new plan still has: removed rows are not there any more. */
export function newRows(body: readonly HunkLine[], offsets: readonly number[]): string[] {
  return offsets.flatMap((i) => {
    const line = body[i];
    return line === undefined || line.op === "-" ? [] : [line.text.replace(/\n$/, "")];
  });
}

/**
 * The rows around a place when the new plan names only the place: `count` rows, centred on it,
 * without removed rows.
 */
export function nearRows(body: readonly HunkLine[], row: number, count: number): number[] {
  const start = Math.max(0, Math.min(row - Math.floor((count - 1) / 2), body.length - count));
  return body.flatMap((line, i) => (i >= start && i < start + count && line.op !== "-" ? [i] : []));
}

/** A line diff by longest common subsequence, ignoring trailing space. */
function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const same = (a: string | undefined, b: string | undefined) => a?.trimEnd() === b?.trimEnd();
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i] ?? [];
      row[j] = same(before[i], after[j])
        ? (table[i + 1]?.[j + 1] ?? 0) + 1
        : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const old = before[i];
    const now = after[j];
    if (old !== undefined && now !== undefined && same(old, now)) {
      out.push({ op: " ", text: now });
      i += 1;
      j += 1;
    } else if (
      old !== undefined &&
      (now === undefined || (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))
    ) {
      out.push({ op: "-", text: old });
      i += 1;
    } else if (now !== undefined) {
      out.push({ op: "+", text: now });
      j += 1;
    }
  }
  return out;
}

/**
 * The old quoted lines against the new rows, at most six lines: unchanged lines at the start go
 * first, then whatever does not fit is counted in `more`. Null when nothing differs or there are
 * no old lines to compare.
 */
export function whatChanged(
  quoted: readonly string[],
  now: readonly string[],
): { readonly lines: readonly DiffLine[]; readonly more: number } | null {
  if (quoted.length === 0) return null;
  const all = lineDiff(quoted, now);
  const firstChange = all.findIndex((l) => l.op !== " ");
  if (firstChange === -1) return null;
  // Keep one line of lead-in when there is one, so the change reads in place.
  const rest = all.slice(Math.max(0, firstChange - 1));
  const lines = rest.slice(0, MAX_DIFF_LINES);
  return { lines, more: rest.length - lines.length };
}
