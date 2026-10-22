import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { TextHunk } from "../lib/wire.ts";
import { aCandidate, aCoverage, aHunk, aLongState, aState } from "../test/factories.ts";
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

const details = (path: string, line: number) =>
  page.getByRole("dialog", { name: `Coverage of ${path}:${line}` });

async function clickMark(n: number, name: RegExp, line: number) {
  await row(n, name)
    .getByRole("button", { name: `Coverage of line ${line}` })
    .click();
}

test("a mark opens what the run did there, and says when it kept no per-test detail", async () => {
  await withCoverage();
  await clickMark(2, /^Context 6/, 6);
  await expect.element(details("src/lib.js", 6).getByText("Hit 14 times")).toBeVisible();
  await expect
    .element(details("src/lib.js", 6).getByText("No per-test detail in this run"))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(details("src/lib.js", 6)).not.toBeInTheDocument();

  await clickMark(2, /^Added 4/, 4);
  await expect.element(details("src/lib.js", 4).getByText("1 of 2 branches taken")).toBeVisible();
  await clickMark(2, /^Added 4/, 4);
  await expect.element(details("src/lib.js", 4)).not.toBeInTheDocument();
});

test("Enter on a focused row opens its mark's popover", async () => {
  await withCoverage();
  const added = row(2, /^Added 4/).element();
  if (!(added instanceof HTMLElement)) throw new Error("a row is an element");
  added.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(details("src/lib.js", 4).getByText("Hit 14 times")).toBeVisible();
});

test("an uncovered line says which run missed it and flags it as a missing test", async () => {
  const { server } = await withCoverage();
  server.on("POST", "/api/comments", () => ({ id: "c_bbbbbb" }));
  await clickMark(2, /^Added 5/, 5);
  await expect
    .element(
      details("src/lib.js", 5).getByText(
        /^Not run by the suite at b164dd3 \(2026-10-2\d \d\d:\d5\)$/,
      ),
    )
    .toBeVisible();
  await details("src/lib.js", 5).getByRole("button", { name: "Flag as missing test" }).click();

  const box = page.getByRole("textbox", { name: "Flag line 5" });
  await expect.element(box).toHaveFocus();
  await expect.element(box).toHaveValue("Missing test: no test runs src/lib.js:5.");
  await userEvent.keyboard(" Cover a string b.");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await expect
    .poll(() => server.calls.find((c) => c.method === "POST")?.body)
    .toMatchObject({
      anchor: { kind: "hunk", commit: 1, offsets: [4] },
      body: "Missing test: no test runs src/lib.js:5. Cover a string b.",
    });
});

/** Eight commits; commit 4 adds test/lib.test.js, whose second line opens a test of add. */
function withTests() {
  const spec = aFile("h_0000000000b4", "test/lib.test.js");
  const base = aLongState();
  const state = aLongState({
    units: [...base.units, spec],
    commits: base.commits.map((c) =>
      c.index === 3
        ? { ...c, refs: [{ unit: spec.id, select: { kind: "lines", changes: [0, 1, 2] } }] }
        : c,
    ),
  });
  const tests = {
    "test/lib.test.js::add guards its arguments": {
      at: { path: "test/lib.test.js", start: 2, end: 3 },
      lines: { "src/lib.js": [3, 4, 6] },
    },
    "test/guard_test.go::TestAssertNumber": {
      at: { path: "test/guard_test.go", start: 10, end: 14 },
      lines: { "src/lib.js": [4] },
    },
    "add accepts numbers": { lines: { "src/lib.js": [4] } },
  };
  return renderReview(state, (server) => {
    server.on("GET", "/api/coverage", () =>
      aCoverage({ tests: JSON.parse(JSON.stringify(tests)) }),
    );
    server.on("GET", /^\/api\/definition\?name=TestAssertNumber&/, () => ({
      candidates: [
        aCandidate({
          path: "test/guard_test.go",
          newLine: 10,
          preview: ["func TestAssertNumber(t *testing.T) {"],
        }),
      ],
    }));
  });
}

test("with per-test detail, a test in the branch links in with Back and one outside peeks", async () => {
  await withTests();
  await clickMark(2, /^Added 4/, 4);
  const popover = details("src/lib.js", 4);
  await expect.element(popover.getByText("Run by 3 tests")).toBeVisible();
  await expect
    .element(popover.getByRole("button", { name: /^add accepts numbers/ }))
    .not.toBeInTheDocument();
  await expect.element(popover.getByText("add accepts numbers")).toBeVisible();

  await popover
    .getByRole("button", {
      name: /^test\/lib\.test\.js::add guards its arguments test\/lib\.test\.js:2 · in commit 4$/,
    })
    .click();
  const landed = page
    .getByRole("listbox", { name: "Rows of test/lib.test.js" })
    .getByRole("option", { name: /^Added 2/ });
  await expect.element(landed).toBeInViewport();
  await expect.element(landed).toHaveClass(/row-flash/);
  const back = page.getByRole("button", { name: "Back to commit 2" });
  await back.click();
  await expect.element(back).not.toBeInTheDocument();

  await clickMark(2, /^Added 4/, 4);
  await details("src/lib.js", 4)
    .getByRole("button", {
      name: /TestAssertNumber test\/guard_test\.go:10 · outside this branch$/,
    })
    .click();
  const peek = page.getByRole("dialog", {
    name: "Test of TestAssertNumber at test/guard_test.go:10",
  });
  await expect.element(peek.getByText("func", { exact: true })).toBeVisible();
  await expect.element(peek.getByText("test", { exact: true })).toBeVisible();
});
