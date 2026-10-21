import { expect, test } from "vitest";
import { aComment, aReportItem, aState } from "../test/factories.ts";
import { isIncluded, locationOf, markdownOf, sourceOf, splitAnswer } from "./report.ts";

test("a location names the original branch's lines and the side they are on", () => {
  expect(locationOf(aReportItem())).toBe("src/lib.js:4-5 (new)");
  expect(
    locationOf(aReportItem({ newLine: null, startNewLine: null, oldLine: 12, startOldLine: null })),
  ).toBe("src/lib.js:12 (old)");
  expect(locationOf(aReportItem({ newLine: 7, startNewLine: 7, oldLine: 6 }))).toBe(
    "src/lib.js:7 (new)",
  );
  expect(locationOf(aReportItem({ path: null }))).toBeNull();
});

test("the reviewer's toggle overrides what the server says", () => {
  const item = aReportItem({ excluded: true });
  expect(isIncluded(item, new Map(), "c_aaaaaa")).toBe(false);
  expect(isIncluded(item, new Map([["c_aaaaaa", true]]), "c_aaaaaa")).toBe(true);
  expect(isIncluded(aReportItem(), new Map([["c_aaaaaa", false]]), null)).toBe(true);
});

test("an item finds its comment by id, else by its words", () => {
  const flag = aComment({ kind: undefined, body: "Guard both arguments in one call." });
  const state = aState({ comments: [flag] });
  expect(sourceOf(aReportItem(), state)?.id).toBe("c_aaaaaa");
  expect(sourceOf(aReportItem({ id: "c_zzzzzz" }), state)).toEqual({
    id: "c_zzzzzz",
    comment: null,
  });
  const question = aComment({ id: JSON.parse('"c_qqqqqq"') });
  const asked = aReportItem({
    kind: "question",
    severity: null,
    body: "Why check a before b?\n\n<details><summary>Answer</summary>\n\nBecause.\n\n</details>",
  });
  expect(sourceOf(asked, aState({ comments: [flag, question] }))?.id).toBe("c_qqqqqq");
  expect(splitAnswer(asked.body)).toEqual({ said: "Why check a before b?", answer: "Because." });
});

test("copy all puts each body under its location", () => {
  expect(markdownOf([aReportItem(), aReportItem({ path: null, body: "Overall fine." })])).toBe(
    "**src/lib.js:4-5 (new)**\n\n**major**\n\nGuard both arguments in one call.\n\n---\n\n**General**\n\nOverall fine.\n",
  );
});
