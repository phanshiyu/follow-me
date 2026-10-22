import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { TextHunk } from "../lib/wire.ts";
import { aCoverage, aHunk, aLongState, aState } from "../test/factories.ts";
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

test("Coverage and g hide every mark and figure, and the choice outlasts a reload", async () => {
  const { screen, server } = await withCoverage();
  const toggle = page.getByRole("button", { name: "Coverage" });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.element(page.getByText("Changed lines covered 66%")).not.toBeInTheDocument();
  await expect.element(row(2, /^Added 5: assertNumber\(b\);$/)).toBeVisible();
  expect(document.querySelector("[data-coverage]")).toBeNull();
  await expect.element(indexEntry(/^2 · Guard add$/)).toBeVisible();

  await screen.unmount();
  server.restore();
  await withCoverage();
  await expect
    .element(page.getByRole("button", { name: "Coverage" }))
    .toHaveAttribute("aria-pressed", "false");
  await userEvent.keyboard("g");
  await expect.element(page.getByText("Changed lines covered 66%")).toBeVisible();
  await expect.element(row(2, /^Added 5: .* · not covered$/)).toBeVisible();
});

/** One hunk adding three lines to `path`, of which the run missed only the second. */
function aFile(id: string, path: string): TextHunk {
  return aHunk({
    id: JSON.parse(`"${id}"`),
    path: JSON.parse(`"${path}"`),
    body: [
      { op: "+", text: "export const a = 1;\n", change: 0 },
      { op: "+", text: "export const b = 2;\n", change: 1 },
      { op: "+", text: "export const c = 3;\n", change: 2 },
    ],
    changeCount: 3,
  });
}

/** Eight commits; 2, 4 and 7 each add a line the run missed, and 7 is marked Viewed. */
async function withGaps() {
  const extra = {
    3: aFile("h_0000000000a4", "src/four.js"),
    6: aFile("h_0000000000a7", "src/seven.js"),
  };
  const base = aLongState();
  const state = aLongState({
    units: [...base.units, ...Object.values(extra)],
    commits: base.commits.map((c) => {
      const hunk = c.index === 3 ? extra[3] : c.index === 6 ? extra[6] : undefined;
      return hunk === undefined
        ? c
        : { ...c, refs: [{ unit: hunk.id, select: { kind: "lines", changes: [0, 1, 2] } }] };
    }),
  });
  const run = { lines: { "1": 2, "2": 0, "3": 2 } };
  const files = { ...aCoverage().files, "src/four.js": run, "src/seven.js": run };
  await renderReview(state, (server) =>
    server.on("GET", "/api/coverage", () => aCoverage({ files })),
  );
  await page.getByRole("checkbox", { name: "Viewed commit 7" }).click();
  await expect
    .element(page.getByRole("listbox", { name: "Rows of src/seven.js" }))
    .not.toBeInTheDocument();
}

const missed = (path: string, name: RegExp) =>
  page.getByRole("listbox", { name: `Rows of ${path}` }).getByRole("option", { name });

async function landedOn(target: ReturnType<typeof missed>) {
  await expect.element(target).toHaveFocus();
  await expect.element(target).toHaveClass(/row-flash/);
  const top = target.element().getBoundingClientRect().top;
  expect(Math.abs(top - window.innerHeight * 0.3)).toBeLessThan(3);
}

test("x and X step through the added lines the run missed, opening a Viewed commit", async () => {
  await withGaps();
  window.scrollTo(0, 0);
  const two = rows(2).getByRole("option", { name: /^Added 5/ });
  const four = missed("src/four.js", /^Added 2/);
  const seven = missed("src/seven.js", /^Added 2/);

  await userEvent.keyboard("x");
  await landedOn(two);
  await userEvent.keyboard("x");
  await landedOn(four);
  await userEvent.keyboard("x");
  await landedOn(seven);
  await expect.element(page.getByRole("checkbox", { name: "Viewed commit 7" })).toBeChecked();
  await userEvent.keyboard("x");
  await landedOn(two);
  await userEvent.keyboard("X");
  await landedOn(seven);
  await userEvent.keyboard("X");
  await landedOn(four);
});
