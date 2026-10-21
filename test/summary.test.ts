import assert from "node:assert/strict";
import { test } from "node:test";
import { endSummary, reportPath } from "../ui/summary.js";

const on = (commit: number, kind?: string) => ({
  anchor: { kind: "message", commit },
  ...(kind ? { kind } : {}),
});
const plan = (kind?: string) => ({ anchor: { kind: "plan" }, ...(kind ? { kind } : {}) });

test("nothing to hand over reads No comments", () => {
  assert.equal(endSummary({ comments: [], kept: 0, unresolved: 0, walk: false }), "No comments");
});

test("change requests keep their old wording", () => {
  const comments = [on(0), on(0), on(2), plan()];
  assert.equal(
    endSummary({ comments, kept: 0, unresolved: 0, walk: false }),
    "3 comments on 2 commits and 1 on the whole plan",
  );
  assert.equal(
    endSummary({ comments: [on(1), plan()], kept: 0, unresolved: 0, walk: true }),
    "1 comment on 1 commit and 1 on the whole branch",
  );
});

test("questions, kept concerns and unresolved answers each get their own count", () => {
  const comments = [on(0), on(1, "question"), plan("question"), on(1, "question")];
  assert.equal(
    endSummary({ comments, kept: 2, unresolved: 1, walk: false }),
    "1 comment on 1 commit, 3 questions for the agent, 2 kept concerns, 1 answer not marked resolved",
  );
  assert.equal(endSummary({ comments: [], kept: 1, unresolved: 0, walk: false }), "1 kept concern");
});

test("the report sits beside the review file", () => {
  assert.equal(reportPath("/r/.follow-me/b/reviews/v2.json"), "/r/.follow-me/b/reviews/v2.md");
});
