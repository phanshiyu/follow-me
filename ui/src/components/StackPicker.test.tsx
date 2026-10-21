import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { aCommit, aState } from "../test/factories.ts";
import { renderReview } from "../test/render.tsx";

const longTitle = "Teach the parser to keep comments attached to the node they describe";

function eightCommits() {
  const base = aState();
  const [first, second] = base.commits;
  if (first === undefined || second === undefined) throw new Error("two commits");
  return aState({
    commits: [
      first,
      second,
      ...Array.from({ length: 6 }, (_, i) =>
        aCommit(i + 2, { message: i === 3 ? longTitle : `Step ${i + 3}` }),
      ),
    ],
  });
}

test("the stack lists every commit with its full title and jumps to the one picked", async () => {
  await renderReview(eightCommits());
  const picker = page.getByRole("button", { name: "Commit 1 of 8 · Add the number guard import" });
  await expect.element(picker).toBeVisible();

  await picker.click();
  const items = page.getByRole("menuitem");
  await expect.poll(() => items.all().length).toBe(8);
  await expect.element(page.getByRole("menuitem", { name: new RegExp(longTitle) })).toBeVisible();

  await page.getByRole("menuitem", { name: /Step 8/ }).click();
  await expect.element(page.getByRole("button", { name: /Commit 8 of 8 · Step 8/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Next commit" })).toBeDisabled();
});

test("s opens the stack, and a viewed commit shows its tick there", async () => {
  await renderReview(eightCommits());
  await page.getByRole("checkbox", { name: "Viewed commit 2" }).click();
  await expect.element(page.getByRole("heading", { name: "Guard add" })).toBeVisible();
  await expect.element(page.getByText("src/lib.js").nth(1)).not.toBeInTheDocument();
  await userEvent.keyboard("s");
  await expect
    .element(page.getByRole("menuitem", { name: /Guard add/ }).getByLabelText("Viewed"))
    .toBeVisible();
});
