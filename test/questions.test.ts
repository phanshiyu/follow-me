import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerCard, AskedComment, Previous, Ref, Response } from "../ui/questions.js";
import {
  answerCards,
  answeredCount,
  askAgain,
  cardsAt,
  holdAt,
  inferKind,
  kindCounts,
  placeAnswer,
  statusLine,
} from "../ui/questions.js";

const ask = (id: string, anchor: AskedComment["anchor"], kind = "question"): AskedComment => ({
  id,
  anchor,
  kind,
  body: "why?",
  context: { commitMessage: "m", path: "a.ts", lines: ["x"] },
});
const lines = (unit: string, changes: number[]): Ref => ({
  unit,
  select: { kind: "lines", changes },
});

test("inferKind reads question marks and opening words, and leaves the rest as changes", () => {
  for (const text of [
    "Why is this here",
    "what about nulls",
    "is it safe?",
    " Should we? ",
    "x?",
    "How",
  ]) {
    assert.equal(inferKind(text), "question", text);
  }
  for (const text of ["Rename this", "Whyever not", "this is wrong", "", "Can't tell", "Hows it"]) {
    assert.equal(inferKind(text), "change", text);
  }
});

test("placeAnswer prefers the agent's own at, converting the 1-based commit", () => {
  const commits = [{ refs: [] }, { refs: [] }, { refs: [] }];
  const response: Response = {
    comment: "c",
    status: "answered",
    note: "n",
    at: { commit: 3, unit: "h_1" },
  };
  assert.deepEqual(placeAnswer(ask("c", { kind: "plan" }), response, commits), {
    commit: 2,
    unit: "h_1",
    continues: [],
  });
  const off: Response = { ...response, at: { commit: 9 } };
  assert.equal(placeAnswer(ask("c", { kind: "plan" }), off, commits), null);
});

test("placeAnswer follows the asked lines to the commits that now hold them", () => {
  const commits = [
    { refs: [lines("h_1", [4, 5])] },
    { refs: [lines("h_1", [0, 1])] },
    { refs: [lines("h_1", [1, 2]), { unit: "h_2", select: { kind: "rest" } } satisfies Ref] },
  ];
  const anchor: AskedComment["anchor"] = { kind: "hunk", unit: "h_1", commit: 0, changes: [1, 4] };
  assert.deepEqual(placeAnswer(ask("c", anchor), null, commits), {
    commit: 0,
    unit: "h_1",
    continues: [1, 2],
  });
  const whole: AskedComment["anchor"] = { kind: "hunk", unit: "h_1", commit: 0, changes: null };
  assert.equal(placeAnswer(ask("c", whole), null, commits)?.commit, 0);
  const gone: AskedComment["anchor"] = { kind: "hunk", unit: "h_9", commit: 0, changes: [1] };
  assert.equal(placeAnswer(ask("c", gone), null, commits), null);
  assert.equal(placeAnswer(ask("c", { kind: "message", commit: 0 }), null, commits), null);
  assert.equal(
    placeAnswer(ask("c", { kind: "hunk", unit: "h_1", commit: 0, changes: [7] }), null, commits),
    null,
    "lines no commit takes any more",
  );
});

const previous: Previous = {
  version: 1,
  comments: [
    ask("c_q1", { kind: "hunk", unit: "h_1", commit: 0, changes: [0] }),
    ask("c_ch", { kind: "plan" }, "change"),
    { ...ask("c_q2", { kind: "message", commit: 1 }) },
    ask("c_q3", { kind: "plan" }),
  ],
  responses: [
    { comment: "c_q1", status: "answered", note: "because", at: { commit: 1, unit: "h_1" } },
    { comment: "c_ch", status: "answered", note: "wrongly answered a change" },
    { comment: "c_q2", status: "addressed", note: "moved it" },
  ],
};
const commits = [{ refs: [lines("h_1", [0])] }, { refs: [] }];

test("answerCards lists the previous questions only, with status and place", () => {
  const cards = answerCards(previous, ["c_q2"], commits);
  assert.deepEqual(
    cards.map((c) => [c.id, c.status, c.resolved, c.place?.commit ?? null]),
    [
      ["c_q1", "answered", false, 0],
      ["c_q2", "addressed", true, null],
      ["c_q3", "unanswered", false, null],
    ],
  );
  assert.deepEqual(answerCards(null, [], commits), []);
});

test("answeredCount counts answered questions only", () => {
  assert.equal(answeredCount(previous), 1);
  assert.equal(answeredCount(null), 0);
});

test("statusLine names what each card waits on", () => {
  const [a, b, c] = answerCards(previous, [], commits);
  assert.ok(a && b && c);
  assert.deepEqual([a, b, c].map(statusLine), [
    "Answered",
    "Answered by changing the plan",
    "Not answered",
  ]);
  assert.equal(statusLine({ ...a, resolved: true }), "Resolved");
});

test("cardsAt puts unit answers above the unit and falls back to the message", () => {
  const cards = answerCards(previous, [], commits);
  assert.deepEqual(
    cardsAt(cards, 0, "h_1", ["h_1"]).map((c) => c.id),
    ["c_q1"],
  );
  assert.deepEqual(cardsAt(cards, 0, null, ["h_1"]), []);
  assert.deepEqual(
    cardsAt(cards, 0, null, []).map((c) => c.id),
    ["c_q1"],
  );
  assert.deepEqual(cardsAt(cards, 1, "h_1", ["h_1"]), []);
});

test("askAgain keeps the place, ties the new question to the old and defaults to the plan", () => {
  const [a, b, c] = answerCards(previous, [], commits) as [AnswerCard, AnswerCard, AnswerCard];
  assert.deepEqual(askAgain(a, "still unclear"), {
    anchor: { kind: "hunk", unit: "h_1", commit: 0, changes: [0] },
    context: a.comment.context,
    body: "still unclear",
    kind: "question",
    follows: "c_q1",
  });
  assert.deepEqual(askAgain(b, "x").anchor, { kind: "message", commit: 0 });
  assert.deepEqual(askAgain(c, "x").anchor, { kind: "plan" });
});

test("holdAt stops once, after the narration of the beat the answer sits on", () => {
  const beats = [
    { kind: "intro", commit: 0 },
    { kind: "chunk", commit: 0, unit: "h_1" },
    { kind: "outro", commit: 0 },
  ];
  const steps = [
    { kind: "say", beat: 0 },
    { kind: "say", beat: 1 },
    { kind: "show", beat: 1 },
    { kind: "rest", beat: 1 },
    { kind: "hold", beat: 2 },
  ];
  const [card] = answerCards(previous, [], commits);
  assert.ok(card);
  const at = (p: number, seen: string[] = [], cards = [card]) =>
    holdAt(beats, steps, p, cards, new Set(seen)).map((c) => c.id);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((p) => at(p)),
    [[], [], ["c_q1"], [], []],
  );
  assert.deepEqual(at(2, ["c_q1"]), []);
  assert.deepEqual(at(2, [], [{ ...card, resolved: true }]), []);
  const onCommit: AnswerCard = { ...card, place: { commit: 0, unit: null, continues: [] } };
  assert.deepEqual(
    [0, 1, 2].map((p) => at(p, [], [onCommit])),
    [[], ["c_q1"], []],
  );
});

test("kindCounts splits a commit's comments into questions and change requests", () => {
  const comments = [
    { anchor: { kind: "message", commit: 0 }, kind: "question" },
    { anchor: { kind: "message", commit: 0 } },
    { anchor: { kind: "position", commit: 0 } },
    { anchor: { kind: "plan" }, kind: "question" },
    { anchor: { kind: "message", commit: 1 } },
  ] as const;
  assert.deepEqual(kindCounts(comments, 0), { questions: 1, changes: 2 });
});
