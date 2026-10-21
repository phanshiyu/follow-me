import type {
  Anchor,
  Comment,
  CommentResponse,
  Diff,
  PlacedConcern,
  PlanFile,
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
  if (comment.follows) lines.push(`  asks again after ${comment.follows}`);
  if (comment.context.commitMessage) {
    lines.push(`  commit message then: ${JSON.stringify(comment.context.commitMessage)}`);
  }
  if (comment.context.path) lines.push(`  path: ${comment.context.path}`);
  if (comment.context.lines && comment.context.lines.length > 0) {
    lines.push("  lines asked about:", ...comment.context.lines.map((l) => `    ${l}`));
  }
  if (comment.severity) lines.push(`  severity: ${comment.severity}`);
  lines.push(`  comment: ${JSON.stringify(comment.body)}`);
  for (const reply of comment.replies ?? []) {
    lines.push(`  ${reply.author} replied: ${JSON.stringify(reply.body)}`);
  }
  return lines.join("\n");
}

const QUESTIONS = `A question is not a request to change the plan. Answer it by explaining, not by moving lines. Where the asked-about lines now live, add or rewrite the \`narration\` of that commit or unit so it answers the question, in plain spoken sentences. When the answer is about flow, structure or order across files, add a \`diagram\` there too. Then write one response with \`"status": "answered"\`, a \`note\` of one to three sentences that answers the question directly, and \`"at"\` naming the commit (1-based) and unit that carry the explanation. Move lines only if answering shows the order itself was wrong. Say so in the note, and answer the question as well. If the diff cannot answer it, use \`"deferred"\` and say what is missing.`;

const CONCERNS = `You are also a careful reviewer. Add a concern only for something you would raise in a pull request: a bug or unhandled case, a change with no test where one is expected, a name that misleads, or a risky change such as a migration, concurrency or security. Pin it to the change lines with \`lines\`. Say what goes wrong and when, in one or two sentences. Severity: \`blocker\` breaks behaviour or loses data, \`major\` should be fixed before merge, \`minor\` is worth a note. Do not flag style, formatting or taste. Do not repeat the narration. Most commits deserve no concern, and a plan with none is fine. Never write more than one concern per unit. Concerns are in your voice as a reviewer, while narration stays the author's.

A concern is \`{ "severity": "blocker" | "major" | "minor", "kind": "bug" | "missing-test" | "naming" | "risk", "text": "...", "lines": [0, 1] }\`. \`lines\` holds change indices of that unit and is allowed only on a unit ref. Write \`"concerns": [ ... ]\` on a commit, or on a unit written as an object: \`{ "unit": "h_x:0-3", "concerns": [ ... ] }\`. Never write an id; follow-me derives one.`;

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
- Check your work with \`${checkCommand}\` and fix every issue it prints.`;

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
      `## Concerns\n\n${CONCERNS}`,
      `## Questions from the reviewer\n\n${QUESTIONS}`,
      units,
    ];
    return `${sections.join("\n\n")}\n`;
  }
  const sections = [...head, units];
  const { previousPlan, review } = input;
  if (previousPlan) {
    sections.push(
      `## Previous plan\n\nCommits are numbered from 1.\n\n${renderPreviousPlan(previousPlan)}`,
    );
  }
  const asked = review?.comments.filter((c) => c.kind === "question") ?? [];
  const changes = review?.comments.filter((c) => c.kind !== "question") ?? [];
  const questions = [`## Questions from the reviewer\n`, QUESTIONS];
  if (review && asked.length > 0) {
    questions.push(
      `\nThe reviewer asked ${asked.length === 1 ? "this question" : "these questions"} about plan v${review.planVersion}. Commits are numbered from 1. Write one response for each.\n`,
      asked.map(renderComment).join("\n"),
    );
  }
  sections.push(questions.join("\n"));
  if (review && changes.length > 0) {
    sections.push(
      [
        `## Open review comments\n`,
        `A reviewer commented on plan v${review.planVersion}. Commits are numbered from 1.`,
        "Answer every comment below with one entry in `responses`, changing the plan where you agree.\n",
        changes.map(renderComment).join("\n"),
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

type Context = {
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

/** Plan feedback for a split review: what the planner answers through `responses`. */
function renderPlanFeedback(
  commits: readonly ReportCommit[],
  comments: readonly Comment[],
): string[] {
  const out: string[] = [];
  const line = (c: Comment) => [`- ${c.id} on ${describeAnchor(c.anchor)}`];
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
  review: Review,
  commits: readonly ReportCommit[],
  units: ReadonlyMap<UnitId, Unit>,
  opts: ReportOptions,
): string {
  const ctx: Context = { commits, units };
  const walk = review.mode === "walk";
  const questions = review.comments.filter((c) => c.kind === "question");
  const rest = review.comments.filter((c) => c.kind !== "question");
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
    if (feedback.length === 0 && items.length === 0 && questions.length === 0) {
      out.push("No comments.", "");
      return out.join("\n");
    }
    out.push(...renderPlanFeedback(commits, feedback));
    if (items.length > 0) {
      out.push(`## Code issues (${summarizeIssues(items)})`, "", ...renderItems(items, units, 3));
    }
  }
  if (questions.length > 0) out.push(...renderQuestions(ctx, questions, opts.responses));
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
  if (!walk && items.length > 0) {
    out.push("Fix the code issues on the original branch, then run `follow-me extract` again.", "");
  }
  return out.join("\n");
}

function renderEvent(event: ServerEvent): string[] {
  switch (event.type) {
    case "comment":
    case "comment-updated": {
      const { comment: c } = event;
      const what = c.kind === "question" ? "question" : "comment";
      const verb = event.type === "comment" ? "new" : "edited";
      const lines = [`- ${verb} ${what} ${c.id} on ${describeAnchor(c.anchor)}`];
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
    case "ended":
      return [`- the reviewer ended the review; the report is next to ${event.review}`];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** A markdown digest of what happened on the review page, for `follow-me watch`. */
export function renderEvents(events: readonly ServerEvent[]): string {
  const first = events[0]?.seq;
  const last = events.at(-1)?.seq;
  const range = first === last ? `event ${first}` : `events ${first}-${last}`;
  return [`# Review activity (${range})`, "", ...events.flatMap(renderEvent), ""].join("\n");
}
