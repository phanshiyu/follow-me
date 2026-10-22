import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Section } from "../lib/wire.ts";
import { aComment, aLongState, aReply } from "../test/factories.ts";
import { goToCommit, index, indexEntry } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const concern = {
  id: "k_00000001",
  unit: "h_7da8387be1bf",
  severity: "major",
  kind: "bug",
  text: "b is never checked when a throws.",
  lines: [3],
};

const SECTIONS: readonly Section[] = [
  "story",
  "steps",
  "steps",
  "steps",
  "details",
  "details",
  "wiring",
  "wiring",
];

/** Eight commits in four sections; commit 2 has an open question and an undecided concern. */
function sectioned() {
  const base = aLongState({ comments: [aComment()] });
  return aLongState({
    comments: [aComment()],
    commits: base.commits.map((c) =>
      JSON.parse(
        JSON.stringify({
          ...c,
          section: SECTIONS[c.index],
          ...(c.index === 1 ? { concerns: [concern] } : {}),
        }),
      ),
    ),
  });
}

afterEach(async () => {
  await page.viewport(1280, 900);
});

test("the open index lists commits under their sections, marks them, and follows the scroll", async () => {
  await renderReview(sectioned());
  for (const heading of ["The story", "The steps", "The details", "Wiring"]) {
    await expect.element(index().getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect.element(page.getByRole("button", { name: /Commit 1 of 8/ })).not.toBeInTheDocument();

  const first = indexEntry(/^1 · Add the number guard import$/);
  await expect.element(first).toHaveAttribute("aria-current", "location");
  await expect
    .element(index().getByRole("list", { name: "Files in commit 1" }))
    .toHaveTextContent("src/lib.js");
  await expect.element(indexEntry("2 · Guard add · 1 open thread · 1 agent concern")).toBeVisible();

  await goToCommit(/^5 · Step 5/);
  await expect.element(first).not.toHaveAttribute("aria-current");
  await expect.element(index().getByRole("list", { name: "Files in commit 5" })).toBeVisible();
  await expect
    .element(index().getByRole("list", { name: "Files in commit 1" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Step 5", level: 2 })).toBeInViewport();

  await page.getByRole("checkbox", { name: "Viewed commit 5" }).click();
  await expect.element(index().getByText("1 of 8 viewed · 1 open thread")).toBeVisible();
  await expect
    .element(index().getByRole("progressbar", { name: "Commits viewed" }))
    .toHaveAttribute("aria-valuenow", "1");
});

test("a reply the reviewer has not read puts a dot on its commit", async () => {
  const { server } = await renderReview(sectioned());
  server.push({
    type: "reply",
    commentId: JSON.parse('"c_aaaaaa"'),
    reply: aReply({ id: JSON.parse('"r_cccccc"') }),
  });
  await expect
    .element(indexEntry("2 · Guard add · 1 open thread · 1 unread agent reply · 1 agent concern"))
    .toBeVisible();
});

test("the arrow keys move through the index and Enter goes to the commit", async () => {
  await renderReview(sectioned());
  await userEvent.keyboard("s");
  await expect.element(indexEntry(/^1 · /)).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await expect.element(indexEntry(/^3 · Step 3/)).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(indexEntry(/^8 · Step 8/)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(indexEntry(/^8 · Step 8/)).toHaveAttribute("aria-current", "location");
});

test("[ collapses the index to a rail that names each commit, brings back the stack, and is remembered", async () => {
  const { screen } = await renderReview(sectioned());
  await userEvent.keyboard("[[");
  await expect.element(index().getByRole("button", { name: "Show index" })).toBeVisible();
  await expect.element(index().getByRole("heading")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /Commit 1 of 8/ })).toBeVisible();
  expect(index().element().getBoundingClientRect().width).toBe(40);

  await indexEntry(/^2 · Guard add/).hover();
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent("2 · Guard add · 1 open thread · 1 agent concern");
  await indexEntry(/^7 · Step 7/).click();
  await expect.element(page.getByRole("button", { name: /Commit 7 of 8/ })).toBeVisible();

  await screen.unmount();
  await renderReview(sectioned());
  await expect.element(index().getByRole("button", { name: "Show index" })).toBeVisible();
  await index().getByRole("button", { name: "Show index" }).click();
  await expect.element(index().getByRole("button", { name: "Hide index" })).toBeVisible();
  expect(index().element().getBoundingClientRect().width).toBe(216);
});

test("below 1280px the index starts as the rail, and a plan without sections is one flat list", async () => {
  await page.viewport(1100, 900);
  await renderReview(aLongState());
  await expect.element(index().getByRole("button", { name: "Show index" })).toBeVisible();
  await index().getByRole("button", { name: "Show index" }).click();
  await expect.element(indexEntry(/^8 · Step 8/)).toBeVisible();
  await expect.element(index().getByRole("heading")).not.toBeInTheDocument();
});
