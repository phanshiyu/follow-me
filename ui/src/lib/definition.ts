// Go to definition: the name under the pointer, how each candidate place reads, and what a
// Cmd-click does with the list. Pure.

import { sectionLabel, sectionOf } from "./commit.ts";
import type { Candidate, ProjectedCommit } from "./wire.ts";

export type Token = { readonly name: string; readonly start: number; readonly end: number };

// ASCII only, as the server takes it: it answers 400 for any other name.
const PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * The identifier touching a caret offset in a line of code, or null. The offset is a caret
 * position, so the character before it counts as well: a pointer on the right half of the last
 * letter reports the offset after it.
 */
export function identifierAt(text: string, offset: number): Token | null {
  const at = PART.test(text[offset] ?? "")
    ? offset
    : PART.test(text[offset - 1] ?? "")
      ? offset - 1
      : -1;
  if (at < 0) return null;
  let start = at;
  while (start > 0 && PART.test(text[start - 1] ?? "")) start -= 1;
  let end = at + 1;
  while (end < text.length && PART.test(text[end] ?? "")) end += 1;
  const name = text.slice(start, end);
  return DIGIT.test(name[0] ?? "") ? null : { name, start, end };
}

/** Cmd on macOS, Ctrl elsewhere, as editors bind go to definition. */
export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

export function definitionKeyHeld(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  mac: boolean,
): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** A candidate the page can scroll to: its lines are shown in one of the branch's commits. */
export function isOnPage(candidate: Candidate): boolean {
  return candidate.unit !== null && candidate.commit !== null;
}

export type Label = {
  /** "src/guard.js:3" */
  readonly place: string;
  /** "in commit 6 · The details", "in commit 6", or "outside this branch". */
  readonly where: string;
};

export function labelOf(candidate: Candidate, commits: readonly ProjectedCommit[]): Label {
  const place = `${candidate.path}:${candidate.newLine}`;
  if (candidate.commit === null) return { place, where: "outside this branch" };
  const commit = commits[candidate.commit];
  const section = commit === undefined ? null : sectionOf(commit);
  const where = `in commit ${candidate.commit + 1}`;
  return { place, where: section === null ? where : `${where} · ${sectionLabel(section)}` };
}

export type Outcome =
  | { readonly kind: "none" }
  | { readonly kind: "jump"; readonly candidate: Candidate }
  | { readonly kind: "peek"; readonly candidate: Candidate }
  | { readonly kind: "choose"; readonly candidates: readonly Candidate[] };

/**
 * One candidate goes straight there: a jump when the page shows it, a peek when it does not.
 * Several open a list to pick from, in the server's order.
 */
export function outcomeOf(candidates: readonly Candidate[]): Outcome {
  const [only, ...rest] = candidates;
  if (only === undefined) return { kind: "none" };
  if (rest.length > 0) return { kind: "choose", candidates };
  return isOnPage(only) ? { kind: "jump", candidate: only } : { kind: "peek", candidate: only };
}
