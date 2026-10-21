import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PromptInput,
  type ReportCommit,
  renderEvents,
  renderPrompt,
  renderReport,
  reportItems,
} from "./prompt.ts";
import type { Comment, Diff, Review, ServerEvent } from "./types.ts";

// The hunk reads: -old1 +new1 " same" -old2 +new2. In the base old1 is line 1, same is line 2, old2
// is line 3; in the tip new1 is line 1, same is line 2, new2 is line 3.
function diff(): Diff {
  const unit = {
    kind: "hunk",
    id: "h_aaaaaaaaaaaa",
    path: "src/lib.js",
    oldStart: 0,
    changeCount: 4,
    body: [
      { op: "-", text: "old1\n", change: 0 },
      { op: "+", text: "new1\n", change: 1 },
      { op: " ", text: "same\n" },
      { op: "-", text: "old2\n", change: 2 },
      { op: "+", text: "new2\n", change: 3 },
    ],
  };
  const parsed = JSON.parse(
    JSON.stringify({
      base: "1".repeat(40),
      tip: "2".repeat(40),
      baseTree: "3".repeat(40),
      tipTree: "4".repeat(40),
    }),
  );
  return { ...parsed, units: new Map([[unit.id, unit]]), textFiles: new Map() };
}

function commits(): ReportCommit[] {
  return JSON.parse(
    JSON.stringify([
      {
        message: "Guard",
        refs: [{ unit: "h_aaaaaaaaaaaa", select: { kind: "lines", changes: [0, 1, 2, 3] } }],
      },
    ]),
  );
}

function comment(offsets: number[], changes: number[], body: string): Comment {
  return JSON.parse(
    JSON.stringify({
      id: "c_abcdef",
      anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes, offsets },
      context: { commitMessage: "Guard", path: "src/lib.js" },
      body,
      kind: "question",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

function event(c: Comment): ServerEvent {
  return { seq: 1, type: "comment", comment: c };
}

test("watch quotes a context-line comment with its file lines and the picked rows marked", () => {
  const text = renderEvents([event(comment([1, 2], [1], "why is same left alone?"))], {
    commits: commits(),
    units: diff().units,
  });
  assert.ok(
    text.includes(
      [
        "- c_abcdef question on src/lib.js:1-2 in commit 1 (h_aaaaaaaaaaaa rows 1-2; 1 context line, 1 added)",
        "      -old1",
        "    > +new1",
        "    >  same",
        "      -old2",
        "      +new2",
        "  why is same left alone?",
      ].join("\n"),
    ),
    text,
  );
});

test("a picked removal numbers the range on the base side and says so", () => {
  const text = renderEvents([event(comment([0, 2], [0], "why drop old1?"))], {
    commits: commits(),
    units: diff().units,
  });
  assert.ok(
    text.includes(
      "on src/lib.js:1-2 (base side) in commit 1 (h_aaaaaaaaaaaa rows 0,2; 1 context line, 1 removed)",
    ),
  );
});

test("without a projected plan the rows are quoted as git shows them", () => {
  const text = renderEvents([event(comment([2], [], "what is same for?"))], {
    commits: [],
    units: diff().units,
  });
  assert.ok(text.includes("on src/lib.js:2 in commit 1 (h_aaaaaaaaaaaa rows 2; 1 context line)"));
  assert.ok(text.includes("    >  same"));
});

test("a new comment is quoted in at most six rows of 160 characters, and the rest is one line", () => {
  const long = "x".repeat(200);
  const body = Array.from({ length: 12 }, (_, i) =>
    i === 4 ? { op: "+", text: `${long}\n`, change: 0 } : { op: " ", text: `c${i}\n` },
  );
  const hunk = JSON.parse(
    JSON.stringify({
      kind: "hunk",
      id: "h_aaaaaaaaaaaa",
      path: "src/lib.js",
      oldStart: 0,
      changeCount: 1,
      body,
    }),
  );
  const text = renderEvents(
    [
      event(comment([6], [], "why?")),
      { seq: 2, type: "comment-updated", comment: comment([6], [], "why, really?") },
      {
        seq: 3,
        type: "reply",
        commentId: JSON.parse('"c_abcdef"'),
        reply: { id: JSON.parse('"r_abcdef"'), author: "reviewer", body: "ok", createdAt: "t" },
      },
      { seq: 4, type: "resolved", commentId: JSON.parse('"c_abcdef"'), resolved: true },
    ],
    { commits: [], units: new Map([[hunk.id, hunk]]) },
  );
  assert.equal(
    text,
    [
      "- c_abcdef question on src/lib.js:7 in commit 1 (h_aaaaaaaaaaaa rows 6; 1 context line)",
      `      +${"x".repeat(156)}…`,
      "       c5",
      "    >  c6",
      "       c7",
      "       c8",
      "       c9",
      "  why?",
      "- c_abcdef edited: why, really?",
      "- c_abcdef reviewer replied: ok",
      "- c_abcdef resolved",
      "",
    ].join("\n"),
  );
});

test("the prompt and the report quote the same rows and leave the context-line rule to the skill", () => {
  const c = comment([2], [], "what is same for?");
  const input: PromptInput = {
    mode: "split",
    diff: diff(),
    previousPlan: null,
    review: {
      schema: "follow-me/review@1",
      mode: "split",
      planVersion: JSON.parse("1"),
      planHash: "x",
      endedAt: "2026-01-01T00:00:00.000Z",
      comments: [c],
    },
    previousCommits: commits(),
    draftPath: "/d/draft.json",
    checkCommand: "follow-me check",
  };
  const prompt = renderPrompt(input);
  const quoted = ["      -old1", "      +new1", "    >  same", "      -old2", "      +new2"];
  assert.ok(
    prompt.includes(
      [
        "- c_abcdef  on src/lib.js:2 in commit 1 (h_aaaaaaaaaaaa rows 2; 1 context line)",
        '  commit message then: "Guard"',
        "  path: src/lib.js",
        "  rows asked about, picked ones marked >:",
        ...quoted,
      ].join("\n"),
    ),
    prompt,
  );
  assert.ok(!prompt.includes("do not move lines because of it"));

  const report = renderReport(input.review ?? assert.fail(), commits(), diff().units, {
    branch: "feature",
    responses: [],
  });
  assert.ok(
    report.includes(
      ["```diff", "  -old1", "  +new1", ">  same", "  -old2", "  +new2", "```"].join("\n"),
    ),
    report,
  );
  assert.ok(report.includes("### c_abcdef · src/lib.js · line 2"));
  // The rule for a context-row comment lives in the skill, which the agent loaded once.
  assert.ok(!report.includes("do not move lines because of it"));
});

test("a thread the agent started reaches the report only once the reviewer answers", () => {
  const open: Comment = {
    ...comment([2], [], "same is the shared parser state."),
    author: "agent",
  };
  const answered: Comment = {
    ...open,
    replies: [
      {
        id: JSON.parse('"r_abcdef"'),
        author: "reviewer",
        body: "Then why mutate it?",
        createdAt: "t",
      },
    ],
  };
  const review = (c: Comment): Review => ({
    schema: "follow-me/review@1",
    mode: "split",
    planVersion: JSON.parse("1"),
    planHash: "x",
    endedAt: "2026-01-01T00:00:00.000Z",
    comments: [c],
  });
  const opts = { branch: "feature", responses: [] };
  const silent = renderReport(review(open), commits(), diff().units, opts);
  assert.equal(silent, "# Review of plan v1\n\nNo comments.\n");
  const text = renderReport(review(answered), commits(), diff().units, opts);
  assert.ok(
    text.includes(
      "## Threads you started\n\n### c_abcdef · src/lib.js · line 2\n\n```diff\n  -old1",
    ),
    text,
  );
  assert.ok(
    text.includes("Agent: same is the shared parser state.\nReviewer replied: Then why mutate it?"),
  );
});

function reviewOf(comments: Comment[], excluded?: Review["excluded"]): Review {
  return {
    schema: "follow-me/review@1",
    mode: "walk",
    planVersion: JSON.parse("1"),
    planHash: "x",
    endedAt: "2026-01-01T00:00:00.000Z",
    comments,
    ...(excluded === undefined ? {} : { excluded }),
  };
}

function flagAt(offsets: number[], changes: number[], body: string, id: string): Comment {
  return JSON.parse(
    JSON.stringify({
      id,
      anchor: { kind: "hunk", unit: "h_aaaaaaaaaaaa", commit: 0, changes, offsets },
      context: { commitMessage: "Guard", path: "src/lib.js" },
      body,
      severity: "major",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

test("report items give a flag on an added line and a context-line question their branch lines", () => {
  const flag = flagAt([4], [3], "Check for null.", "c_flagaa");
  const question: Comment = {
    ...comment([2], [], "Why keep this?"),
    id: JSON.parse('"c_questa"'),
    replies: [
      { id: JSON.parse('"r_abcdef"'), author: "agent", body: "Shared state.", createdAt: "t" },
    ],
  };
  const opts = { branch: "feature", responses: [] };
  const items = reportItems(reviewOf([question, flag]), commits(), diff().units, opts);
  assert.deepEqual(items, [
    {
      path: "src/lib.js",
      oldPath: "src/lib.js",
      newLine: 2,
      oldLine: 2,
      startNewLine: null,
      startOldLine: null,
      severity: null,
      kind: "question",
      body: "Why keep this?\n\n<details><summary>Answer</summary>\n\nShared state.\n\n</details>",
      thread: [{ author: "agent", body: "Shared state." }],
      resolved: false,
      excluded: false,
    },
    {
      path: "src/lib.js",
      oldPath: "src/lib.js",
      newLine: 3,
      oldLine: null,
      startNewLine: null,
      startOldLine: null,
      severity: "major",
      kind: "flag",
      body: "**major**\n\nCheck for null.",
      thread: [],
      resolved: false,
      excluded: false,
    },
  ]);
});

test("an excluded item leaves the main list and shows under Excluded", () => {
  const flag = flagAt([4], [3], "Check for null.", "c_flagaa");
  const opts = { branch: "feature", responses: [] };
  const kept = renderReport(reviewOf([flag]), commits(), diff().units, opts);
  assert.ok(kept.includes("Reviewer: Check for null."));
  const left = renderReport(
    reviewOf([flag], { comments: [flag.id], concerns: [] }),
    commits(),
    diff().units,
    opts,
  );
  assert.ok(!left.includes("Reviewer: Check for null."), left);
  assert.ok(left.includes("## Excluded"), left);
  assert.ok(left.includes("src/lib.js · line 3 · flag · major: Check for null."), left);
});
