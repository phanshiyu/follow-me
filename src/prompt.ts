import type {
  Anchor,
  Comment,
  Diff,
  PlanFile,
  Review,
  Selection,
  TextHunk,
  Unit,
} from "./types.ts";

export type PromptInput = {
  readonly diff: Diff;
  readonly previousPlan: PlanFile | null;
  readonly review: Review | null;
  readonly draftPath: string;
};

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

const GOAL = `You are reordering a finished branch into a series of commits that a reader can follow
as the author's thought process. The final tree is fixed. You only decide how its change
lines are grouped and ordered.

Order the commits so the story reads naturally:
- Scaffolding and types come before the code that uses them.
- A failing test comes before the fix that makes it pass.
- Renames and moves come before the edits that build on them.
- One idea per commit. Prefer many small commits over a few large ones.
- Commits do not need to compile or pass tests on their own.
- The last commit must bring the tree to exactly the tip, which follows from covering every unit.

Write each commit message as a short imperative title, then a blank line and a body that
says why.`;

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
    { "message": "Parse tokens", "units": ["h_ba9876543210", "f_0123456789ab"] }
  ],
  "responses": [
    { "comment": "c_abc234", "status": "addressed", "note": "Split the hunk and moved it earlier." }
  ]
}

\`responses\` is [] when there are no review comments. \`status\` is one of "addressed",
"declined" or "deferred", and \`note\` says what you did or why not.`;

const RULES = `- A unit is "h_…" (a text hunk), "f_…" (a whole file) or "m_…" (a mode change).
- "h_x:0-3,7" takes change lines 0, 1, 2, 3 and 7 of hunk h_x. Indices are the [n] shown below.
- A bare "h_x" takes every change line of that hunk that no other commit claimed.
- Every change line must be used exactly once across all commits. Never repeat a line.
- Use the unit ids exactly as printed. Do not invent ids.
- "f_…" and "m_…" units are taken whole, never with a line list.
- Every commit needs a non-empty message and at least one unit.
- Check your work with \`follow-me check\` and fix every issue it prints.`;

/** The planner prompt for a coding agent. Pure and deterministic for the same input. */
export function renderPrompt(input: PromptInput): string {
  const { diff, previousPlan, review, draftPath } = input;
  const sections = [
    `# follow-me: plan the commits\n\n${GOAL}`,
    `## Output format\n\n${FORMAT(draftPath, diff.base, diff.tip)}`,
    `## Rules\n\n${RULES}`,
    `## Units\n\nChange lines are shown as \`[n]+ text\` or \`[n]- text\`. Indented lines without a bracket are context and cannot be selected.\n\n${renderUnits(diff)}`,
  ];
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

/** A markdown digest of a review for `follow-me feedback`. */
export function renderFeedback(review: Review, plan: PlanFile): string {
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
