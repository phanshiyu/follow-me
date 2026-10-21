// What a commit section shows: title, body, the agent's note, and its units grouped by file. Pure.

import type { ProjectedCommit, Unit, UnitId, UnitRef } from "./wire.ts";

export function titleOf(message: string): string {
  return message.split("\n")[0] ?? "";
}

export function bodyOf(message: string): string {
  return message.split("\n").slice(1).join("\n").trim();
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The agent's note, unless it only repeats the message body. */
export function noteOf(commit: ProjectedCommit): string | null {
  const note = commit.narration?.trim() ?? "";
  if (note === "") return null;
  const body = bodyOf(commit.message);
  return body !== "" && squash(body) === squash(note) ? null : note;
}

export type FileGroup = {
  readonly path: string;
  readonly parts: readonly { readonly ref: UnitRef; readonly unit: Unit }[];
};

/** The commit's units grouped by file, files in the order the commit first touches them. */
export function filesOf(commit: ProjectedCommit, units: ReadonlyMap<UnitId, Unit>): FileGroup[] {
  const groups = new Map<string, { ref: UnitRef; unit: Unit }[]>();
  for (const ref of commit.refs) {
    const unit = units.get(ref.unit);
    if (unit === undefined) continue;
    const parts = groups.get(unit.path) ?? [];
    parts.push({ ref, unit });
    groups.set(unit.path, parts);
  }
  return [...groups].map(([path, parts]) => ({
    path,
    parts: parts.sort((a, b) => oldStartOf(a.unit) - oldStartOf(b.unit)),
  }));
}

function oldStartOf(unit: Unit): number {
  return unit.kind === "hunk" ? unit.oldStart : -1;
}

/** A key that changes whenever the commit's units or line selections change. */
export function commitKey(commit: ProjectedCommit): string {
  return JSON.stringify(commit.refs.map((r) => [r.unit, r.select]));
}

/** "@@ -1,5 +1,7 @@" from the file numbers of a hunk's rows. */
export function hunkHeader(
  numbers: readonly { readonly old: number | null; readonly new: number | null }[],
): string {
  const olds = numbers.flatMap((n) => (n.old === null ? [] : [n.old]));
  const news = numbers.flatMap((n) => (n.new === null ? [] : [n.new]));
  const span = (ns: number[]) => `${ns[0] ?? 0},${ns.length}`;
  return `@@ -${span(olds)} +${span(news)} @@`;
}
