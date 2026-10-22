// What the index beside the document shows: commits grouped by section, the marks on each, and the
// progress line under them. Pure.

import { sectionOf, titleOf } from "./commit.ts";
import type { Notice } from "./unread.ts";
import type { ProjectedCommit, Section } from "./wire.ts";

export type Group = {
  /** null for commits of a plan without sections, or for a run of commits that has none. */
  readonly section: Section | null;
  readonly commits: readonly ProjectedCommit[];
};

/**
 * Commits in document order, cut wherever the section changes. A plan with no sections at all is
 * one group, so the index shows a flat list without headings.
 */
export function groupsOf(commits: readonly ProjectedCommit[]): Group[] {
  const groups: { section: Section | null; commits: ProjectedCommit[] }[] = [];
  for (const commit of commits) {
    const section = sectionOf(commit);
    const last = groups.at(-1);
    if (last !== undefined && last.section === section) last.commits.push(commit);
    else groups.push({ section, commits: [commit] });
  }
  return groups;
}

export type Marks = {
  readonly viewed: boolean;
  /** Threads on the commit that are not resolved. */
  readonly open: number;
  /** Of those, the ones where the agent spoke last. */
  readonly waiting: number;
  /** Agent replies and explanations on the commit the reviewer has not opened. */
  readonly unread: number;
  /** Agent concerns not yet kept or dismissed. */
  readonly undecided: number;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 · Guard add · viewed · 2 open threads · 1 agent concern": a row's name and its tooltip. */
export function describeEntry(commit: ProjectedCommit, marks: Marks): string {
  const parts = [`${commit.index + 1}`, titleOf(commit.message)];
  if (marks.viewed) parts.push("viewed");
  if (marks.open > 0) parts.push(count(marks.open, "open thread", "open threads"));
  if (marks.unread > 0)
    parts.push(count(marks.unread, "unread agent reply", "unread agent replies"));
  if (marks.undecided > 0) parts.push(count(marks.undecided, "agent concern", "agent concerns"));
  return parts.join(" · ");
}

/** "3 of 8 viewed · 2 open threads", the open part only when there are any. */
export function progressOf(marks: readonly Marks[]): string {
  const viewed = marks.filter((m) => m.viewed).length;
  const open = marks.reduce((sum, m) => sum + m.open, 0);
  const line = `${viewed} of ${marks.length} viewed`;
  return open === 0 ? line : `${line} · ${count(open, "open thread", "open threads")}`;
}

/** Unread agent words per commit index, from the notices and where each thread sits. */
export function unreadByCommit(
  unread: readonly Notice[],
  commitOf: ReadonlyMap<string, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const notice of unread) {
    if (notice.kind === "version" || notice.thread === null) continue;
    const commit = commitOf.get(notice.thread);
    if (commit !== undefined) out.set(commit, (out.get(commit) ?? 0) + 1);
  }
  return out;
}

/** The width from which the index opens by itself, so a laptop keeps the code wide. */
export const INDEX_OPEN_FROM_PX = 1280;

/** Open or not on load: the reviewer's last choice for this session, else by viewport width. */
export function indexOpenAtStart(saved: ReadonlySet<string>, width: number): boolean {
  if (saved.has("open")) return true;
  if (saved.has("closed")) return false;
  return width >= INDEX_OPEN_FROM_PX;
}
