import { expect, test } from "vitest";
import { aComment, aReply, aState } from "../test/factories.ts";
import { badgesOf, waitingOnReviewer } from "./stack.ts";
import type { PlacedConcern } from "./wire.ts";

test("a thread waits on the reviewer once the agent has the last word", () => {
  expect(waitingOnReviewer(aComment())).toBe(false);
  expect(waitingOnReviewer(aComment({ replies: [aReply()] }))).toBe(true);
  expect(waitingOnReviewer(aComment({ replies: [aReply(), aReply({ author: "reviewer" })] }))).toBe(
    false,
  );
  expect(waitingOnReviewer(aComment({ author: "agent" }))).toBe(true);
});

test("badges count open and waiting threads and undecided concerns of one commit", () => {
  const concern: PlacedConcern = JSON.parse(
    '{"id":"k_00000001","severity":"major","kind":"bug","text":"x"}',
  );
  const [, commit] = aState().commits;
  if (commit === undefined) throw new Error("the state has two commits");
  const comments = [
    aComment({ id: JSON.parse('"c_aaaaaa"'), replies: [aReply()] }),
    aComment({ id: JSON.parse('"c_bbbbbb"'), kind: undefined }),
    aComment({ id: JSON.parse('"c_cccccc"') }),
    aComment({ id: JSON.parse('"c_dddddd"'), anchor: { kind: "plan" } }),
  ];
  expect(badgesOf({ ...commit, concerns: [concern] }, comments, [], new Set(["c_cccccc"]))).toEqual(
    {
      open: 2,
      waiting: 1,
      undecided: 1,
    },
  );
});
