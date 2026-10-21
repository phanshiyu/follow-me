import { expect, test } from "vitest";
import { aComment, aState } from "../test/factories.ts";
import { answerCards, answeredCount, askAgain, cardsAt, placeAnswer } from "./answers.ts";
import type { CommentResponse, PreviousVersion } from "./wire.ts";

function previous(responses: unknown[]): PreviousVersion {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      comments: [aComment(), aComment({ id: JSON.parse('"c_bbbbbb"'), kind: undefined })],
      responses,
    }),
  );
}

test("an answer sits where the agent said, else on the first commit that holds the lines", () => {
  const { commits } = aState();
  const at: CommentResponse = JSON.parse(
    '{"comment":"c_aaaaaa","status":"answered","note":"n","at":{"commit":1}}',
  );
  expect(placeAnswer(aComment(), at, commits)).toEqual({ commit: 0, unit: null, continues: [] });
  expect(placeAnswer(aComment(), null, commits)).toEqual({
    commit: 1,
    unit: "h_7da8387be1bf",
    continues: [],
  });
  expect(placeAnswer(aComment({ anchor: { kind: "plan" } }), null, commits)).toBeNull();
});

test("cards are only questions, carry their resolve state, and land on their unit or message", () => {
  const { commits } = aState();
  const cards = answerCards(
    previous([{ comment: "c_aaaaaa", status: "answered", note: "Because." }]),
    JSON.parse('["c_aaaaaa"]'),
    commits,
  );
  expect(cards.map((c) => [c.id, c.resolved, c.response?.note])).toEqual([
    ["c_aaaaaa", true, "Because."],
  ]);
  expect(
    cardsAt(cards, 1, JSON.parse('"h_7da8387be1bf"'), JSON.parse('["h_7da8387be1bf"]')),
  ).toHaveLength(1);
  expect(cardsAt(cards, 1, null, [])).toHaveLength(1);
  expect(answeredCount(previous([{ comment: "c_aaaaaa", status: "answered", note: "x" }]))).toEqual(
    {
      answered: 1,
      asked: 1,
    },
  );
});

test("ask again keeps the place and points back at the question", () => {
  const [card] = answerCards(previous([]), [], aState().commits);
  if (card === undefined) throw new Error("one question");
  expect(askAgain(card, "Still unclear")).toMatchObject({
    anchor: { kind: "hunk", unit: "h_7da8387be1bf", commit: 1, changes: [2] },
    body: "Still unclear",
    kind: "question",
    follows: "c_aaaaaa",
  });
});
