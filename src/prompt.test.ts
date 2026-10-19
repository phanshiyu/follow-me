import assert from "node:assert/strict";
import { test } from "node:test";
import { type PromptInput, renderFeedback, renderPrompt } from "./prompt.ts";
import type { Diff, PlanFile, Review } from "./types.ts";

// JSON.parse is the only brand-free way to build branded literals without a cast.
function fixtureDiff(): Diff {
  const parsed = JSON.parse(
    JSON.stringify({
      base: "1".repeat(40),
      tip: "2".repeat(40),
      baseTree: "3".repeat(40),
      tipTree: "4".repeat(40),
      units: {
        h_aaaaaaaaaaaa: {
          kind: "hunk",
          id: "h_aaaaaaaaaaaa",
          path: "src/a.ts",
          oldStart: 0,
          changeCount: 4,
          body: [
            { op: "-", text: "old1\n", change: 0 },
            { op: "+", text: "new1\n", change: 1 },
            { op: " ", text: "same\n" },
            { op: "-", text: "old2\n", change: 2 },
            { op: "+", text: "new2\n", change: 3 },
          ],
        },
        f_cccccccccccc: {
          kind: "file",
          id: "f_cccccccccccc",
          path: "logo.png",
          before: null,
          after: { mode: "100644", blob: "4".repeat(40) },
          reason: "binary",
        },
        m_dddddddddddd: {
          kind: "mode",
          id: "m_dddddddddddd",
          path: "run.sh",
          from: "100644",
          to: "100755",
        },
        h_bbbbbbbbbbbb: {
          kind: "hunk",
          id: "h_bbbbbbbbbbbb",
          path: "src/a.ts",
          oldStart: 20,
          changeCount: 1,
          body: [{ op: "+", text: "tail\n", change: 0 }],
        },
      },
    }),
  );
  return { ...parsed, units: new Map(Object.entries(parsed.units)), textFiles: new Map() };
}

function fixturePlan(): PlanFile {
  return JSON.parse(
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: "1".repeat(40),
      tip: "2".repeat(40),
      commits: [
        {
          message: "Add parser\n\nbody",
          units: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1, 2, 3, 7] } }],
        },
        { message: "Use it", units: [{ unit: "h_bbbbbbbbbbbb", select: { kind: "rest" } }] },
      ],
      responses: [],
    }),
  );
}

function fixtureReview(): Review {
  return JSON.parse(
    JSON.stringify({
      schema: "follow-me/review@1",
      mode: "split",
      planVersion: 2,
      planHash: "abc",
      endedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c_abcdef",
          anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes: [1, 3] },
          context: { commitMessage: "Add parser", path: "src/a.ts" },
          body: "why drop old1?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_ghijkl",
          anchor: { kind: "position", commit: 1 },
          context: { commitMessage: "Use it", path: null },
          body: "belongs first",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_mnopqr",
          anchor: { kind: "plan" },
          context: { commitMessage: "", path: null },
          body: "too coarse overall",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
}

const first = {
  mode: "split",
  diff: fixtureDiff(),
  previousPlan: null,
  review: null,
  draftPath: "/d/draft.json",
  checkCommand: "follow-me check",
} satisfies PromptInput;

test("the prompt dumps units grouped by path with indexed change lines", () => {
  const text = renderPrompt(first);
  assert.ok(
    text.includes(
      [
        "### src/a.ts",
        "",
        "h_aaaaaaaaaaaa  src/a.ts  (4 change lines)",
        "[0]- old1",
        "[1]+ new1",
        "    same",
        "[2]- old2",
        "[3]+ new2",
        "",
        "h_bbbbbbbbbbbb  src/a.ts  (1 change lines)",
        "[0]+ tail",
        "",
        "### logo.png",
        "",
        "f_cccccccccccc  logo.png  binary file added  (whole unit, no lines)",
        "",
        "### run.sh",
        "",
        "m_dddddddddddd  run.sh  mode 100644 -> 100755  (whole unit, no lines)",
      ].join("\n"),
    ),
  );
});

test("the prompt names the draft path, the format and the rules", () => {
  const text = renderPrompt(first);
  assert.ok(text.includes("Write the plan as JSON to /d/draft.json."));
  assert.ok(text.includes('"schema": "follow-me/plan@1"'));
  assert.ok(text.includes(`"base": "${"1".repeat(40)}"`));
  assert.ok(text.includes('"units": ["h_0123456789ab", "h_ba9876543210:0-3,7"]'));
  assert.ok(text.includes("Every change line must be used exactly once across all commits."));
  assert.ok(
    text.includes(
      'A bare "h_x" takes every change line of that hunk that no other commit claimed.',
    ),
  );
  assert.ok(text.includes("A failing test comes before the fix that makes it pass."));
  assert.ok(!text.includes("## Previous plan"));
  assert.ok(!text.includes("## Open review comments"));
});

test("a previous plan and open comments are appended with the response instruction", () => {
  const text = renderPrompt({
    ...first,
    previousPlan: fixturePlan(),
    review: fixtureReview(),
  });
  assert.ok(
    text.includes(
      [
        "## Previous plan",
        "",
        "Commits are numbered from 1.",
        "",
        "1. Add parser",
        "  - h_aaaaaaaaaaaa:0-3,7",
        "2. Use it",
        "  - h_bbbbbbbbbbbb",
      ].join("\n"),
    ),
  );
  assert.ok(
    text.includes(
      [
        "- c_abcdef  on h_aaaaaaaaaaaa (change lines 1,3) in commit 1",
        '  commit message then: "Add parser"',
        "  path: src/a.ts",
        '  comment: "why drop old1?"',
      ].join("\n"),
    ),
  );
  assert.ok(text.includes("- c_ghijkl  on the position of commit 2"));
  assert.ok(text.includes("- c_mnopqr  on the whole plan"));
  assert.ok(text.includes("Answer every comment below with one entry in `responses`"));
});

test("rendering the same input twice gives identical text", () => {
  const input = { ...first, previousPlan: fixturePlan(), review: fixtureReview() };
  assert.equal(renderPrompt(input), renderPrompt(input));
  assert.equal(
    renderFeedback(fixtureReview(), fixturePlan(), fixtureDiff().units),
    renderFeedback(fixtureReview(), fixturePlan(), fixtureDiff().units),
  );
});

test("feedback is a markdown digest grouped by plan, then commit", () => {
  assert.equal(
    renderFeedback(fixtureReview(), fixturePlan(), fixtureDiff().units),
    [
      "# Review of plan v2",
      "",
      "## Whole plan",
      "",
      "- c_mnopqr: too coarse overall",
      "",
      "## Commit 1: Add parser",
      "",
      "- c_abcdef on h_aaaaaaaaaaaa (change lines 1,3) in commit 1",
      "  - file: src/a.ts",
      "  - why drop old1?",
      "",
      "## Commit 2: Use it",
      "",
      "- c_ghijkl on the position of commit 2 (the reviewer thinks it belongs elsewhere)",
      "  - belongs first",
      "",
      "Answer every comment id above in `responses` of the next draft, then run `follow-me check` and `follow-me apply`.",
      "",
    ].join("\n"),
  );
});

test("the walk prompt writes for a first-time reviewer and asks for narration", () => {
  const walk = renderPrompt({
    mode: "walk",
    diff: fixtureDiff(),
    draftPath: "/d/draft.json",
    checkCommand: "follow-me check --branch pr-7",
  });
  assert.ok(walk.startsWith("# follow-me: tell the story of this branch\n"));
  assert.ok(
    walk.includes(
      "The reader is a reviewer meeting this branch for the first time. They will watch it\nbeing written commit by commit,",
    ),
  );
  assert.ok(walk.includes("Give every commit a `narration`."));
  assert.ok(walk.includes("wherever the why of that hunk is not\nobvious"));
  assert.ok(
    walk.includes("keyboard: first person, present tense, two or three sentences, no markdown."),
  );
  assert.ok(walk.includes("Check your work with `follow-me check --branch pr-7`"));
  assert.ok(walk.includes("[3]+ new2"));
  assert.ok(
    walk.includes('{ "unit": "h_ba9876543210", "narration": "The loop is boring on purpose." }'),
  );
  const split = renderPrompt(first);
  assert.ok(split.startsWith("# follow-me: plan the commits\n"));
  assert.ok(!split.includes("reviewer meeting this branch"));
});

test("a walk review renders as a code review grouped by file with quoted diff excerpts", () => {
  const plan: PlanFile = JSON.parse(
    JSON.stringify({
      schema: "follow-me/plan@1",
      base: "1".repeat(40),
      tip: "2".repeat(40),
      commits: [
        {
          message: "Rename",
          units: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1] } }],
        },
        {
          message: "Swap the second line",
          units: [
            { unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [2, 3] } },
            { unit: "h_bbbbbbbbbbbb", select: { kind: "rest" } },
          ],
        },
      ],
      responses: [],
    }),
  );
  const review: Review = JSON.parse(
    JSON.stringify({
      schema: "follow-me/review@1",
      mode: "walk",
      planVersion: 1,
      planHash: "abc",
      endedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c_mnopqr",
          anchor: { kind: "plan" },
          context: { commitMessage: "", path: null },
          body: "Nice and small overall.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_tailzz",
          anchor: { kind: "hunk", unit: "h_bbbbbbbbbbbb", commit: 1, changes: null },
          context: { commitMessage: "Swap the second line", path: "src/a.ts" },
          body: "Does tail need a newline?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_abcdef",
          anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 1, changes: [3] },
          context: { commitMessage: "Swap the second line", path: "src/a.ts" },
          body: "new2 should be\nnamed for what it holds.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  assert.equal(
    renderFeedback(review, plan, fixtureDiff().units),
    [
      "# Code review",
      "",
      "A reviewer watched this branch being written commit by commit and left 3 comments.",
      "",
      "## src/a.ts",
      "",
      "### c_tailzz, line 21",
      "",
      "```diff",
      "+tail",
      "```",
      "",
      "Does tail need a newline?",
      "",
      "### c_abcdef, line 3",
      "",
      "```diff",
      " new1",
      " same",
      "-old2",
      "+new2",
      "```",
      "",
      "new2 should be",
      "named for what it holds.",
      "",
      "## General",
      "",
      "### c_mnopqr",
      "",
      "Nice and small overall.",
      "",
      "Address each comment above in the code on this branch, then tell the reviewer what you changed and what you chose not to change and why.",
      "",
    ].join("\n"),
  );
});
