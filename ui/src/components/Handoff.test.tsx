import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { aComment, aReportItem, aState } from "../test/factories.ts";
import { renderHandoff } from "../test/render.tsx";

const flag = aComment({ kind: undefined, body: "Guard both arguments in one call." });
const question = aComment({ id: JSON.parse('"c_qqqqqq"'), body: "Why check a before b?" });
const items = [
  aReportItem(),
  aReportItem({
    kind: "question",
    severity: null,
    newLine: 4,
    startNewLine: null,
    body: "Why check a before b?\n\n<details><summary>Answer</summary>\n\nBecause **a** is read first.\n\n</details>",
    excluded: true,
  }),
];

test("flags go by default, a question can be included, and a failed toggle springs back", async () => {
  const { server } = await renderHandoff(aState({ comments: [flag, question] }), items);
  await expect.element(page.getByText("1 included · 1 excluded")).toBeVisible();
  const asked = page.getByRole("article", { name: "Question src/lib.js:4 (new)" });
  await expect.element(asked.getByText("still open")).toBeVisible();
  await expect.element(asked.getByText("Agent")).toBeVisible();
  await expect.element(asked.getByText("  assertNumber(a);")).toBeVisible();

  server.on("POST", "/api/excluded", () => ({}));
  await asked.getByRole("checkbox", { name: "Include src/lib.js:4 (new)" }).click();
  await expect.element(page.getByText("2 included · 0 excluded")).toBeVisible();
  expect(server.calls.at(-1)).toEqual({
    method: "POST",
    path: "/api/excluded",
    body: { comment: "c_qqqqqq", excluded: false },
  });

  server.on("POST", "/api/excluded", () => {
    throw new Error("disk full");
  });
  const flagged = page.getByRole("article", { name: "Flag src/lib.js:4-5 (new)" });
  await flagged.getByRole("checkbox").click();
  await expect.element(page.getByText("2 included · 0 excluded")).toBeVisible();
  await expect.element(flagged.getByRole("checkbox")).toBeChecked();
});
