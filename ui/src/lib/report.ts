// The hand-off: where each item sits on the original branch, whether it goes to the merge
// request, which comment or concern it came from, and the markdown the reviewer copies. Pure.

import type { ReportItem, State, WireComment } from "./wire.ts";

/** "src/lib.js:17-18 (new)", "src/lib.js:12 (old)", the path alone, or null with no lines. */
export function locationOf(item: ReportItem): string | null {
  if (item.path === null) return null;
  const side =
    item.newLine !== null
      ? { end: item.newLine, start: item.startNewLine, label: "new" }
      : item.oldLine !== null
        ? { end: item.oldLine, start: item.startOldLine, label: "old" }
        : null;
  if (side === null) return item.path;
  const span =
    side.start === null || side.start === side.end ? `${side.end}` : `${side.start}-${side.end}`;
  return `${item.path}:${span} (${side.label})`;
}

/** The reviewer's toggle wins over what the server last said. */
export function isIncluded(
  item: ReportItem,
  overrides: ReadonlyMap<string, boolean>,
  id: string | null,
): boolean {
  return (id === null ? undefined : overrides.get(id)) ?? !item.excluded;
}

const ANSWER = "\n\n<details><summary>Answer</summary>\n\n";

/** A question's body splits into what was asked and the answer folded under it. */
export function splitAnswer(body: string): { said: string; answer: string | null } {
  const at = body.indexOf(ANSWER);
  if (at === -1) return { said: body, answer: null };
  return {
    said: body.slice(0, at),
    answer: body.slice(at + ANSWER.length).replace(/\n\n<\/details>\s*$/, ""),
  };
}

/**
 * The comment or concern an item came from: its id when the server sends one, else the one whose
 * words the item carries. Null when nothing matches, and the item then cannot be toggled.
 */
export function sourceOf(
  item: ReportItem,
  state: State,
): { readonly id: string; readonly comment: WireComment | null } | null {
  if (item.id !== undefined) {
    return { id: item.id, comment: state.comments.find((c) => c.id === item.id) ?? null };
  }
  if (item.kind === "concern") {
    const concern = state.commits
      .flatMap((c) => c.concerns ?? [])
      .find((k) => item.body.includes(k.text));
    return concern === undefined ? null : { id: concern.id, comment: null };
  }
  const { said } = splitAnswer(item.body);
  const comment = state.comments.find(
    (c) =>
      c.author !== "agent" &&
      (c.kind === "question") === (item.kind === "question") &&
      (said === c.body || said.endsWith(`\n\n${c.body}`)),
  );
  return comment === undefined ? null : { id: comment.id, comment };
}

/** Every included item under its location, ready to paste into a merge request. */
export function markdownOf(items: readonly ReportItem[]): string {
  return `${items.map((item) => `**${locationOf(item) ?? "General"}**\n\n${item.body.trim()}`).join("\n\n---\n\n")}\n`;
}
