import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { aState } from "../test/factories.ts";
import { renderReview } from "../test/render.tsx";

const concern = {
  id: "k_00000001",
  unit: "h_7da8387be1bf",
  severity: "major",
  kind: "missing-test",
  text: "No test covers add('1', 2).",
  lines: [2],
};

function withConcern() {
  const state = aState();
  return aState({
    commits: state.commits.map((c) =>
      c.index === 1 ? JSON.parse(JSON.stringify({ ...c, concerns: [concern] })) : c,
    ),
  });
}

test("a concern sits under its line; Keep with a new severity records both, Dismiss folds it", async () => {
  const { server } = await renderReview(withConcern());
  server.on("POST", /^\/api\/concerns\//, (call) => {
    const body = JSON.parse(JSON.stringify(call.body));
    server.push({ type: "concern", concernId: JSON.parse('"k_00000001"'), ...body });
    return {};
  });
  const card = page.getByRole("article", { name: "Agent concern" });
  await expect.element(card.getByText("No test covers add('1', 2).")).toBeVisible();

  await card.getByRole("button", { name: "Severity major" }).click();
  await page.getByRole("menuitem", { name: "blocker" }).click();
  await card.getByRole("button", { name: "Keep", exact: true }).click();
  await expect.element(card.getByText("Kept · in your review")).toBeVisible();
  expect(server.calls.at(-1)?.body).toEqual({ decision: "kept", severity: "blocker" });

  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect.element(page.getByRole("article", { name: "Dismissed concern" })).toBeVisible();
});
