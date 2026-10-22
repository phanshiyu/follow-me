import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadDiff } from "../src/git.ts";
import { renderPrompt } from "../src/prompt.ts";
import { makeFixtureRepo } from "./fixture-repo.ts";

const SKILL = readFileSync(new URL("../skills/follow-me/SKILL.md", import.meta.url), "utf8");

/** The skill section prompt.md sends the agent to, with line breaks folded like prose. */
function section(name: string): string {
  const start = SKILL.indexOf(`\n## ${name}\n`);
  assert.ok(start !== -1, `the skill has no "## ${name}" section`);
  const end = SKILL.indexOf("\n## ", start + 1);
  return SKILL.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

/**
 * Every instruction prompt.md carried before it kept only session data, as the skill now words
 * it. The old ordering rules are not here: top-down replaced them.
 */
const MOVED = [
  "You are reordering a finished branch into a series of commits that a reader can follow as the author's thought process.",
  "The final tree is fixed.",
  "You only decide how its change lines are grouped and ordered.",
  "The reader is a reviewer meeting this branch for the first time.",
  "They will read it commit by commit and comment on the code itself.",
  "You decide how its change lines are grouped and ordered, and why each step is there.",
  "One idea per commit.",
  "Prefer many small commits over a few large ones.",
  "Commits do not need to compile or pass tests on their own",
  "The last commit must bring the tree to exactly the tip, which follows from covering every unit.",
  "Write each commit message as a short imperative title, then a blank line and a body that says why.",
  "Put the why in the body first, before anything else.",
  "Keep the title to 50 characters or fewer; put detail in the body.",
  "Add a `narration` to a commit, or to a unit, only when it says something the commit message body does not.",
  "The page shows it as your note.",
  "A note is one plain paragraph on why, in plain text with no markdown.",
  "Say why, not what the lines already show.",
  "Leave it out when the body already says it.",
  "Write the plan as JSON to the draft path in prompt.md, with its base and tip.",
  "Write only the file, in this format:",
  '"schema": "follow-me/plan@1"',
  '"responses": [ { "comment": "c_abc234", "status": "addressed", "note": "Split the hunk and moved it earlier." } ]',
  "`narration` is optional on a commit and on a unit, and the page shows it as your note.",
  'A unit with a note is written as `{ "unit": "<ref>", "narration": "..." }` instead of the plain ref string.',
  '`diagram` is optional on a commit and on a unit, written the same way: `{ "unit": "<ref>", "diagram": "..." }`.',
  "It is Mermaid source that the review page draws beside the code: a commit's diagram under its commit, a unit's under its hunk.",
  "Add one only where a picture says what the code and prose cannot: data flowing between modules, a state machine, a call graph, or the before and after shape of a structure.",
  "Most commits need none.",
  '"diagram": "flowchart LR\\n parse --> validate --> apply"',
  "The note stays plain text even when a diagram is present.",
  "`responses` is [] when there are no review comments.",
  '`status` is one of "addressed", "declined", "deferred" or, for a question, "answered", and `note` says what you did or why not.',
  'An "answered" response also carries `"at": { "commit": 3, "unit": "h_x" }`: the commit, counted from 1, and optionally the unit that holds the explanation.',
  'A unit is "h_…" (a text hunk), "f_…" (a whole file) or "m_…" (a mode change).',
  "Change lines are shown as `[n]+ text` or `[n]- text`. Indented lines without a bracket are context and cannot be selected.",
  '"h_x:0-3,7" takes change lines 0, 1, 2, 3 and 7 of hunk h_x.',
  'A bare "h_x" takes every change line of that hunk that no other commit claimed.',
  "Every change line must be used exactly once across all commits. Never repeat a line.",
  "Use the unit ids exactly as printed. Do not invent ids.",
  '"f_…" and "m_…" units are taken whole, never with a line list.',
  "Every commit needs a non-empty message and at least one unit.",
  "Keep every file syntactically whole in every commit: a function with its closing brace, a block with both ends, an import before or with its first use.",
  "Commits need not build or pass tests, but each file a commit writes must parse.",
  "Check your work with the check command in prompt.md and fix every issue it prints, syntax errors included.",
  "You are also a careful reviewer.",
  "Add a concern only for something you would raise in a pull request: a bug or unhandled case, a change with no test where one is expected, a name that misleads, or a risky change such as a migration, concurrency or security.",
  "Pin it to the change lines with `lines`.",
  "Say what goes wrong and when, in one or two sentences.",
  "Severity: `blocker` breaks behaviour or loses data, `major` should be fixed before merge, `minor` is worth a note.",
  "Do not flag style, formatting or taste. Do not repeat the note.",
  "Most commits deserve no concern, and a plan with none is fine.",
  "Never write more than one concern per unit.",
  "Concerns are in your voice as a reviewer, while the note stays the author's.",
  'A concern is `{ "severity": "blocker" | "major" | "minor", "kind": "bug" | "missing-test" | "naming" | "risk", "text": "...", "lines": [0, 1] }`.',
  "`lines` holds change indices of that unit and is allowed only on a unit ref.",
  'Write `"concerns": [ ... ]` on a commit, or on a unit written as an object: `{ "unit": "h_x:0-3", "concerns": [ ... ] }`.',
  "Never write an id; follow-me derives one.",
  "Commits are numbered from 1",
  "with one entry in `responses`, changing the plan where you agree.",
  "A question is not a request to change the plan. Answer it by explaining, not by moving lines.",
  "Where the asked-about lines now live, add or rewrite the `narration` (the page shows it as your note) of that commit or unit so it answers the question, in plain sentences.",
  "When the answer is about flow, structure or order across files, add a `diagram` there too.",
  'Then write one response with `"status": "answered"`, a `note` of one to three sentences that answers the question directly, and `"at"` naming the commit (1-based) and unit that carry the explanation.',
  "Move lines only if answering shows the order itself was wrong. Say so in the note, and answer the question as well.",
  'If the diff cannot answer it, use `"deferred"` and say what is missing.',
  "A comment on a context row (marked `>` with no + or -) is about code this branch leaves alone or depends on.",
  "The plan cannot move it, so do not move lines because of it.",
  "Answer a question with an explanation, or point at the commit that last touched those lines.",
  "Answer a change request as a code issue, not by reordering.",
  "every unit whose hunk did not change keeps its commit, and any commit left with no unit was dropped.",
  "Put each new unit into a commit, an existing one or a new one, and keep the rest as it is.",
  "post the same with `follow-me reply <id>`.",
];

test("every rule that left prompt.md is in the skill section the prompt names", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const prompt = renderPrompt({
    mode: "split",
    diff: await loadDiff(repo.dir, "main", "feature"),
    draftPath: "/d/draft.json",
    checkCommand: "follow-me check",
    previousPlan: null,
    review: null,
  });
  const named = /"([^"]+)" in the follow-me skill/.exec(prompt)?.[1];
  assert.equal(named, "Writing the draft");
  const rules = section(named);
  const missing = MOVED.filter((sentence) => !rules.includes(sentence.replace(/\s+/g, " ")));
  assert.deepEqual(missing, []);
});

test("the fixture's prompt and the skill tell the agent to put the guard calls before the guard", async (t) => {
  const repo = makeFixtureRepo();
  t.after(repo.cleanup);
  const diff = await loadDiff(repo.dir, "main", "feature");
  const prompt = renderPrompt({
    mode: "walk",
    diff,
    draftPath: "/d/draft.json",
    checkCommand: "follow-me check",
  });
  // lib.js calls assertNumber, which guard.js defines: the entry point and the helper it calls.
  assert.match(prompt, /\[\d+\]\+ {3}assertNumber\(a\);/);
  assert.match(prompt, /\[0\]\+ export function assertNumber\(x\) \{/);
  const rules = section("Writing the draft");
  const order = [
    "1. Pure moves and renames first.",
    "2. Then the entry point and the main flow, the what:",
    "3. Then each step it calls, in the order it calls them.",
    "4. Then helpers, utilities, formatting and edge cases, the how.",
    "5. A test goes with the behaviour it pins, right after it.",
    "6. Config, wiring and lockfiles last, unless the story needs them earlier.",
  ].map((rule) => rules.indexOf(rule));
  assert.deepEqual(
    order.map((at) => at >= 0),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.ok(!rules.includes("Scaffolding and types come before"));
});

test("the skill asks for one coverage run per test and maps a transition to the line that performs it", () => {
  assert.ok(section("Coverage").includes("run the tests one at a time with coverage"));
  assert.ok(section("Offers").includes("Map a transition to the line that performs it"));
});
