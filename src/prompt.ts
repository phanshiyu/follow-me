import type {
  Anchor,
  Comment,
  Diff,
  PlanFile,
  Review,
  Selection,
  TextHunk,
  Unit,
  UnitId,
} from "./types.ts";

/**
 * split plans commits for the author, answering their last plan review. walk plans a story for a
 * reviewer meeting the branch fresh, so earlier plans and plan reviews do not apply.
 */
export type PromptInput = {
  readonly diff: Diff;
  readonly draftPath: string;
  /** The exact command that validates the draft, including any --branch the user passed. */
  readonly checkCommand: string;
} & (
  | {
      readonly mode: "split";
      readonly previousPlan: PlanFile | null;
      readonly review: Review | null;
    }
  | { readonly mode: "walk" }
);

/** Consecutive runs collapse: [0,1,2,3,7] becomes "0-3,7". */
function formatRanges(changes: readonly number[]): string {
  const sorted = [...new Set(changes)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      end += 1;
      i += 1;
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    i += 1;
  }
  return parts.join(",");
}

function formatSelection(unit: string, select: Selection): string {
  return select.kind === "rest" ? unit : `${unit}:${formatRanges(select.changes)}`;
}

function stripEol(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function renderHunk(hunk: TextHunk): string {
  const lines = hunk.body.map((line) =>
    line.op === " "
      ? `    ${stripEol(line.text)}`
      : `[${line.change}]${line.op} ${stripEol(line.text)}`,
  );
  return [`${hunk.id}  ${hunk.path}  (${hunk.changeCount} change lines)`, ...lines].join("\n");
}

function renderOtherUnit(unit: Exclude<Unit, TextHunk>): string {
  if (unit.kind === "mode") {
    return `${unit.id}  ${unit.path}  mode ${unit.from} -> ${unit.to}  (whole unit, no lines)`;
  }
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.id}  ${unit.path}  ${unit.reason} file ${change}  (whole unit, no lines)`;
}

function renderUnits(diff: Diff): string {
  const byPath = new Map<string, Unit[]>();
  for (const unit of diff.units.values()) {
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit]);
  }
  const files = [...byPath].map(([path, units]) => {
    const rendered = units.map((unit) =>
      unit.kind === "hunk" ? renderHunk(unit) : renderOtherUnit(unit),
    );
    return [`### ${path}`, ...rendered].join("\n\n");
  });
  return files.join("\n\n");
}

function renderPreviousPlan(plan: PlanFile): string {
  return plan.commits
    .map((commit, i) => {
      const units = commit.units.map((ref) => `  - ${formatSelection(ref.unit, ref.select)}`);
      return [`${i + 1}. ${commit.message.split("\n")[0] ?? ""}`, ...units].join("\n");
    })
    .join("\n");
}

function describeAnchor(anchor: Anchor): string {
  switch (anchor.kind) {
    case "plan":
      return "the whole plan";
    case "message":
      return `the message of commit ${anchor.commit + 1}`;
    case "position":
      return `the position of commit ${anchor.commit + 1} (the reviewer thinks it belongs elsewhere)`;
    case "hunk": {
      const where =
        anchor.changes === null ? "the whole unit" : `change lines ${formatRanges(anchor.changes)}`;
      return `${anchor.unit} (${where}) in commit ${anchor.commit + 1}`;
    }
    default: {
      const _exhaustive: never = anchor;
      return _exhaustive;
    }
  }
}

function renderComment(comment: Comment): string {
  const lines = [`- ${comment.id}  on ${describeAnchor(comment.anchor)}`];
  if (comment.context.commitMessage) {
    lines.push(`  commit message then: ${JSON.stringify(comment.context.commitMessage)}`);
  }
  if (comment.context.path) lines.push(`  path: ${comment.context.path}`);
  lines.push(`  comment: ${JSON.stringify(comment.body)}`);
  return lines.join("\n");
}

const ORDERING = `Order the commits so the story reads naturally:
- Scaffolding and types come before the code that uses them.
- A failing test comes before the fix that makes it pass.
- Renames and moves come before the edits that build on them.
- One idea per commit. Prefer many small commits over a few large ones.
- Commits do not need to compile or pass tests on their own.
- The last commit must bring the tree to exactly the tip, which follows from covering every unit.

Write each commit message as a short imperative title, then a blank line and a body that
says why.`;

const GOALS = {
  split: {
    title: "plan the commits",
    goal: `You are reordering a finished branch into a series of commits that a reader can follow
as the author's thought process. The final tree is fixed. You only decide how its change
lines are grouped and ordered.

${ORDERING}`,
  },
  walk: {
    title: "tell the story of this branch",
    goal: `The reader is a reviewer meeting this branch for the first time. They will watch it
being written commit by commit, hear your narration read aloud as each line appears, and
comment on the code itself. The final tree is fixed. You decide how its change lines are
grouped and ordered, and what the author is thinking while writing them.

${ORDERING}

Give every commit a \`narration\`. Add one to a unit too wherever the why of that hunk is not
obvious from the commit's narration. Narration should sound like someone thinking aloud at the
keyboard: first person, present tense, two or three sentences, no markdown. Say why, not what
the lines already show.`,
  },
} satisfies Record<PromptInput["mode"], { readonly title: string; readonly goal: string }>;

const FORMAT = (
  draftPath: string,
  base: string,
  tip: string,
): string => `Write the plan as JSON to ${draftPath}. Write only the file, in this format:

{
  "schema": "follow-me/plan@1",
  "base": "${base}",
  "tip": "${tip}",
  "commits": [
    { "message": "Add the Token type\\n\\nThe parser needs it.", "units": ["h_0123456789ab", "h_ba9876543210:0-3,7"] },
    {
      "message": "Parse tokens",
      "narration": "Now that tokens exist I can finally read them. I start with the happy path.",
      "units": [{ "unit": "h_ba9876543210", "narration": "The loop is boring on purpose." }, "f_0123456789ab"]
    }
  ],
  "responses": [
    { "comment": "c_abc234", "status": "addressed", "note": "Split the hunk and moved it earlier." }
  ]
}

\`narration\` is optional on a commit and on a unit. A unit with narration is written as
\`{ "unit": "<ref>", "narration": "..." }\` instead of the plain ref string.

\`diagram\` is optional on a commit and on a unit, written the same way:
\`{ "unit": "<ref>", "diagram": "..." }\`. It is Mermaid source that the review page draws beside
the code: a commit's diagram while its commit is on screen, a unit's while playback is on that
unit. Add one only where a picture says what the code and prose cannot: data flowing between
modules, a state machine, a call graph, or the before and after shape of a structure. Most commits
need none. The first line names the diagram type, for example:

  "diagram": "flowchart LR\\n  parse --> validate --> apply"

Narration stays plain text even when a diagram is present, because it is read aloud.
\`responses\` is [] when there are no review comments. \`status\` is one of "addressed",
"declined" or "deferred", and \`note\` says what you did or why not.`;

const RULES = (
  checkCommand: string,
): string => `- A unit is "h_…" (a text hunk), "f_…" (a whole file) or "m_…" (a mode change).
- "h_x:0-3,7" takes change lines 0, 1, 2, 3 and 7 of hunk h_x. Indices are the [n] shown below.
- A bare "h_x" takes every change line of that hunk that no other commit claimed.
- Every change line must be used exactly once across all commits. Never repeat a line.
- Use the unit ids exactly as printed. Do not invent ids.
- "f_…" and "m_…" units are taken whole, never with a line list.
- Every commit needs a non-empty message and at least one unit.
- Check your work with \`${checkCommand}\` and fix every issue it prints.`;

/** The planner prompt for a coding agent. Pure and deterministic for the same input. */
export function renderPrompt(input: PromptInput): string {
  const { diff, draftPath } = input;
  const { title, goal } = GOALS[input.mode];
  const sections = [
    `# follow-me: ${title}\n\n${goal}`,
    `## Output format\n\n${FORMAT(draftPath, diff.base, diff.tip)}`,
    `## Rules\n\n${RULES(input.checkCommand)}`,
    `## Units\n\nChange lines are shown as \`[n]+ text\` or \`[n]- text\`. Indented lines without a bracket are context and cannot be selected.\n\n${renderUnits(diff)}`,
  ];
  if (input.mode === "walk") return `${sections.join("\n\n")}\n`;
  const { previousPlan, review } = input;
  if (previousPlan) {
    sections.push(
      `## Previous plan\n\nCommits are numbered from 1.\n\n${renderPreviousPlan(previousPlan)}`,
    );
  }
  if (review && review.comments.length > 0) {
    sections.push(
      [
        `## Open review comments\n`,
        `A reviewer commented on plan v${review.planVersion}. Commits are numbered from 1.`,
        "Answer every comment below with one entry in `responses`, changing the plan where you agree.\n",
        review.comments.map(renderComment).join("\n"),
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

/** The owning commit of each change line of a hunk, or null when the plan leaves it out. */
function ownersOf(plan: PlanFile, hunk: TextHunk): (number | null)[] {
  const owners = new Array<number | null>(hunk.changeCount).fill(null);
  const rest: number[] = [];
  plan.commits.forEach((commit, k) => {
    for (const ref of commit.units) {
      if (ref.unit !== hunk.id) continue;
      if (ref.select.kind === "rest") rest.push(k);
      else for (const c of ref.select.changes) owners[c] = k;
    }
  });
  const restOwner = rest[0] ?? null;
  return owners.map((o) => o ?? restOwner);
}

type ExcerptLine = {
  readonly text: string;
  readonly change: number | null;
  readonly tipLine: number;
};

/**
 * The hunk as it reads in commit `k`: context, lines earlier commits left in place, and this
 * commit's own change lines marked +/-. tipLine numbers the line in the branch tip, 1-based.
 */
function excerpt(hunk: TextHunk, tipStart: number, owners: readonly (number | null)[], k: number) {
  const lines: ExcerptLine[] = [];
  let tipLine = tipStart;
  for (const line of hunk.body) {
    const text = stripEol(line.text);
    if (line.op === " ") lines.push({ text: ` ${text}`, change: null, tipLine });
    else {
      const owner = owners[line.change] ?? null;
      const applied = owner !== null && owner < k;
      if (owner === k) lines.push({ text: `${line.op}${text}`, change: line.change, tipLine });
      else if (line.op === "+" ? applied : !applied) {
        lines.push({ text: ` ${text}`, change: null, tipLine });
      }
    }
    if (line.op !== "-") tipLine += 1;
  }
  return lines;
}

/** Where the hunk starts in the tip: its base position shifted by earlier hunks of the file. */
function tipStartOf(hunk: TextHunk, units: ReadonlyMap<UnitId, Unit>): number {
  let shift = 0;
  for (const u of units.values()) {
    if (u.kind !== "hunk" || u.path !== hunk.path || u.oldStart >= hunk.oldStart) continue;
    for (const line of u.body) shift += line.op === "+" ? 1 : line.op === "-" ? -1 : 0;
  }
  return hunk.oldStart + shift + 1;
}

/** A fence longer than any backtick run in the content, so quoted code cannot close it. */
function fence(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length)));
  return "`".repeat(Math.max(3, longest + 1));
}

const EXCERPT_CONTEXT = 3;

function renderCodeComment(
  comment: Comment,
  plan: PlanFile,
  units: ReadonlyMap<UnitId, Unit>,
): string[] {
  const { anchor } = comment;
  const hunk = anchor.kind === "hunk" ? units.get(anchor.unit) : undefined;
  if (anchor.kind !== "hunk" || hunk?.kind !== "hunk") {
    return [`### ${comment.id}`, "", comment.body, ""];
  }
  let lines = excerpt(hunk, tipStartOf(hunk, units), ownersOf(plan, hunk), anchor.commit);
  const picked = anchor.changes;
  const marked = lines.flatMap((l, i) =>
    l.change !== null && (picked === null || picked.includes(l.change)) ? [i] : [],
  );
  const first = marked[0];
  const last = marked.at(-1);
  const at = first === undefined ? undefined : lines[first];
  const where = at === undefined ? "" : `, line ${at.tipLine}`;
  if (picked !== null && first !== undefined && last !== undefined) {
    lines = lines.slice(Math.max(0, first - EXCERPT_CONTEXT), last + EXCERPT_CONTEXT + 1);
  }
  const text = lines.map((l) => l.text);
  const f = fence(text);
  return [`### ${comment.id}${where}`, "", `${f}diff`, ...text, f, "", comment.body, ""];
}

/** A reviewer's code review for the author, grouped by file in diff order. */
function renderCodeReview(
  review: Review,
  plan: PlanFile,
  units: ReadonlyMap<UnitId, Unit>,
): string {
  const out = ["# Code review", ""];
  if (review.comments.length === 0) {
    out.push("The reviewer left no comments.", "");
    return out.join("\n");
  }
  out.push(
    `A reviewer watched this branch being written commit by commit and left ${review.comments.length === 1 ? "1 comment" : `${review.comments.length} comments`}.`,
    "",
  );
  const order = new Map<string, number>();
  for (const u of units.values()) if (!order.has(u.path)) order.set(u.path, order.size);
  const byPath = new Map<string, Comment[]>();
  const general: Comment[] = [];
  for (const c of review.comments) {
    const path = c.anchor.kind === "hunk" ? c.context.path : null;
    if (path === null) general.push(c);
    else byPath.set(path, [...(byPath.get(path) ?? []), c]);
  }
  const rank = (path: string) => order.get(path) ?? order.size;
  const paths = [...byPath.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const path of paths) {
    out.push(`## ${path}`, "");
    for (const c of byPath.get(path) ?? []) out.push(...renderCodeComment(c, plan, units));
  }
  if (general.length > 0) {
    out.push("## General", "");
    for (const c of general) out.push(...renderCodeComment(c, plan, units));
  }
  out.push(
    "Address each comment above in the code on this branch, then tell the reviewer what you changed and what you chose not to change and why.",
    "",
  );
  return out.join("\n");
}

/**
 * A markdown digest of a review for `follow-me feedback`. A split review is plan feedback for
 * the planner; a walk review is a code review for the author.
 */
export function renderFeedback(
  review: Review,
  plan: PlanFile,
  units: ReadonlyMap<UnitId, Unit>,
): string {
  if (review.mode === "walk") return renderCodeReview(review, plan, units);
  const out = [`# Review of plan v${review.planVersion}`, ""];
  if (review.comments.length === 0) {
    out.push("No comments.", "");
    return out.join("\n");
  }
  const planLevel = review.comments.filter((c) => c.anchor.kind === "plan");
  if (planLevel.length > 0) {
    out.push("## Whole plan", "");
    for (const c of planLevel) out.push(`- ${c.id}: ${c.body}`);
    out.push("");
  }
  const placed = plan.commits.length;
  const orphans = review.comments.filter(
    (c) => c.anchor.kind !== "plan" && c.anchor.commit >= placed,
  );
  plan.commits.forEach((commit, i) => {
    const mine = review.comments.filter((c) => c.anchor.kind !== "plan" && c.anchor.commit === i);
    if (mine.length === 0) return;
    out.push(`## Commit ${i + 1}: ${commit.message.split("\n")[0] ?? ""}`, "");
    for (const c of mine) {
      out.push(`- ${c.id} on ${describeAnchor(c.anchor)}`);
      if (c.context.path) out.push(`  - file: ${c.context.path}`);
      out.push(`  - ${c.body.split("\n").join("\n    ")}`);
    }
    out.push("");
  });
  if (orphans.length > 0) {
    out.push("## Commits not in this plan", "");
    for (const c of orphans) out.push(`- ${c.id}: ${c.body}`);
    out.push("");
  }
  out.push(
    "Answer every comment id above in `responses` of the next draft, then run `follow-me check` and `follow-me apply`.",
    "",
  );
  return out.join("\n");
}
