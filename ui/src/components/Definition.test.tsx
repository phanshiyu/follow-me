import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Candidate, TextHunk } from "../lib/wire.ts";
import { aCandidate, aHunk, aLongState } from "../test/factories.ts";
import { goToCommit } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const GUARD = "h_0000000000aa";

/** Eight commits; commit 6, in "The details", adds src/guard.js where assertNumber is defined. */
function withGuard() {
  const guard: TextHunk = aHunk({
    id: JSON.parse(`"${GUARD}"`),
    path: JSON.parse('"src/guard.js"'),
    body: [
      { op: "+", text: "export function assertNumber(x) {\n", change: 0 },
      {
        op: "+",
        text: "  if (typeof x !== 'number') throw new TypeError('not a number');\n",
        change: 1,
      },
      { op: "+", text: "}\n", change: 2 },
    ],
    changeCount: 3,
  });
  const base = aLongState();
  return aLongState({
    units: [...base.units, guard],
    commits: base.commits.map((c) =>
      c.index === 5
        ? JSON.parse(
            JSON.stringify({
              ...c,
              message: "Add the guard",
              section: "details",
              refs: [{ unit: GUARD, select: { kind: "lines", changes: [0, 1, 2] } }],
            }),
          )
        : c,
    ),
  });
}

const inGuard = aCandidate({ unit: JSON.parse(`"${GUARD}"`), row: 0, commit: 5 });
const outside = aCandidate({
  path: "types/guard.d.ts",
  newLine: 3,
  kind: "type",
  preview: ["export declare function assertNumber(x: unknown): asserts x is number;"],
});

/** The name `assertNumber` in commit 2's "assertNumber(a);" row, once it is highlighted. */
const usage = () =>
  page
    .getByRole("listbox", { name: "Rows of src/lib.js" })
    .nth(1)
    .getByRole("option", { name: /^Added 4/ })
    .getByText("assertNumber", { exact: true });

async function answer(candidates: readonly Candidate[]) {
  const rendered = await renderReview(withGuard());
  rendered.server.on("GET", /^\/api\/definition\?/, () => ({ candidates }));
  await expect.element(usage()).toHaveClass("tok-function");
  return rendered;
}

const underlined = () => {
  const range = CSS.highlights.get("definition")?.values().next().value;
  return range instanceof Range ? range.toString() : null;
};

async function commandClick() {
  await userEvent.keyboard("{Meta>}");
  await usage().click();
  await userEvent.keyboard("{/Meta}");
}

test("holding Cmd over a name underlines it once the server knows its definition", async () => {
  const { server } = await answer([inGuard]);
  await usage().hover();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(underlined()).toBeNull();
  expect(server.calls.some((c) => c.path.startsWith("/api/definition"))).toBe(false);

  await userEvent.keyboard("{Meta>}");
  await expect.poll(underlined).toBe("assertNumber");
  const code = usage().element().closest<HTMLElement>("[data-code]");
  expect(code?.style.cursor).toBe("pointer");
  expect(server.calls.filter((c) => c.path.startsWith("/api/definition"))).toEqual([
    { method: "GET", path: "/api/definition?name=assertNumber&from=src%2Flib.js", body: undefined },
  ]);

  await userEvent.keyboard("{/Meta}");
  await expect.poll(underlined).toBeNull();
  expect(code?.style.cursor).toBe("");
});

test("a plain click on a name neither looks it up nor jumps", async () => {
  const { server } = await answer([inGuard]);
  await usage().click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.calls.some((c) => c.path.startsWith("/api/definition"))).toBe(false);
  await expect
    .element(page.getByRole("button", { name: /^Back to commit/ }))
    .not.toBeInTheDocument();
});

test("Cmd-click jumps into a commit collapsed by Viewed, and Alt+Left and the chip come back", async () => {
  await answer([inGuard]);
  await page.getByRole("checkbox", { name: "Viewed commit 6" }).click();
  await goToCommit(/^2 · Guard add/);
  usage().element().scrollIntoView({ block: "center" });
  const before = window.scrollY;

  await commandClick();
  const target = page
    .getByRole("listbox", { name: "Rows of src/guard.js" })
    .getByRole("option", { name: /^Added 1: export function assertNumber/ });
  await expect.element(target).toBeInViewport();
  await expect.element(target).toHaveClass(/row-flash/);
  await expect.element(page.getByRole("checkbox", { name: "Viewed commit 6" })).toBeChecked();
  const chip = page.getByRole("button", { name: "Back to commit 2" });
  await expect.element(chip).toBeVisible();

  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await expect.poll(() => window.scrollY).toBe(before);
  await expect.element(chip).not.toBeInTheDocument();

  await commandClick();
  await expect.element(target).toBeInViewport();
  await chip.click();
  await expect.poll(() => window.scrollY).toBe(before);
});

test("several definitions open a list to pick from, and one outside the branch peeks", async () => {
  await answer([inGuard, outside]);
  await commandClick();
  const list = page.getByRole("dialog", { name: "Definitions of assertNumber" });
  const here = list.getByRole("button", { name: "src/guard.js:1 in commit 6 · The details" });
  const there = list.getByRole("button", { name: "types/guard.d.ts:3 outside this branch" });
  await expect.element(here).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(there).toHaveFocus();
  await userEvent.keyboard("{Enter}");

  const peek = page.getByRole("dialog", {
    name: "Definition of assertNumber at types/guard.d.ts:3",
  });
  await expect.element(peek.getByText("type", { exact: true })).toBeVisible();
  await expect.element(list).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(peek).not.toBeInTheDocument();

  await commandClick();
  await page.getByRole("button", { name: "src/guard.js:1 in commit 6 · The details" }).click();
  await expect.element(page.getByRole("button", { name: "Back to commit 2" })).toBeVisible();
});

test("a definition the branch does not change peeks beside the name, highlighted", async () => {
  await answer([aCandidate()]);
  await commandClick();
  const peek = page.getByRole("dialog", { name: "Definition of assertNumber at src/guard.js:1" });
  await expect.element(peek.getByText("outside this branch")).toBeVisible();
  await expect
    .element(peek.getByText("export", { exact: true }).first())
    .toHaveClass("tok-keyword");
  await expect.element(peek.getByText("3", { exact: true })).toBeVisible();

  // Polled, because the popover zooms in from its anchor.
  const token = usage().element().getBoundingClientRect();
  await expect
    .poll(() => Math.round(peek.element().getBoundingClientRect().left))
    .toBe(Math.round(token.left));
  expect(peek.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(token.bottom);
  await expect
    .element(page.getByRole("button", { name: /^Back to commit/ }))
    .not.toBeInTheDocument();
});
