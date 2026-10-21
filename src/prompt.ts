import { tipStartOf } from "./diff.ts";
import type { Evolution } from "./evolve.ts";
import type {
  Anchor,
  Comment,
  CommentResponse,
  Diff,
  PlacedConcern,
  PlanFile,
  PlanVersion,
  ProjectedCommit,
  Review,
  Selection,
  ServerEvent,
  Severity,
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
  /** Set when the branch moved after plan `since` and the draft carries that plan over. */
  readonly changes?: Changes;
} & (
  | {
      readonly mode: "split";
      readonly previousPlan: PlanFile | null;
      readonly review: Review | null;
      /** previousPlan projected, so comments on rows can be quoted as that plan wrote them. */
      readonly previousCommits?: readonly ReportCommit[];
    }
  | { readonly mode: "walk" }
);

export type Changes = { readonly since: PlanVersion } & Pick<Evolution, "vanished" | "added">;

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

function describeAnchor(anchor: Anchor, ctx: Context | null): string {
  switch (anchor.kind) {
    case "plan":
      return "the whole plan";
    case "message":
      return `the message of commit ${anchor.commit + 1}`;
    case "position":
      return `the position of commit ${anchor.commit + 1} (the reviewer thinks it belongs elsewhere)`;
    case "hunk": {
      const pick = ctx === null ? null : pickRows(ctx, anchor);
      if (pick !== null) {
        const rows = formatRanges(pick.offsets);
        return `${pick.label} in commit ${anchor.commit + 1} (${anchor.unit} rows ${rows}; ${pick.counts})`;
      }
      const where =
        anchor.offsets !== undefined
          ? `rows ${formatRanges(anchor.offsets)}`
          : anchor.changes === null
            ? "the whole unit"
            : `change lines ${formatRanges(anchor.changes)}`;
      return `${anchor.unit} (${where}) in commit ${anchor.commit + 1}`;
    }
    default: {
      const _exhaustive: never = anchor;
      return _exhaustive;
    }
  }
}

/** The hunk around the picked rows with the picked ones marked `>`; empty without offsets. */
function anchorRows(ctx: Context | null, anchor: Anchor): readonly string[] {
  return (ctx === null ? null : pickRows(ctx, anchor))?.rows ?? [];
}

/** What the reviewer's picked rows resolve to in the hunk as a given commit writes it. */
type Picked = {
  readonly offsets: readonly number[];
  /** "src/lib.js:17-18", with "(base side)" when a picked row is a removal. */
  readonly label: string;
  /** "17-18" or "17". */
  readonly range: string;
  readonly baseSide: boolean;
  /** First picked line, in the numbering `label` uses. */
  readonly line: number;
  readonly counts: string;
  readonly rows: readonly string[];
  readonly touchesContext: boolean;
};

const PICK_MARGIN = 3;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Resolves offsets against the hunk. Line numbers are the branch tip's, or the base's when a
 * picked row is a removal, since a removed line has no tip number. Rows are shown as the commit
 * writes them: its own changes marked +/-, everything else as context.
 */
function pickRows(ctx: Context, anchor: Anchor): Picked | null {
  if (anchor.kind !== "hunk" || anchor.offsets === undefined) return null;
  const hunk = ctx.units.get(anchor.unit);
  const { offsets } = anchor;
  const first = offsets[0];
  const last = offsets.at(-1);
  if (hunk?.kind !== "hunk" || first === undefined || last === undefined) return null;
  if (last >= hunk.body.length) return null;
  // Without the projected commit, the hunk is quoted as git shows it.
  const projected = anchor.commit < ctx.commits.length;
  const owners = ownersOf(ctx.commits, hunk);
  const picked = new Set(offsets);
  let tip = tipStartOf(hunk, ctx.units);
  let base = hunk.oldStart + 1;
  const rows: string[] = [];
  const lines: { readonly op: string; readonly tip: number; readonly base: number }[] = [];
  hunk.body.forEach((line, i) => {
    lines.push({ op: line.op, tip, base });
    let op = line.op;
    let shown = true;
    if (projected && line.op !== " ") {
      const owner = owners[line.change] ?? null;
      const applied = owner !== null && owner < anchor.commit;
      if (owner !== anchor.commit) {
        shown = line.op === "+" ? applied : !applied;
        op = " ";
      }
    }
    if (picked.has(i) && !shown) {
      shown = true;
      op = line.op;
    }
    const inWindow = i >= first - PICK_MARGIN && i <= last + PICK_MARGIN;
    if (shown && inWindow) rows.push(`${picked.has(i) ? ">" : " "} ${op}${stripEol(line.text)}`);
    if (line.op !== "-") tip += 1;
    if (line.op !== "+") base += 1;
  });
  const chosen = offsets.flatMap((i) => lines[i] ?? []);
  const removal = chosen.some((l) => l.op === "-");
  const numbers = removal
    ? chosen.filter((l) => l.op !== "+").map((l) => l.base)
    : chosen.map((l) => l.tip);
  const from = Math.min(...numbers);
  const to = Math.max(...numbers);
  const range = from === to ? `${from}` : `${from}-${to}`;
  const count = (op: string) => chosen.filter((l) => l.op === op).length;
  const counts = [
    count(" ") === 0 ? null : plural(count(" "), "context line"),
    count("+") === 0 ? null : `${count("+")} added`,
    count("-") === 0 ? null : `${count("-")} removed`,
  ].filter((part) => part !== null);
  return {
    offsets,
    label: `${hunk.path}:${range}${removal ? " (base side)" : ""}`,
    range,
    baseSide: removal,
    line: from,
    counts: counts.join(", "),
    rows,
    touchesContext: count(" ") > 0,
  };
}

/** Said once wherever comments reach the agent, with the same words. */
const CONTEXT_RULE =
  "A comment on a context row (marked `>` with no + or -) is about code this branch leaves alone or depends on. The plan cannot move it, so do not move lines because of it. Answer a question with an explanation, or point at the commit that last touched those lines. Answer a change request as a code issue, not by reordering.";

function renderComment(comment: Comment, ctx: Context): string {
  const lines = [`- ${comment.id}  on ${describeAnchor(comment.anchor, ctx)}`];
  const rows = anchorRows(ctx, comment.anchor);
  if (comment.follows) lines.push(`  asks again after ${comment.follows}`);
  if (comment.context.commitMessage) {
    lines.push(`  commit message then: ${JSON.stringify(comment.context.commitMessage)}`);
  }
  if (comment.context.path) lines.push(`  path: ${comment.context.path}`);
  if (rows.length > 0) {
    lines.push("  rows asked about, picked ones marked >:", ...rows.map((r) => `    ${r}`));
  } else if (comment.context.lines && comment.context.lines.length > 0) {
    lines.push("  lines asked about:", ...comment.context.lines.map((l) => `    ${l}`));
  }
  if (comment.severity) lines.push(`  severity: ${comment.severity}`);
  lines.push(`  comment: ${JSON.stringify(comment.body)}`);
  for (const reply of comment.replies ?? []) {
    lines.push(`  ${reply.author} replied: ${JSON.stringify(reply.body)}`);
  }
  return lines.join("\n");
}

const QUESTIONS = `A question is not a request to change the plan. Answer it by explaining, not by moving lines. Where the asked-about lines now live, add or rewrite the \`narration\` (the page shows it as your note) of that commit or unit so it answers the question, in plain sentences. When the answer is about flow, structure or order across files, add a \`diagram\` there too. Then write one response with \`"status": "answered"\`, a \`note\` of one to three sentences that answers the question directly, and \`"at"\` naming the commit (1-based) and unit that carry the explanation. Move lines only if answering shows the order itself was wrong. Say so in the note, and answer the question as well. If the diff cannot answer it, use \`"deferred"\` and say what is missing.`;

const CONCERNS = `You are also a careful reviewer. Add a concern only for something you would raise in a pull request: a bug or unhandled case, a change with no test where one is expected, a name that misleads, or a risky change such as a migration, concurrency or security. Pin it to the change lines with \`lines\`. Say what goes wrong and when, in one or two sentences. Severity: \`blocker\` breaks behaviour or loses data, \`major\` should be fixed before merge, \`minor\` is worth a note. Do not flag style, formatting or taste. Do not repeat the note. Most commits deserve no concern, and a plan with none is fine. Never write more than one concern per unit. Concerns are in your voice as a reviewer, while the note stays the author's.

A concern is \`{ "severity": "blocker" | "major" | "minor", "kind": "bug" | "missing-test" | "naming" | "risk", "text": "...", "lines": [0, 1] }\`. \`lines\` holds change indices of that unit and is allowed only on a unit ref. Write \`"concerns": [ ... ]\` on a commit, or on a unit written as an object: \`{ "unit": "h_x:0-3", "concerns": [ ... ] }\`. Never write an id; follow-me derives one.`;

const ORDERING = `Order the commits so the story reads naturally:
- Scaffolding and types come before the code that uses them.
- A failing test comes before the fix that makes it pass.
- Renames and moves come before the edits that build on them.
- One idea per commit. Prefer many small commits over a few large ones.
- Commits do not need to compile or pass tests on their own.
- The last commit must bring the tree to exactly the tip, which follows from covering every unit.

Write each commit message as a short imperative title, then a blank line and a body that
says why. Put the why in the body first, before anything else. Keep the title to 50
characters or fewer; put detail in the body.`;

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
    goal: `The reader is a reviewer meeting this branch for the first time. They will read it commit
by commit and comment on the code itself. The final tree is fixed. You decide how its change
lines are grouped and ordered, and why each step is there.

${ORDERING}

Add a \`narration\` to a commit, or to a unit, only when it says something the commit message
body does not. The page shows it as your note. A note is one plain paragraph on why, in plain
text with no markdown. Say why, not what the lines already show. Leave it out when the body
already says it.`,
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
      "narration": "Tokens are read in one pass, so the loop below never backtracks.",
      "units": [{ "unit": "h_ba9876543210", "narration": "The loop is boring on purpose." }, "f_0123456789ab"]
    }
  ],
  "responses": [
    { "comment": "c_abc234", "status": "addressed", "note": "Split the hunk and moved it earlier." }
  ]
}

\`narration\` is optional on a commit and on a unit, and the page shows it as your note. A unit
with a note is written as \`{ "unit": "<ref>", "narration": "..." }\` instead of the plain ref string.

\`diagram\` is optional on a commit and on a unit, written the same way:
\`{ "unit": "<ref>", "diagram": "..." }\`. It is Mermaid source that the review page draws beside
the code: a commit's diagram under its commit, a unit's under its hunk. Add one only where a picture says what the code and prose cannot: data flowing between
modules, a state machine, a call graph, or the before and after shape of a structure. Most commits
need none. The first line names the diagram type, for example:

  "diagram": "flowchart LR\\n  parse --> validate --> apply"

The note stays plain text even when a diagram is present.
\`responses\` is [] when there are no review comments. \`status\` is one of "addressed",
"declined", "deferred" or, for a question, "answered", and \`note\` says what you did or why not.
An "answered" response also carries \`"at": { "commit": 3, "unit": "h_x" }\`: the commit, counted from 1,
and optionally the unit that holds the explanation.`;

const RULES = (
  checkCommand: string,
): string => `- A unit is "h_…" (a text hunk), "f_…" (a whole file) or "m_…" (a mode change).
- "h_x:0-3,7" takes change lines 0, 1, 2, 3 and 7 of hunk h_x. Indices are the [n] shown below.
- A bare "h_x" takes every change line of that hunk that no other commit claimed.
- Every change line must be used exactly once across all commits. Never repeat a line.
- Use the unit ids exactly as printed. Do not invent ids.
- "f_…" and "m_…" units are taken whole, never with a line list.
- Every commit needs a non-empty message and at least one unit.
- Keep every file syntactically whole in every commit: a function with its closing brace, a block with both ends, an import before or with its first use. Commits need not build or pass tests, but each file a commit writes must parse.
- Check your work with \`${checkCommand}\` and fix every issue it prints, syntax errors included.`;

function renderUnit(unit: Unit): string {
  return unit.kind === "hunk" ? renderHunk(unit) : renderOtherUnit(unit);
}

/** The vanished and new units, and the reviewer's comments on hunks that vanished, quoted. */
function renderChanges(changes: Changes, input: PromptInput, ctx: Context): string {
  const { since, vanished, added } = changes;
  const gone = new Set<UnitId>(vanished.map((v) => v.unit.id));
  const review = input.mode === "split" ? input.review : null;
  const orphans = (review?.comments ?? []).filter(
    (c) => c.author !== "agent" && c.anchor.kind === "hunk" && gone.has(c.anchor.unit),
  );
  const parts = [
    `## Changes since v${since}\n`,
    `The branch moved after plan v${since}. ${input.draftPath} already holds that plan on the new tip: every unit whose hunk did not change keeps its commit, and any commit left with no unit was dropped. Put each new unit below into a commit, an existing one or a new one, and keep the rest as it is.`,
  ];
  if (vanished.length > 0) {
    parts.push(
      `\nThese units of v${since} changed, so their ids are gone:`,
      ...vanished.map(({ unit, commits }) => {
        const where = commits
          .map((c) => `commit ${c.index + 1} ${JSON.stringify(c.message.split("\n")[0] ?? "")}`)
          .join(", ");
        return `- ${unit.id}  ${unit.path}, was in ${where}`;
      }),
    );
  }
  if (added.length > 0) {
    parts.push("\nNew units, in no commit yet:\n", added.map(renderUnit).join("\n\n"));
  }
  if (orphans.length > 0) {
    parts.push(
      `\nThe reviewer commented on hunks that changed. Write a response for each saying what you changed, and post the same with \`follow-me reply <id>\`:\n`,
      orphans.map((c) => renderComment(c, ctx)).join("\n"),
    );
  }
  return parts.join("\n");
}

/** The planner prompt for a coding agent. Pure and deterministic for the same input. */
export function renderPrompt(input: PromptInput): string {
  const { diff, draftPath } = input;
  const { title, goal } = GOALS[input.mode];
  const head = [
    `# follow-me: ${title}\n\n${goal}`,
    `## Output format\n\n${FORMAT(draftPath, diff.base, diff.tip)}`,
    `## Rules\n\n${RULES(input.checkCommand)}`,
  ];
  const units = `## Units\n\nChange lines are shown as \`[n]+ text\` or \`[n]- text\`. Indented lines without a bracket are context and cannot be selected.\n\n${renderUnits(diff)}`;
  if (input.mode === "walk") {
    const sections = [
      ...head,
      ...(input.changes === undefined
        ? []
        : [renderChanges(input.changes, input, { commits: [], units: diff.units })]),
      `## Concerns\n\n${CONCERNS}`,
      `## Questions from the reviewer\n\n${QUESTIONS}\n\n${CONTEXT_RULE}`,
      units,
    ];
    return `${sections.join("\n\n")}\n`;
  }
  const ctx: Context = {
    commits: input.previousCommits ?? [],
    units: diff.units,
  };
  const sections = [
    ...head,
    ...(input.changes === undefined ? [] : [renderChanges(input.changes, input, ctx)]),
    units,
  ];
  const { previousPlan, review } = input;
  if (previousPlan) {
    sections.push(
      `## Previous plan\n\nCommits are numbered from 1.\n\n${renderPreviousPlan(previousPlan)}`,
    );
  }
  const theirs = review?.comments.filter((c) => c.author !== "agent") ?? [];
  const asked = theirs.filter((c) => c.kind === "question");
  const changes = theirs.filter((c) => c.kind !== "question");
  const questions = [`## Questions from the reviewer\n`, QUESTIONS, `\n${CONTEXT_RULE}`];
  if (review && asked.length > 0) {
    questions.push(
      `\nThe reviewer asked ${asked.length === 1 ? "this question" : "these questions"} about plan v${review.planVersion}. Commits are numbered from 1. Write one response for each.\n`,
      asked.map((c) => renderComment(c, ctx)).join("\n"),
    );
  }
  sections.push(questions.join("\n"));
  if (review && changes.length > 0) {
    sections.push(
      [
        `## Open review comments\n`,
        `A reviewer commented on plan v${review.planVersion}. Commits are numbered from 1.`,
        "Answer every comment below with one entry in `responses`, changing the plan where you agree.\n",
        changes.map((c) => renderComment(c, ctx)).join("\n"),
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

/** What the report needs of a commit; a ProjectedCommit has it, and so does a test fixture. */
export type ReportCommit = Pick<ProjectedCommit, "message" | "refs" | "concerns">;

/** The owning commit of each change line of a hunk, or null when the plan leaves it out. */
function ownersOf(commits: readonly ReportCommit[], hunk: TextHunk): (number | null)[] {
  const owners = new Array<number | null>(hunk.changeCount).fill(null);
  commits.forEach((commit, k) => {
    for (const ref of commit.refs) {
      if (ref.unit !== hunk.id || ref.select.kind !== "lines") continue;
      for (const c of ref.select.changes) owners[c] = k;
    }
  });
  return owners;
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

/** A fence longer than any backtick run in the content, so quoted code cannot close it. */
function fence(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length)));
  return "`".repeat(Math.max(3, longest + 1));
}

const EXCERPT_CONTEXT = 3;

type Quoted = { readonly line: number | null; readonly text: readonly string[] };

/** The lines of a hunk as commit `k` writes them, cut to the picked change lines. Null if no hunk. */
function quoteHunk(
  units: ReadonlyMap<UnitId, Unit>,
  commits: readonly ReportCommit[],
  unit: UnitId,
  k: number,
  picked: readonly number[] | null,
): Quoted | null {
  const hunk = units.get(unit);
  if (hunk?.kind !== "hunk") return null;
  let lines = excerpt(hunk, tipStartOf(hunk, units), ownersOf(commits, hunk), k);
  const marked = lines.flatMap((l, i) =>
    l.change !== null && (picked === null || picked.includes(l.change)) ? [i] : [],
  );
  const first = marked[0];
  const last = marked.at(-1);
  const line = first === undefined ? null : (lines[first]?.tipLine ?? null);
  if (picked !== null && first !== undefined && last !== undefined) {
    lines = lines.slice(Math.max(0, first - EXCERPT_CONTEXT), last + EXCERPT_CONTEXT + 1);
  }
  return { line, text: lines.map((l) => l.text) };
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { blocker: 0, major: 1, minor: 2 };

type Where = {
  readonly path: string | null;
  readonly line: number | null;
  readonly label: string;
  readonly quote: readonly string[];
};

/** The agent's kept concern, with the reviewer's note and severity applied. */
type KeptConcern = { readonly concern: PlacedConcern; readonly commit: number } & {
  readonly severity: Severity;
  readonly note: string | null;
};

type Item = {
  readonly where: Where;
  readonly severity: Severity | null;
  readonly kept: KeptConcern | null;
  readonly comments: Comment[];
};

export type Context = {
  readonly commits: readonly ReportCommit[];
  readonly units: ReadonlyMap<UnitId, Unit>;
};

function lineLabel(line: number | null, fallback: string): string {
  return line === null ? fallback : `line ${line}`;
}

function whereComment(ctx: Context, c: Comment): Where {
  const { anchor } = c;
  switch (anchor.kind) {
    case "plan":
      return { path: null, line: null, label: "whole plan", quote: [] };
    case "message":
      return { path: null, line: null, label: `commit ${anchor.commit + 1} message`, quote: [] };
    case "position":
      return { path: null, line: null, label: `commit ${anchor.commit + 1} position`, quote: [] };
    case "hunk": {
      const pick = pickRows(ctx, anchor);
      if (pick !== null) {
        return {
          path: ctx.units.get(anchor.unit)?.path ?? c.context.path,
          line: pick.line,
          label: `${pick.range.includes("-") ? "lines" : "line"} ${pick.range}${pick.baseSide ? " (base side)" : ""}`,
          quote: pick.rows,
        };
      }
      const quoted = quoteHunk(ctx.units, ctx.commits, anchor.unit, anchor.commit, anchor.changes);
      const path = ctx.units.get(anchor.unit)?.path ?? c.context.path;
      if (quoted === null) {
        return {
          path,
          line: null,
          label: "code that has since changed",
          quote: c.context.lines ?? [],
        };
      }
      return {
        path,
        line: quoted.line,
        label: lineLabel(quoted.line, anchor.unit),
        quote: quoted.text,
      };
    }
    default: {
      const exhaustive: never = anchor;
      return exhaustive;
    }
  }
}

function whereConcern(ctx: Context, kept: KeptConcern): Where {
  const { concern, commit } = kept;
  if (concern.unit === undefined) {
    return { path: null, line: null, label: `commit ${commit + 1}`, quote: [] };
  }
  const path = ctx.units.get(concern.unit)?.path ?? null;
  const quoted = quoteHunk(ctx.units, ctx.commits, concern.unit, commit, concern.lines ?? null);
  if (quoted === null) return { path, line: null, label: concern.unit, quote: [] };
  return {
    path,
    line: quoted.line,
    label: lineLabel(quoted.line, concern.unit),
    quote: quoted.text,
  };
}

/** Whether a comment is about the same lines as a concern: same unit, and lines that intersect. */
function overlaps(kept: KeptConcern, c: Comment): boolean {
  const { anchor } = c;
  const { concern } = kept;
  if (concern.unit === undefined) {
    return (
      (anchor.kind === "message" || anchor.kind === "position") && anchor.commit === kept.commit
    );
  }
  if (anchor.kind !== "hunk" || anchor.unit !== concern.unit) return false;
  if (anchor.changes === null || concern.lines === undefined) return true;
  const mine = concern.lines;
  return anchor.changes.some((n) => mine.includes(n));
}

function keptConcerns(review: Review, commits: readonly ReportCommit[]): KeptConcern[] {
  const decisions = new Map((review.concerns ?? []).map((d) => [d.concern, d]));
  return commits.flatMap((commit, k) =>
    (commit.concerns ?? []).flatMap((concern) => {
      const decision = decisions.get(concern.id);
      if (decision?.decision !== "kept") return [];
      return [
        {
          concern,
          commit: k,
          severity: decision.severity ?? concern.severity,
          note: decision.note ?? null,
        },
      ];
    }),
  );
}

function strongest(severities: readonly (Severity | null)[]): Severity | null {
  return severities.reduce<Severity | null>((best, s) => {
    if (s === null) return best;
    return best === null || SEVERITY_RANK[s] < SEVERITY_RANK[best] ? s : best;
  }, null);
}

/** Kept concerns and rated or code comments become items; a comment joins the concern it overlaps. */
function buildItems(ctx: Context, kept: readonly KeptConcern[], comments: readonly Comment[]) {
  const items: Item[] = kept.map((k) => ({
    where: whereConcern(ctx, k),
    severity: k.severity,
    kept: k,
    comments: [],
  }));
  const merged = new Map<Item, Comment[]>();
  const alone: Item[] = [];
  for (const c of comments) {
    const home = items.find((item) => item.kept !== null && overlaps(item.kept, c));
    if (home !== undefined) merged.set(home, [...(merged.get(home) ?? []), c]);
    else {
      alone.push({
        where: whereComment(ctx, c),
        severity: c.severity ?? null,
        kept: null,
        comments: [c],
      });
    }
  }
  const joined = items.map((item) => {
    const mine = merged.get(item) ?? [];
    return {
      ...item,
      severity: strongest([item.severity, ...mine.map((c) => c.severity ?? null)]),
      comments: mine,
    };
  });
  return [...joined, ...alone];
}

/** Files in diff order, then by line on the branch; items without a line close their file. */
function sortItems<T extends { readonly where: Where }>(
  items: readonly T[],
  units: ReadonlyMap<UnitId, Unit>,
): T[] {
  const order = new Map<string, number>();
  for (const u of units.values()) if (!order.has(u.path)) order.set(u.path, order.size);
  const rank = (path: string | null) =>
    path === null ? order.size + 1 : (order.get(path) ?? order.size);
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        rank(a.item.where.path) - rank(b.item.where.path) ||
        (a.item.where.line ?? Number.MAX_SAFE_INTEGER) -
          (b.item.where.line ?? Number.MAX_SAFE_INTEGER) ||
        a.i - b.i,
    )
    .map(({ item }) => item);
}

function quoteBlock(quote: readonly string[]): string[] {
  if (quote.length === 0) return [];
  const f = fence(quote);
  return [`${f}diff`, ...quote, f];
}

function voices(item: Item) {
  const { kept } = item;
  const out: string[] = [];
  if (kept !== null) out.push(`Agent: ${kept.concern.text}`);
  if (kept?.note) out.push(`Reviewer: ${kept.note}`);
  for (const c of item.comments) {
    out.push(`Reviewer: ${c.body}`, ...renderReplies(c));
  }
  return out;
}

function renderReplies(c: Comment): string[] {
  return (c.replies ?? []).flatMap((r) => {
    const label = r.author === "agent" ? "Agent replied" : "Reviewer replied";
    return [
      `${label}: ${r.body}`,
      ...(r.diagram === undefined ? [] : ["```mermaid", r.diagram.trimEnd(), "```"]),
    ];
  });
}

function itemHeading(item: Item, level: number): string {
  const { where, kept } = item;
  const parts = [where.label, item.severity ?? "unrated"];
  if (kept !== null) parts.push(kept.concern.kind);
  parts.push(
    kept === null ? "raised by the reviewer" : "raised by the agent, kept by the reviewer",
  );
  return `${"#".repeat(level)} ${parts.join(" · ")}`;
}

function renderItems(items: readonly Item[], units: ReadonlyMap<UnitId, Unit>, level: number) {
  const out: string[] = [];
  const sorted = sortItems(items, units);
  const paths = [...new Set(sorted.flatMap((i) => (i.where.path === null ? [] : [i.where.path])))];
  const group = (title: string, members: readonly Item[]): void => {
    if (members.length === 0) return;
    out.push(`${"#".repeat(level)} ${title}`, "");
    for (const item of members) {
      out.push(itemHeading(item, level + 1), "", ...quoteBlock(item.where.quote));
      if (item.where.quote.length > 0) out.push("");
      out.push(...voices(item), "");
    }
  };
  for (const path of paths)
    group(
      path,
      sorted.filter((i) => i.where.path === path),
    );
  group(
    "General",
    sorted.filter((i) => i.where.path === null),
  );
  return out;
}

function summarizeIssues(items: readonly Item[]): string {
  if (items.length === 0) return "no issues";
  const count = (s: Severity | null) => items.filter((i) => i.severity === s).length;
  const tally: [number, string][] = [
    [count("blocker"), "blocker"],
    [count("major"), "major"],
    [count("minor"), "minor"],
    [count(null), "unrated"],
  ];
  const parts = tally.flatMap(([n, label]) => (n === 0 ? [] : [`${n} ${label}`]));
  return `${items.length} ${items.length === 1 ? "issue" : "issues"}: ${parts.join(", ")}`;
}

function renderQuestions(
  ctx: Context,
  questions: readonly Comment[],
  responses: readonly CommentResponse[],
): string[] {
  const items = sortItems(
    questions.map((c) => ({ where: whereComment(ctx, c), comment: c })),
    ctx.units,
  );
  const out = ["## Questions", ""];
  for (const { where, comment } of items) {
    const place = where.path === null ? where.label : `${where.path} · ${where.label}`;
    out.push(`### ${comment.id} · ${place}`, "", ...quoteBlock(where.quote));
    if (where.quote.length > 0) out.push("");
    out.push(`Reviewer asked: ${comment.body}`, ...renderReplies(comment));
    const answer = responses.find((r) => r.comment === comment.id);
    if (answer !== undefined) {
      const at = answer.at;
      const explained =
        at === undefined
          ? ""
          : `, explained in commit ${at.commit}${at.unit === undefined ? "" : ` (${at.unit})`}`;
      out.push(`Answer (${answer.status}${explained}): ${answer.note}`);
    } else if ((comment.replies ?? []).length === 0) out.push("Not answered yet.");
    out.push("");
  }
  return out;
}

/** Threads the agent opened, with what the reviewer said back. */
function renderThreads(ctx: Context, threads: readonly Comment[]): string[] {
  const out = ["## Threads you started", ""];
  for (const c of threads) {
    const where = whereComment(ctx, c);
    const place = where.path === null ? where.label : `${where.path} · ${where.label}`;
    out.push(`### ${c.id} · ${place}`, "", ...quoteBlock(where.quote));
    if (where.quote.length > 0) out.push("");
    out.push(`Agent: ${c.body}`, ...renderReplies(c), "");
  }
  return out;
}

/** Plan feedback for a split review: what the planner answers through `responses`. */
function renderPlanFeedback(ctx: Context, comments: readonly Comment[]): string[] {
  const { commits } = ctx;
  const out: string[] = [];
  const line = (c: Comment) => [`- ${c.id} on ${describeAnchor(c.anchor, ctx)}`];
  const planLevel = comments.filter((c) => c.anchor.kind === "plan");
  if (planLevel.length > 0) {
    out.push("## Whole plan", "");
    for (const c of planLevel) out.push(`- ${c.id}: ${c.body}`, ...renderReplies(c));
    out.push("");
  }
  const orphans = comments.filter(
    (c) => c.anchor.kind !== "plan" && c.anchor.commit >= commits.length,
  );
  commits.forEach((commit, i) => {
    const mine = comments.filter((c) => c.anchor.kind !== "plan" && c.anchor.commit === i);
    if (mine.length === 0) return;
    out.push(`## Commit ${i + 1}: ${commit.message.split("\n")[0] ?? ""}`, "");
    for (const c of mine) {
      out.push(...line(c));
      if (c.context.path) out.push(`  - file: ${c.context.path}`);
      const rows = anchorRows(ctx, c.anchor);
      if (rows.length > 0)
        out.push("  - picked rows are marked >:", ...rows.map((r) => `    ${r}`));
      out.push(`  - ${c.body.split("\n").join("\n    ")}`);
      for (const reply of renderReplies(c)) out.push(`  - ${reply}`);
    }
    out.push("");
  });
  if (orphans.length > 0) {
    out.push("## Commits not in this plan", "");
    for (const c of orphans) out.push(`- ${c.id}: ${c.body}`);
    out.push("");
  }
  return out;
}

/** One line of a hunk with its numbers on the original branch: the tip's, and the base's. */
type NumberedRow = { readonly op: string; readonly tip: number; readonly base: number };

/** The rows `want` picks, numbered as the quoting code numbers them. */
function numberedRows(
  hunk: TextHunk,
  units: ReadonlyMap<UnitId, Unit>,
  want: (offset: number, change: number | null) => boolean,
): NumberedRow[] {
  let tip = tipStartOf(hunk, units);
  let base = hunk.oldStart + 1;
  const rows: NumberedRow[] = [];
  hunk.body.forEach((line, i) => {
    if (want(i, line.op === " " ? null : line.change)) rows.push({ op: line.op, tip, base });
    if (line.op !== "-") tip += 1;
    if (line.op !== "+") base += 1;
  });
  return rows;
}

type Span = {
  readonly newLine: number | null;
  readonly oldLine: number | null;
  readonly startNewLine: number | null;
  readonly startOldLine: number | null;
};

const NO_SPAN: Span = { newLine: null, oldLine: null, startNewLine: null, startOldLine: null };

/** The last row names the line: both sides for context, the tip for an addition, the base for a removal. */
function spanOf(rows: readonly NumberedRow[]): Span {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return NO_SPAN;
  const range = rows.length > 1;
  return {
    newLine: last.op === "-" ? null : last.tip,
    oldLine: last.op === "+" ? null : last.base,
    startNewLine: range && first.op !== "-" ? first.tip : null,
    startOldLine: range && first.op !== "+" ? first.base : null,
  };
}

function commentSpan(ctx: Context, c: Comment): Span {
  const { anchor } = c;
  if (anchor.kind !== "hunk") return NO_SPAN;
  const hunk = ctx.units.get(anchor.unit);
  if (hunk?.kind !== "hunk") return NO_SPAN;
  const { offsets, changes } = anchor;
  if (offsets !== undefined)
    return spanOf(numberedRows(hunk, ctx.units, (i) => offsets.includes(i)));
  return spanOf(
    numberedRows(
      hunk,
      ctx.units,
      (_, n) => n !== null && (changes === null || changes.includes(n)),
    ),
  );
}

function concernSpan(ctx: Context, concern: PlacedConcern): Span {
  const hunk = concern.unit === undefined ? undefined : ctx.units.get(concern.unit);
  if (hunk?.kind !== "hunk") return NO_SPAN;
  const lines = concern.lines;
  return spanOf(
    numberedRows(
      hunk,
      ctx.units,
      (_, n) => n !== null && (lines === undefined || lines.includes(n)),
    ),
  );
}

export type ReportThreadEntry = { readonly author: "agent" | "reviewer"; readonly body: string };

/** One thing to carry to the merge request. Line numbers are the original branch's. */
export type ReportItem = Span & {
  readonly path: string | null;
  readonly oldPath: string | null;
  readonly severity: Severity | null;
  readonly kind: "flag" | "concern" | "question";
  readonly body: string;
  readonly thread: readonly ReportThreadEntry[];
  readonly resolved: boolean;
  readonly excluded: boolean;
};

/** The item with the label the markdown uses to point at it. */
type Collected = { readonly item: ReportItem; readonly where: Where };

function threadOf(c: Comment): ReportThreadEntry[] {
  return (c.replies ?? []).map((r) => ({ author: r.author, body: r.body }));
}

function withSeverity(severity: Severity | null, text: string): string {
  return severity === null ? text : `**${severity}**\n\n${text}`;
}

function collectItems(
  review: Review,
  commits: readonly ReportCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  responses: readonly CommentResponse[],
): Collected[] {
  const ctx: Context = { commits, units };
  const fromReviewer = review.comments.filter((c) => c.author !== "agent");
  const walk = review.mode === "walk";
  const rest = fromReviewer.filter((c) => c.kind !== "question");
  const issues = walk ? rest : rest.filter((c) => c.severity !== undefined);
  const noComments = new Set<string>(review.excluded?.comments ?? []);
  const noConcerns = new Set<string>(review.excluded?.concerns ?? []);
  const resolved = new Set<string>(review.resolved ?? []);
  const out: Collected[] = buildItems(ctx, keptConcerns(review, commits), issues).map((it) => {
    const { kept } = it;
    const first = it.comments[0];
    if (kept !== null) {
      const note = kept.note === null ? "" : `\n\nReviewer: ${kept.note}`;
      const thread = it.comments.flatMap((c): ReportThreadEntry[] => [
        { author: "reviewer", body: c.body },
        ...threadOf(c),
      ]);
      return {
        where: it.where,
        item: {
          ...concernSpan(ctx, kept.concern),
          path: it.where.path,
          oldPath: it.where.path,
          severity: it.severity,
          kind: "concern",
          body: withSeverity(it.severity, `${kept.concern.text}${note}`),
          thread,
          resolved: false,
          excluded: noConcerns.has(kept.concern.id),
        },
      };
    }
    if (first === undefined) throw new Error("an item with neither a concern nor a comment");
    return {
      where: it.where,
      item: {
        ...commentSpan(ctx, first),
        path: it.where.path,
        oldPath: it.where.path,
        severity: it.severity,
        kind: "flag",
        body: withSeverity(it.severity, first.body),
        thread: threadOf(first),
        resolved: resolved.has(first.id),
        excluded: noComments.has(first.id),
      },
    };
  });
  for (const q of fromReviewer.filter((c) => c.kind === "question")) {
    const where = whereComment(ctx, q);
    const answer = responses.find((r) => r.comment === q.id)?.note;
    const lastAgent = (q.replies ?? []).findLast((r) => r.author === "agent")?.body;
    const said = answer ?? lastAgent;
    const details =
      said === undefined ? "" : `\n\n<details><summary>Answer</summary>\n\n${said}\n\n</details>`;
    out.push({
      where,
      item: {
        ...commentSpan(ctx, q),
        path: where.path,
        oldPath: where.path,
        severity: q.severity ?? null,
        kind: "question",
        body: `${q.body}${details}`,
        thread: threadOf(q),
        resolved: resolved.has(q.id),
        excluded: noComments.has(q.id),
      },
    });
  }
  return sortItems(out, units);
}

/**
 * The items of a review for the merge request, in file order then line order, general items last.
 * Excluded ones are present and marked; whoever posts them skips those.
 */
export function reportItems(
  review: Review,
  commits: readonly ReportCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  opts: ReportOptions,
): ReportItem[] {
  return collectItems(review, commits, units, opts.responses).map((c) => c.item);
}

/** A short list of what the reviewer left out, so nothing vanishes without a trace. */
function renderExcluded(collected: readonly Collected[]): string[] {
  const left = collected.filter((c) => c.item.excluded);
  if (left.length === 0) return [];
  const out = ["## Excluded", "", "The reviewer left these out of the hand-off:", ""];
  for (const { item, where } of left) {
    const place = where.path === null ? where.label : `${where.path} · ${where.label}`;
    const first = item.body.split("\n").find((l) => l !== "" && !l.startsWith("**")) ?? "";
    out.push(
      `- ${place} · ${item.kind}${item.severity === null ? "" : ` · ${item.severity}`}: ${first}`,
    );
  }
  out.push("");
  return out;
}

export type ReportOptions = {
  readonly branch: string;
  /** Responses from plans after the review, which answer its questions. */
  readonly responses: readonly CommentResponse[];
};

/**
 * The consolidated report of a review, in the voices of both the reviewer and the agent: the
 * reviewer's comments and the agent's concerns the reviewer kept, grouped by file and ordered by
 * line, then the questions with their answers. A walk review is a code review for the author. A
 * split review is plan feedback for the planner, followed by the same code issues and questions.
 * Concerns the reviewer has not decided are left out, as are those dismissed.
 */
export function renderReport(
  full: Review,
  commits: readonly ReportCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  opts: ReportOptions,
): string {
  const excluded = full.excluded;
  if (excluded === undefined) return renderIncluded(full, commits, units, opts);
  const noComments = new Set<string>(excluded.comments);
  const noConcerns = new Set<string>(excluded.concerns);
  const review: Review = {
    ...full,
    comments: full.comments.filter((c) => !noComments.has(c.id)),
    concerns: (full.concerns ?? []).filter((d) => !noConcerns.has(d.concern)),
  };
  const tail = renderExcluded(collectItems(full, commits, units, opts.responses));
  const main = renderIncluded(review, commits, units, opts);
  return tail.length === 0 ? main : `${main}${main.endsWith("\n") ? "" : "\n"}${tail.join("\n")}`;
}

function renderIncluded(
  review: Review,
  commits: readonly ReportCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  opts: ReportOptions,
): string {
  const ctx: Context = { commits, units };
  const walk = review.mode === "walk";
  const fromReviewer = review.comments.filter((c) => c.author !== "agent");
  // A thread the agent started matters to it only once the reviewer has answered.
  const started = review.comments.filter(
    (c) => c.author === "agent" && (c.replies ?? []).some((r) => r.author === "reviewer"),
  );
  const questions = fromReviewer.filter((c) => c.kind === "question");
  const rest = fromReviewer.filter((c) => c.kind !== "question");
  const issues = walk ? rest : rest.filter((c) => c.severity !== undefined);
  const feedback = walk ? [] : rest.filter((c) => c.severity === undefined);
  const items = buildItems(ctx, keptConcerns(review, commits), issues);
  const out: string[] = [];
  if (walk) {
    out.push(
      `# Code review: ${opts.branch} (${commits.length === 1 ? "1 commit" : `${commits.length} commits`}, ${summarizeIssues(items)})`,
      "",
    );
    if (items.length === 0 && questions.length === 0)
      out.push("The reviewer raised no issues.", "");
    out.push(...renderItems(items, units, 2));
  } else {
    out.push(`# Review of plan v${review.planVersion}`, "");
    if (
      feedback.length === 0 &&
      items.length === 0 &&
      questions.length === 0 &&
      started.length === 0
    ) {
      out.push("No comments.", "");
      return out.join("\n");
    }
    out.push(...renderPlanFeedback(ctx, feedback));
    if (items.length > 0) {
      out.push(`## Code issues (${summarizeIssues(items)})`, "", ...renderItems(items, units, 3));
    }
  }
  if (questions.length > 0) out.push(...renderQuestions(ctx, questions, opts.responses));
  if (started.length > 0) out.push(...renderThreads(ctx, started));
  if (walk && items.length > 0) {
    out.push(
      "Address each issue above in the code on this branch, then tell the reviewer what you changed and what you chose not to change and why.",
      "",
    );
  }
  if (!walk && (feedback.length > 0 || questions.length > 0)) {
    out.push(
      "Answer every comment id above in `responses` of the next draft, then run `follow-me check` and `follow-me apply`.",
      "",
    );
  }
  const onContext = review.comments.some((c) => pickRows(ctx, c.anchor)?.touchesContext);
  if (onContext) out.push(CONTEXT_RULE, "");
  if (!walk && items.length > 0) {
    out.push("Fix the code issues on the original branch, then run `follow-me extract` again.", "");
  }
  return out.join("\n");
}

function renderEvent(event: ServerEvent, ctx: Context | null): string[] {
  switch (event.type) {
    case "comment":
    case "comment-updated": {
      const { comment: c } = event;
      const what = c.kind === "question" ? "question" : "comment";
      const verb = event.type === "comment" ? "new" : "edited";
      const lines = [`- ${verb} ${what} ${c.id} on ${describeAnchor(c.anchor, ctx)}`];
      const rows = anchorRows(ctx, c.anchor);
      if (rows.length > 0) lines.push(...rows.map((r) => `  ${r}`));
      if (c.context.path) lines.push(`  - file: ${c.context.path}`);
      if (c.severity) lines.push(`  - severity: ${c.severity}`);
      if (c.follows) lines.push(`  - asks again after ${c.follows}`);
      lines.push(`  - ${c.body.split("\n").join("\n    ")}`);
      return lines;
    }
    case "comment-deleted":
      return [`- comment ${event.id} was deleted`];
    case "reply":
      return [`- ${event.reply.author} replied under ${event.commentId}: ${event.reply.body}`];
    case "concern": {
      const severity = event.severity === undefined ? "" : ` as ${event.severity}`;
      const note = event.note === undefined ? "" : `: ${event.note}`;
      return [`- concern ${event.concernId} ${event.decision}${severity}${note}`];
    }
    case "resolved":
      return [`- question ${event.commentId} marked ${event.resolved ? "resolved" : "open again"}`];
    case "version":
      return [`- plan v${event.version} is now open`];
    case "submitted":
      return ["- the reviewer submitted the review; the held flags follow as new comments"];
    case "ended":
      return [`- the reviewer ended the review; the report is next to ${event.review}`];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** A markdown digest of what happened on the review page, for `follow-me watch`. */
export function renderEvents(events: readonly ServerEvent[], ctx: Context | null = null): string {
  const first = events[0]?.seq;
  const last = events.at(-1)?.seq;
  const range = first === last ? `event ${first}` : `events ${first}-${last}`;
  const body = events.flatMap((event) => renderEvent(event, ctx));
  return [`# Review activity (${range})`, "", ...body, ""].join("\n");
}
