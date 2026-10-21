import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveState } from "../ui/live.js";
import {
  applyEvent,
  backoffMs,
  bannerText,
  decisionsById,
  keepCommit,
  nextSince,
} from "../ui/live.js";

const base = (): LiveState => ({
  version: 5,
  comments: [{ id: "c_aaaaaa", body: "first" }],
});

test("a comment event adds a comment, and replaying it changes nothing", () => {
  const event = { type: "comment", seq: 1, comment: { id: "c_bbbbbb", body: "second" } };
  const once = applyEvent(base(), event);
  assert.deepEqual(
    once.state.comments.map((c) => c.id),
    ["c_aaaaaa", "c_bbbbbb"],
  );
  assert.equal(once.effect, null);
  assert.deepEqual(applyEvent(once.state, event).state, once.state);
});

test("events may carry their fields under data", () => {
  const { state } = applyEvent(base(), {
    type: "comment",
    data: { comment: { id: "c_bbbbbb", body: "x" } },
  });
  assert.equal(state.comments.length, 2);
});

test("an updated comment replaces the old one in place and keeps its replies", () => {
  const start = applyEvent(base(), {
    type: "reply",
    commentId: "c_aaaaaa",
    reply: { id: "r_1", author: "agent", body: "because", createdAt: "t" },
  }).state;
  const { state } = applyEvent(start, {
    type: "comment-updated",
    comment: { id: "c_aaaaaa", body: "edited" },
  });
  assert.equal(state.comments[0]?.body, "edited");
  assert.equal(state.comments[0]?.replies?.length, 1);
});

test("a deleted comment disappears", () => {
  const { state } = applyEvent(base(), { type: "comment-deleted", id: "c_aaaaaa" });
  assert.deepEqual(state.comments, []);
});

test("a reply lands on its comment once, and a reply to an unknown comment is dropped", () => {
  const reply = { id: "r_1", author: "reviewer", body: "why?", createdAt: "t" };
  const event = { type: "reply", commentId: "c_aaaaaa", reply };
  const twice = applyEvent(applyEvent(base(), event).state, event).state;
  assert.deepEqual(twice.comments[0]?.replies, [reply]);
  const lost = applyEvent(base(), { ...event, commentId: "c_zzzzzz" }).state;
  assert.equal(lost.comments[0]?.replies, undefined);
});

test("a concern event records the decision by concern id, with severity and note", () => {
  const event = {
    type: "concern",
    concernId: "k_1",
    decision: "kept",
    severity: "major",
    note: "n",
  };
  const { state } = applyEvent(base(), event);
  assert.deepEqual(state.decisions, {
    k_1: { concern: "k_1", decision: "kept", severity: "major", note: "n" },
  });
  const flipped = applyEvent(state, { type: "concern", concernId: "k_1", decision: "dismissed" });
  assert.deepEqual(flipped.state.decisions, { k_1: { concern: "k_1", decision: "dismissed" } });
});

test("a resolved event marks and unmarks a previous question", () => {
  const on = applyEvent(base(), { type: "resolved", commentId: "c_old", resolved: true }).state;
  assert.deepEqual(on.resolved, ["c_old"]);
  const again = applyEvent(on, { type: "resolved", commentId: "c_old", resolved: true }).state;
  assert.deepEqual(again.resolved, ["c_old"]);
  const off = applyEvent(on, { type: "resolved", commentId: "c_old", resolved: false }).state;
  assert.deepEqual(off.resolved, []);
});

test("decisionsById keys the stored list", () => {
  assert.deepEqual(decisionsById([{ concern: "k_1", decision: "kept" }]), {
    k_1: { concern: "k_1", decision: "kept" },
  });
});

test("only a newer version asks for a refetch", () => {
  assert.equal(applyEvent(base(), { type: "version", version: 6, hash: "h" }).effect, "refetch");
  assert.equal(applyEvent(base(), { type: "version", version: 5, hash: "h" }).effect, null);
  assert.equal(applyEvent(base(), { type: "version", version: 4, hash: "h" }).effect, null);
});

test("ended, unknown types and malformed payloads", () => {
  assert.equal(applyEvent(base(), { type: "ended" }).effect, "ended");
  const same = base();
  assert.equal(applyEvent(same, { type: "mystery" }).state, same);
  assert.equal(applyEvent(same, { type: "comment", comment: 7 }).state, same);
  assert.equal(applyEvent(same, { type: "reply", commentId: "c_aaaaaa", reply: "x" }).state, same);
  assert.equal(applyEvent(same, { type: "concern", concernId: 3 }).state, same);
  assert.equal(applyEvent(same, { type: "concern", concernId: "k_1", decision: "x" }).state, same);
});

test("nextSince never goes backwards", () => {
  assert.equal(nextSince(0, { seq: 4, events: [] }), 4);
  assert.equal(nextSince(9, { seq: 4, events: [] }), 9);
  assert.equal(nextSince(2, { events: [{ type: "x", seq: 7 }] }), 7);
});

test("backoff doubles from half a second and stops at fifteen", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs),
    [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
});

test("keepCommit follows the title, nearest when titles repeat, else the first commit", () => {
  const commits = [{ message: "a" }, { message: "b\nbody" }, { message: "a" }];
  assert.equal(keepCommit("b", 0, commits), 1);
  assert.equal(keepCommit("a", 2, commits), 2);
  assert.equal(keepCommit("a", 0, commits), 0);
  assert.equal(keepCommit("gone", 1, commits), 0);
  assert.equal(keepCommit(null, 1, commits), 0);
});

test("the banner names the version and counts answers", () => {
  assert.equal(bannerText(6, 3), "Plan v6 arrived, 3 questions answered");
  assert.equal(bannerText(6, 1), "Plan v6 arrived, 1 question answered");
  assert.equal(bannerText(6, 0), "Plan v6 arrived");
});
