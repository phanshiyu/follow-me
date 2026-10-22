import { describe, expect, test } from "vitest";
import { aComment, aReply, aState } from "../test/factories.ts";
import { applyEvent } from "./live.ts";
import type { ServerEvent } from "./wire.ts";

function event(raw: unknown): ServerEvent {
  return JSON.parse(JSON.stringify(raw));
}

describe("applyEvent", () => {
  test("a comment is added once, however often its event replays", () => {
    const comment = event({ seq: 1, type: "comment", comment: aComment() });
    const once = applyEvent(aState(), comment);
    const twice = applyEvent(once, comment);
    expect(twice.comments).toHaveLength(1);
    expect(twice.seq).toBe(1);
  });

  test("an update without replies keeps the thread the page holds", () => {
    const start = aState({ comments: [aComment({ replies: [aReply()] })] });
    const next = applyEvent(
      start,
      event({ seq: 2, type: "comment-updated", comment: aComment({ body: "edited" }) }),
    );
    expect(next.comments[0]?.body).toBe("edited");
    expect(next.comments[0]?.replies).toHaveLength(1);
  });

  test("a reply lands on its comment and a replayed reply is not doubled", () => {
    const start = aState({ comments: [aComment()] });
    const reply = event({ seq: 3, type: "reply", commentId: "c_aaaaaa", reply: aReply() });
    const next = applyEvent(applyEvent(start, reply), reply);
    expect(next.comments[0]?.replies?.map((r) => r.body)).toEqual(["Because **a** is read first."]);
  });

  test("a deletion, a concern decision and a resolve each change only their part", () => {
    let state = aState({ comments: [aComment()] });
    state = applyEvent(state, event({ seq: 4, type: "comment-deleted", id: "c_aaaaaa" }));
    state = applyEvent(
      state,
      event({
        seq: 5,
        type: "concern",
        concernId: "k_00000000",
        decision: "kept",
        severity: "minor",
      }),
    );
    state = applyEvent(
      state,
      event({ seq: 6, type: "concern", concernId: "k_00000000", decision: "dismissed" }),
    );
    state = applyEvent(
      state,
      event({ seq: 7, type: "resolved", commentId: "c_bbbbbb", resolved: true }),
    );
    expect(state.comments).toEqual([]);
    expect(state.concerns).toEqual([{ concern: "k_00000000", decision: "dismissed" }]);
    expect(state.resolved).toEqual(["c_bbbbbb"]);
    expect(state.seq).toBe(7);
  });
  test("a dismissed offer is kept once, however often its event replays", () => {
    const dismissed = event({ seq: 1, type: "offer-dismissed", offer: "o_1a2b3c4d" });
    const once = applyEvent(aState(), dismissed);
    expect(applyEvent(once, dismissed).dismissedOffers).toEqual(["o_1a2b3c4d"]);
  });
});
