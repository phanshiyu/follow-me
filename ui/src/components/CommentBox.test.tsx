import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { aState } from "../test/factories.ts";
import { renderReview } from "../test/render.tsx";

const guards = () => page.getByRole("listbox", { name: "Rows of src/lib.js" }).nth(1);

async function pickRowFour() {
  const row = guards()
    .getByRole("option", { name: /^Added 4/ })
    .element();
  if (!(row instanceof HTMLElement)) throw new Error("a row is an element");
  row.focus();
  await userEvent.keyboard(" ");
}

test("a flag reaches the agent when saved, and Submit review only finishes the review", async () => {
  const { server } = await renderReview(aState());
  server.on("POST", "/api/comments", (call) => {
    const body = typeof call.body === "object" && call.body !== null ? call.body : {};
    server.push({
      type: "comment",
      comment: JSON.parse(
        JSON.stringify({ ...body, id: "c_bbbbbb", createdAt: "2026-10-21T10:00:00Z" }),
      ),
    });
    return { id: "c_bbbbbb" };
  });
  server.on("POST", "/api/submit", () => ({}));

  await pickRowFour();
  await userEvent.keyboard("f");
  await userEvent.keyboard("Guard both in one call");
  await page.getByRole("button", { name: "major" }).click();
  await expect.element(page.getByRole("button", { name: "Send flag" })).toBeVisible();
  await page.getByRole("button", { name: "Send flag" }).click();

  const thread = page.getByRole("article", { name: "Thread" });
  await expect.element(thread.getByText("major")).toBeVisible();
  await expect.element(page.getByText("Pending")).not.toBeInTheDocument();
  await expect.element(page.getByText(/pending/)).not.toBeInTheDocument();
  const posted = server.calls.find((c) => c.method === "POST");
  expect(posted?.body).toEqual({
    anchor: expect.objectContaining({ kind: "hunk", commit: 1 }),
    context: expect.objectContaining({ path: "src/lib.js" }),
    body: "Guard both in one call",
    severity: "major",
  });

  await page.getByRole("button", { name: "Submit review" }).click();
  await expect.element(page.getByText(/already reached the agent/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Submit review" }).click();
  await expect.poll(() => location.pathname.endsWith("/report")).toBe(true);
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/api/submit")).toBe(true);
  history.replaceState(null, "", "/");
});

test("a failed save keeps the text and says why; Escape then closes the box", async () => {
  const { server } = await renderReview(aState());
  await pickRowFour();
  await userEvent.keyboard("a");
  await userEvent.keyboard("Why?");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("not found");
  await expect.element(page.getByRole("textbox", { name: "Ask about line 4" })).toHaveValue("Why?");
  expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  await expect
    .element(guards().getByRole("option", { name: /^Added 4/ }))
    .toHaveAttribute("aria-selected", "false");
});

test("when the server goes away the page says so, keeps the draft, and carries on once it answers", async () => {
  const { server } = await renderReview(aState());
  await pickRowFour();
  await userEvent.keyboard("a");
  await userEvent.keyboard("Why check a first?");

  server.setDown(true);
  server.drop();
  await expect.element(page.getByText(/Reconnecting/)).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Ask about line 4" }))
    .toHaveValue("Why check a first?");

  server.setDown(false);
  await expect.element(page.getByText(/Reconnecting/)).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("textbox", { name: "Ask about line 4" }))
    .toHaveValue("Why check a first?");
  expect(page.getByText("This review has ended").elements()).toHaveLength(0);
});
