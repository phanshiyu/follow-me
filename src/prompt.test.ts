import assert from "node:assert/strict";
import { test } from "node:test";
import { type PromptInput, type ReportCommit, renderPrompt, renderReport } from "./prompt.ts";
import type { Diff, PlanFile, Review } from "./types.ts";

// The plan as validation projects it: explicit lines per unit, in commit order.
function fixtureCommits(): ReportCommit[] {
  return JSON.parse(
    JSON.stringify([
      {
        message: "Add parser\n\nbody",
        refs: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1, 2, 3] } }],
      },
      {
        message: "Use it",
        refs: [{ unit: "h_bbbbbbbbbbbb", select: { kind: "lines", changes: [0] } }],
      },
    ]),
  );
}

const REPORT = { branch: "feature", responses: [] };

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
        "h_aaaaaaaaaaaa  (4 change lines)",
        "[0]- old1",
        "[1]+ new1",
        "    same",
        "[2]- old2",
        "[3]+ new2",
        "",
        "h_bbbbbbbbbbbb  (1 change lines)",
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

test("the prompt names the session and the skill section, and leaves the rules to the skill", () => {
  const text = renderPrompt({ ...first, skillPath: "/pkg/skills/follow-me/SKILL.md" });
  assert.equal(
    text.split("\n## Units")[0],
    [
      "# follow-me: plan the commits",
      "",
      'Write the draft as "Writing the draft" in the follow-me skill says, in author mode. If it is not loaded, read /pkg/skills/follow-me/SKILL.md.',
      "",
      "- draft: /d/draft.json",
      `- base: ${"1".repeat(40)}`,
      `- tip: ${"2".repeat(40)}`,
      "- check: follow-me check",
      "",
    ].join("\n"),
  );
  assert.ok(!text.includes("## Previous plan"));
  assert.ok(!text.includes("## Open review comments"));
  assert.ok(!text.includes("## Questions"));
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
  assert.ok(text.includes("## Open review comments, on plan v2\n"));
});

test("rendering the same input twice gives identical text", () => {
  const input = { ...first, previousPlan: fixturePlan(), review: fixtureReview() };
  assert.equal(renderPrompt(input), renderPrompt(input));
  assert.equal(
    renderReport(fixtureReview(), fixtureCommits(), fixtureDiff().units, REPORT),
    renderReport(fixtureReview(), fixtureCommits(), fixtureDiff().units, REPORT),
  );
});

test("feedback is a markdown digest grouped by plan, then commit", () => {
  assert.equal(
    renderReport(fixtureReview(), fixtureCommits(), fixtureDiff().units, REPORT),
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

test("the walk prompt names reviewer mode and the branch in the check command", () => {
  const walk = renderPrompt({
    mode: "walk",
    diff: fixtureDiff(),
    draftPath: "/d/draft.json",
    checkCommand: "follow-me check --branch pr-7",
  });
  assert.ok(walk.startsWith("# follow-me: tell the story of this branch\n"));
  assert.ok(walk.includes('"Writing the draft" in the follow-me skill says, in reviewer mode.'));
  assert.ok(walk.includes("- check: follow-me check --branch pr-7\n"));
  assert.ok(walk.includes("[3]+ new2"));
  const split = renderPrompt(first);
  assert.ok(split.includes("in author mode."));
});

function reportFixture(): { review: Review; commits: ReportCommit[] } {
  const stamp = "2026-01-01T00:00:00.000Z";
  const context = { commitMessage: "Add parser", path: "src/a.ts" };
  return JSON.parse(
    JSON.stringify({
      commits: [
        {
          message: "Add parser\n\nbody",
          refs: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1, 2, 3] } }],
          concerns: [
            {
              id: "k_0a1b2c3d",
              unit: "h_aaaaaaaaaaaa",
              severity: "major",
              kind: "bug",
              text: "new2 replaces old2 and drops its guard.",
              lines: [3],
            },
          ],
        },
        {
          message: "Use it",
          refs: [{ unit: "h_bbbbbbbbbbbb", select: { kind: "lines", changes: [0] } }],
          concerns: [
            {
              id: "k_4e5f6a7b",
              unit: "h_bbbbbbbbbbbb",
              severity: "minor",
              kind: "missing-test",
              text: "tail has no test.",
            },
          ],
        },
      ],
      review: {
        schema: "follow-me/review@1",
        mode: "walk",
        planVersion: 1,
        planHash: "abc",
        endedAt: stamp,
        concerns: [
          { concern: "k_0a1b2c3d", decision: "kept" },
          { concern: "k_4e5f6a7b", decision: "dismissed" },
        ],
        comments: [
          {
            id: "c_tailzz",
            anchor: { kind: "hunk", unit: "h_bbbbbbbbbbbb", commit: 1, changes: null },
            context: { commitMessage: "Use it", path: "src/a.ts" },
            body: "Does tail need a newline?",
            createdAt: stamp,
          },
          {
            id: "c_guardx",
            anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes: [3] },
            context,
            body: "Agreed, and new1 has the same gap.",
            severity: "blocker",
            createdAt: stamp,
          },
          {
            id: "c_whydro",
            anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes: [1] },
            context,
            body: "Why drop old1?",
            kind: "question",
            createdAt: stamp,
            replies: [
              {
                id: "r_abcdef",
                author: "agent",
                body: "new1 covers it.",
                createdAt: stamp,
              },
            ],
          },
          {
            id: "c_mnopqr",
            anchor: { kind: "plan" },
            context: { commitMessage: "", path: null },
            body: "Nice and small overall.",
            createdAt: stamp,
          },
        ],
      },
    }),
  );
}

test("a walk report merges the reviewer and the agent, orders by line and ends with questions", () => {
  const { review, commits } = reportFixture();
  const answer = JSON.parse(
    JSON.stringify([
      {
        comment: "c_whydro",
        status: "answered",
        note: "old1 is replaced by new1 on the same line.",
        at: { commit: 1, unit: "h_aaaaaaaaaaaa" },
      },
    ]),
  );
  assert.equal(
    renderReport(review, commits, fixtureDiff().units, { branch: "feature", responses: answer }),
    [
      "# Code review: feature (2 commits, 3 issues: 1 blocker, 2 unrated)",
      "",
      "## src/a.ts",
      "",
      "### line 3 · blocker · bug · raised by the agent, kept by the reviewer",
      "",
      "```diff",
      "+new1",
      " same",
      "-old2",
      "+new2",
      "```",
      "",
      "Agent: new2 replaces old2 and drops its guard.",
      "Reviewer: Agreed, and new1 has the same gap.",
      "",
      "### line 21 · unrated · raised by the reviewer",
      "",
      "```diff",
      "+tail",
      "```",
      "",
      "Reviewer: Does tail need a newline?",
      "",
      "## General",
      "",
      "### whole plan · unrated · raised by the reviewer",
      "",
      "Reviewer: Nice and small overall.",
      "",
      "## Questions",
      "",
      "### c_whydro · src/a.ts · line 1",
      "",
      "```diff",
      "-old1",
      "+new1",
      " same",
      "-old2",
      "+new2",
      "```",
      "",
      "Reviewer asked: Why drop old1?",
      "Agent replied: new1 covers it.",
      "Answer (answered, explained in commit 1 (h_aaaaaaaaaaaa)): old1 is replaced by new1 on the same line.",
      "",
      "Address each issue above in the code on this branch, then tell the reviewer what you changed and what you chose not to change and why.",
      "",
    ].join("\n"),
  );
});

test("a split report keeps plan feedback for the planner and adds code issues and questions", () => {
  const { review, commits } = reportFixture();
  const split: Review = { ...review, mode: "split" };
  const text = renderReport(split, commits, fixtureDiff().units, REPORT);
  assert.ok(text.startsWith("# Review of plan v1\n\n## Whole plan\n\n- c_mnopqr: Nice"));
  assert.ok(text.includes("## Commit 2: Use it\n\n- c_tailzz on h_bbbbbbbbbbbb"));
  assert.ok(
    text.includes(
      "## Code issues (1 issue: 1 blocker)\n\n### src/a.ts\n\n#### line 3 · blocker · bug",
    ),
  );
  assert.ok(text.includes("## Questions\n\n### c_whydro · src/a.ts · line 1"));
  assert.ok(
    text.endsWith("Fix the code issues on the original branch, then run `follow-me` again.\n"),
  );
});

test("a review with no comments and no kept concerns says so", () => {
  const { review, commits } = reportFixture();
  const empty: Review = { ...review, comments: [], concerns: [] };
  assert.equal(
    renderReport(empty, commits, fixtureDiff().units, REPORT),
    "# Code review: feature (2 commits, no issues)\n\nThe reviewer raised no issues.\n",
  );
});

test("questions are listed apart from change requests, with their lines and replies", () => {
  const review: Review = JSON.parse(
    JSON.stringify({
      schema: "follow-me/review@1",
      mode: "split",
      planVersion: 2,
      planHash: "abc",
      endedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c_fixthx",
          anchor: { kind: "plan" },
          context: { commitMessage: "", path: null },
          body: "split it up",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_whyyyy",
          kind: "question",
          anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes: [1] },
          context: { commitMessage: "Add parser", path: "src/a.ts", lines: ["+new1"] },
          body: "why?",
          createdAt: "2026-01-01T00:00:00.000Z",
          replies: [
            {
              id: "r_abcdef",
              author: "agent",
              body: "because",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  const text = renderPrompt({ ...first, previousPlan: fixturePlan(), review });
  const questions = text.indexOf("## Questions from the reviewer, on plan v2");
  const changes = text.indexOf("## Open review comments");
  assert.ok(questions > 0 && changes > questions);
  assert.ok(text.slice(questions, changes).includes("- c_whyyyy"));
  assert.ok(text.slice(questions, changes).includes('agent replied: "because"'));
  assert.ok(text.slice(questions, changes).includes("    +new1"));
  assert.ok(!text.slice(changes).includes("c_whyyyy"));
  assert.ok(text.slice(changes).includes("- c_fixthx"));
});
