import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { State, StateMap } from "../lib/wire.ts";
import { aCoverage, aGuardedState, anOffer, aReply, OFFER } from "../test/factories.ts";
import { indexEntry } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const DIAGRAM = [
  "stateDiagram-v2",
  "  [*] --> Idle",
  "  Idle --> Checking: add",
  "  Checking --> Done: number",
  "  Checking --> Rejected: string",
].join("\n");

const loc = (path: string, start: number, end = start) => ({ path, start, end });

/**
 * Idle is the import commit 1 adds, which ran. Checking is assertNumber(a), one branch of two,
 * and the guard commit 6 adds, which the run never saw. Rejected is assertNumber(b), never run.
 * Done is code the branch does not touch.
 */
const MAP: StateMap = JSON.parse(
  JSON.stringify({
    states: {
      Idle: [loc("src/lib.js", 1)],
      Checking: [loc("src/lib.js", 4), loc("src/guard.js", 1, 3)],
      Rejected: [loc("src/lib.js", 5)],
      Done: [loc("types/other.ts", 1, 2)],
    },
    transitions: [{ from: "Idle", to: "Checking", event: "add", at: [loc("src/lib.js", 3)] }],
  }),
);

/** Commit 2 offered a state machine; the reviewer accepted and the agent answered with a map. */
function answered(): State {
  const base = aGuardedState();
  return aGuardedState({
    commits: base.commits.map((c) => (c.index === 1 ? { ...c, offers: [anOffer()] } : c)),
    comments: [
      JSON.parse(
        JSON.stringify({
          id: "c_offer1",
          anchor: { kind: "message", commit: 1 },
          context: { commitMessage: "Guard add", path: null },
          body: "Draw UploadButton as a state machine",
          createdAt: "2026-10-22T10:00:00Z",
          kind: "question",
          offer: OFFER,
          replies: [aReply({ body: "Here it is.", diagram: DIAGRAM, map: MAP })],
        }),
      ),
    ],
  });
}

async function withMachine(coverage = true) {
  const rendered = await renderReview(answered(), (server) => {
    if (coverage) server.on("GET", "/api/coverage", () => aCoverage());
  });
  await expect
    .poll(() => card().element().querySelector("[data-pick]"), { timeout: 45_000 })
    .not.toBeNull();
  return rendered;
}

const card = () =>
  page.getByRole("article", { name: "Offer: Draw UploadButton as a state machine" });
const diagram = () =>
  card()
    .getByRole("button", { name: /^Enlarge/ })
    .element().parentElement;
const state = (name: string) => card().getByRole("button", { name: new RegExp(`^${name}, `) });
const table = () =>
  card().getByRole("table", { name: "States and moves of The agent's state machine" });
const rowOf = (name: string) => table().getByRole("row").filter({ hasText: name }).first();
const lib = (n: number) => page.getByRole("listbox", { name: "Rows of src/lib.js" }).nth(n - 1);
const back = () => page.getByRole("button", { name: "Back to commit 2" });

/** Puts the diagram in view, as a reader would be, and returns where the page stood. */
function readDiagram(): number {
  diagram()?.scrollIntoView({ block: "center" });
  return window.scrollY;
}

test("each mapped state carries its coverage as an outline, a badge and words", async () => {
  await withMachine();
  await expect.element(state("Idle")).toHaveAccessibleName("Idle, covered, 1 of 1 line");
  await expect
    .element(state("Checking"))
    .toHaveAccessibleName("Checking, partly covered, 1 of 1 line");
  await expect
    .element(state("Rejected"))
    .toHaveAccessibleName("Rejected, not covered, 0 of 1 line");
  await expect.element(state("Done")).toHaveAccessibleName("Done, coverage unknown");

  const outlines = (name: string) => state(name).element().querySelectorAll(".sm-outline").length;
  const badge = (name: string) => state(name).element().querySelector("text.sm-added")?.textContent;
  expect([outlines("Idle"), outlines("Checking"), outlines("Rejected"), outlines("Done")]).toEqual([
    1, 1, 2, 0,
  ]);
  expect(state("Checking").element().querySelector(".sm-outline")?.getAttribute("style")).toContain(
    "stroke-dasharray: 5 3",
  );
  expect([badge("Idle"), badge("Rejected"), badge("Done")]).toEqual(["✓", "✕", undefined]);
  expect(state("Checking").element().querySelector("path.sm-added")).not.toBeNull();
  expect(state("Idle").element().querySelector("title")?.textContent).toBe(
    "Idle: covered, 1 of 1 line",
  );

  await expect
    .element(card().getByText(/^from tests at/))
    .toHaveTextContent("from tests at b164dd3");
  expect(rowOf("Rejected").element().textContent).toContain("✕not covered0/1");
  expect(rowOf("Idle → Checking").element().textContent).toContain("✓covered1/1");
  expect(rowOf("Done").element().textContent).toContain("outside this branchunknown");
}, 60_000);

test("without a test run every state is plain and the legend says so", async () => {
  await withMachine(false);
  await expect.element(state("Idle")).toHaveAccessibleName("Idle, coverage unknown");
  expect(card().element().querySelectorAll(".sm-outline")).toHaveLength(0);
  await expect.element(card().getByText(/no test run yet/)).toBeVisible();
}, 60_000);

test("clicking a state jumps to its code, and Back returns to the diagram", async () => {
  await withMachine();
  const before = readDiagram();
  await state("Idle").click();
  const target = lib(1).getByRole("option", { name: /^Added 1: import/ });
  await expect.element(target).toBeInViewport();
  await expect.element(target).toHaveClass(/row-flash/);
  await expect.element(indexEntry(/^1 /)).toHaveAttribute("aria-current", "location");
  await back().click();
  await expect.poll(() => window.scrollY).toBe(before);
  await expect.element(back()).not.toBeInTheDocument();

  state("Rejected").element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(lib(2).getByRole("option", { name: /^Added 5: / })).toHaveClass(/row-flash/);
  await expect.element(back()).toBeVisible();
}, 60_000);

test("a state in several places lists them, and one outside the branch peeks", async () => {
  await withMachine();
  readDiagram();
  await state("Checking").click();
  const list = page.getByRole("dialog", { name: "Places of Checking" });
  await expect.element(list).toBeVisible();
  expect(list.element().textContent).toContain("2 places of Checking");
  await list.getByRole("button", { name: /^src\/guard\.js:1 in commit 6/ }).click();
  const guard = page
    .getByRole("listbox", { name: "Rows of src/guard.js" })
    .getByRole("option", { name: /^Added 1: export function assertNumber/ });
  await expect.element(guard).toBeInViewport();
  await expect.element(back()).toBeVisible();

  await back().click();
  await state("Done").click();
  const peek = page.getByRole("dialog", { name: "State of Done at types/other.ts:1" });
  await expect.element(peek.getByText("outside this branch")).toBeVisible();
  await expect.element(peek.getByText(/This branch does not change these lines/)).toBeVisible();
  await expect.element(back()).not.toBeInTheDocument();
}, 60_000);

test("the table links every state and move to its code", async () => {
  await withMachine();
  readDiagram();
  await rowOf("Idle → Checking").getByRole("button", { name: "src/lib.js:3 in commit 1" }).click();
  await expect
    .element(lib(1).getByRole("option", { name: /^Context 3: export function add/ }))
    .toBeInViewport();
  await expect.element(back()).toBeVisible();
  await back().click();

  await rowOf("Checking").getByRole("button", { name: "Checking" }).click();
  await expect.element(page.getByRole("dialog", { name: "Places of Checking" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await rowOf("Checking")
    .getByRole("button", { name: /^src\/guard\.js:1-3 in commit 6/ })
    .click();
  await expect
    .element(
      page.getByRole("listbox", { name: "Rows of src/guard.js" }).getByRole("option").first(),
    )
    .toBeInViewport();
}, 60_000);

test("the lightbox keeps the marks, and a state clicked there jumps from the page", async () => {
  await withMachine();
  const before = readDiagram();
  await card().getByRole("button", { name: "Enlarge The agent's state machine" }).click();
  const box = page.getByRole("dialog", { name: "The agent's state machine" });
  const inBox = (name: string) => box.getByRole("button", { name: new RegExp(`^${name}, `) });
  await expect
    .element(inBox("Rejected"))
    .toHaveAccessibleName("Rejected, not covered, 0 of 1 line");
  expect(inBox("Rejected").element().querySelectorAll(".sm-outline")).toHaveLength(2);

  await inBox("Idle").click();
  await expect.element(box).not.toBeInTheDocument();
  await expect.element(lib(1).getByRole("option", { name: /^Added 1: import/ })).toBeInViewport();
  await back().click();
  await expect.poll(() => window.scrollY).toBe(before);
}, 60_000);

test("hiding coverage takes the marks off the diagram", async () => {
  await withMachine();
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  await expect.element(state("Idle")).toHaveAccessibleName("Idle, coverage unknown");
  expect(card().element().querySelectorAll(".sm-outline")).toHaveLength(0);
}, 60_000);
