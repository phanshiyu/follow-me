import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { aCoverage, aState } from "../test/factories.ts";
import { indexEntry } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const TITLES = ["Add the number guard import", "Guard add"];
const commit = (n: number) => page.getByRole("region", { name: TITLES[n - 1] });
const rows = (n: number) => page.getByRole("listbox", { name: "Rows of src/lib.js" }).nth(n - 1);
const row = (n: number, name: RegExp) => rows(n).getByRole("option", { name });
const markOf = (n: number, name: RegExp) =>
  row(n, name).element().querySelector("[data-coverage]")?.getAttribute("data-coverage") ?? null;

async function withCoverage() {
  return renderReview(aState(), (server) => server.on("GET", "/api/coverage", () => aCoverage()));
}

test("each row shows its tip line's mark, named for a screen reader", async () => {
  await withCoverage();
  await expect.element(row(2, /^Added 4: .* · partly covered, 14 hits, 1 of 2/)).toBeVisible();
  await expect.element(row(2, /^Added 5: .* · not covered$/)).toBeVisible();
  await expect.element(row(2, /^Context 6: return a \+ b; · covered, 14 hits$/)).toBeVisible();
  expect(markOf(2, /^Added 4/)).toBe("partly");
  expect(markOf(2, /^Added 5/)).toBe("uncovered");
  expect(markOf(2, /^Context 6/)).toBe("covered");
  // A context row added by commit 1 keeps its mark in commit 2; a closing brace is not executable.
  expect(markOf(2, /^Context 1/)).toBe("covered");
  expect(markOf(2, /^Context 7/)).toBeNull();
  await expect.element(row(2, /^Context 7: }$/)).toBeVisible();
});

test("the commit, its files, the index and the header sum up the added lines", async () => {
  await withCoverage();
  await expect.element(commit(1).getByText("1 of 1 new lines covered")).toBeVisible();
  await expect.element(commit(2).getByText("1 of 2 new lines covered")).toBeVisible();
  await expect.element(commit(2).getByText("1/2 covered")).toBeVisible();
  await expect.element(page.getByText("Changed lines covered 66%")).toBeVisible();
  await expect.element(indexEntry(/^2 · Guard add · 50% of new lines covered$/)).toBeVisible();
  await expect.element(indexEntry(/^1 · .* · 100% of new lines covered$/)).toBeVisible();
});

test("without a test run the page shows no marks and no figures", async () => {
  const { server } = await renderReview(aState());
  await expect.element(row(2, /^Added 4: assertNumber\(a\);$/)).toBeVisible();
  expect(server.calls.some((c) => c.path === "/api/coverage")).toBe(true);
  expect(document.querySelector("[data-coverage]")).toBeNull();
  await expect
    .element(page.getByText(/new lines covered|Changed lines covered/))
    .not.toBeInTheDocument();
});
