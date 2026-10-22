import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { State } from "../lib/wire.ts";
import { aComment, aGuardedState, aRef, aReply, GUARD, HUNK } from "../test/factories.ts";
import { goToCommit } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const ANSWER = [
  "Both arguments are checked before anything runs:",
  "",
  "1. `src/lib.js:4-5` guards a and b.",
  "2. `src/guard.js:1-3` throws for anything but a number.",
  "3. `types/guard.d.ts:3` declares it for callers.",
].join("\n");

const REFS = [
  aRef(),
  aRef({
    n: 2,
    path: "src/guard.js",
    start: 1,
    end: 3,
    quote: ["export function assertNumber(x) {"],
  }),
  aRef({
    n: 3,
    path: "types/guard.d.ts",
    start: 3,
    end: 3,
    quote: ["export declare function assertNumber(x: unknown): asserts x is number;"],
  }),
];

/** Eight commits; the agent answers the question on commit 2's guard with three refs. */
function answered(overrides: Partial<State> = {}): State {
  return aGuardedState({
    comments: [aComment({ replies: [aReply({ body: ANSWER, refs: REFS })] })],
    ...overrides,
  });
}

const chip = (n: number) => page.getByRole("button", { name: new RegExp(`^Ref ${n}: `) }).first();
const row = (commit: number, unit: string, r: number) =>
  document.querySelector<HTMLElement>(`#commit-${commit} [data-unit="${unit}"] [data-row="${r}"]`);
const tint = (commit: number, unit: string, r: number) =>
  row(commit, unit, r)?.dataset["refTint"] ?? null;

test("chips number the refs, name their file and lines, and say where a later commit has them", async () => {
  await renderReview(answered());
  await expect.element(chip(1)).toHaveTextContent("1lib.js:4-5");
  await expect.element(chip(2)).toHaveTextContent("2guard.js:1-3commit 6");
  await expect.element(chip(3)).toHaveTextContent("3guard.d.ts:3");
  await expect.element(page.getByText("guards a and b.", { exact: false })).toBeVisible();
  // The code span is gone; the chip stands in its place.
  expect(document.querySelector("article code")).toBeNull();
});

test("hovering the reply tints its rows and badges the first, a hovered chip strengthens its own", async () => {
  await renderReview(answered());
  await goToCommit(/^2 · Guard add/);
  expect(tint(2, HUNK, 3)).toBeNull();
  await page.getByText("guards a and b.", { exact: false }).hover();
  await expect.poll(() => tint(2, HUNK, 3)).toBe("light");
  expect(tint(2, HUNK, 4)).toBe("light");
  expect(tint(2, HUNK, 5)).toBeNull();
  const gutter = row(2, HUNK, 3)?.querySelector<HTMLElement>("[data-gutter] > span");
  expect(gutter?.dataset["refBadge"]).toBe("1");
  expect(getComputedStyle(gutter ?? document.body, "::before").content).toBe('"1"');

  await chip(1).hover();
  await expect.poll(() => tint(2, HUNK, 3)).toBe("strong");
  await page.getByRole("button", { name: "Submit review" }).hover();
  await expect.poll(() => tint(2, HUNK, 3)).toBeNull();
  expect(gutter?.dataset["refBadge"]).toBeUndefined();
});

test("a chip jumps into a later Viewed commit, and Back returns to the reply in one hop", async () => {
  await renderReview(answered());
  await page.getByRole("checkbox", { name: "Viewed commit 6" }).click();
  await goToCommit(/^2 · Guard add/);
  expect(row(6, GUARD, 0)).toBeNull();
  const before = chip(2).element().getBoundingClientRect().top;

  await chip(2).click();
  await expect.poll(() => row(6, GUARD, 0)).not.toBeNull();
  await expect.element(page.elementLocator(row(6, GUARD, 0) ?? document.body)).toBeInViewport();
  const back = page.getByRole("button", { name: "Back to the reply" });
  await expect.element(back).toBeVisible();

  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await expect.element(back).not.toBeInTheDocument();
  await expect
    .poll(() => Math.abs(chip(2).element().getBoundingClientRect().top - before))
    .toBeLessThan(2);
});

test("code outside the branch's changes opens its quote in the peek", async () => {
  await renderReview(answered());
  await chip(3).click();
  const peek = page.getByRole("dialog", { name: "Ref 3 at types/guard.d.ts:3" });
  await expect.element(peek).toMatchTextContent(/outside this branch.s changes/);
  await expect.element(peek).toMatchTextContent(/asserts x is number;/);
  await expect.element(page.getByRole("button", { name: /^Back to/ })).not.toBeInTheDocument();
});

test("a ref written on an earlier tip is grey, says so, and shows its quote", async () => {
  const old = aRef({ tip: JSON.parse(`"${"9".repeat(40)}"`) });
  await renderReview(
    aGuardedState({
      comments: [aComment({ replies: [aReply({ body: "See `src/lib.js:4-5`.", refs: [old] })] })],
    }),
  );
  await expect.element(chip(1)).toHaveAttribute("data-ref-state", "stale");
  await expect.element(chip(1)).toMatchTextContent(/from 9999999/);
  await chip(1).click();
  const peek = page.getByRole("dialog", { name: "Ref 1 at src/lib.js:4-5" });
  await expect.element(peek).toMatchTextContent(/the code may differ now/);
  await expect.element(peek).toMatchTextContent(/assertNumber\(b\);/);
});

test("a thread carried from an earlier version keeps its refs", async () => {
  await renderReview(
    aGuardedState({
      version: JSON.parse("3"),
      previous: { version: JSON.parse("2"), comments: [], responses: [] },
      carried: [
        {
          comment: aComment({
            replies: [aReply({ body: "Look again at `src/lib.js:4-5`.", refs: [aRef()] })],
          }),
          unit: JSON.parse(JSON.stringify(HUNK)),
          offsets: [3, 4],
          changed: false,
          path: JSON.parse('"src/lib.js"'),
          newLine: 4,
        },
      ],
    }),
  );
  await goToCommit(/^2 · Guard add/);
  await page.getByText("Look again", { exact: false }).hover();
  await expect.poll(() => tint(2, HUNK, 4)).toBe("light");
});

test("hovering a chip whose code is off screen glances at it without leaving the reply", async () => {
  await renderReview(answered());
  await goToCommit(/^2 · Guard add/);
  const peek = page.getByRole("dialog", { name: "Ref 2 at src/guard.js:1-3" });
  await chip(2).hover();
  await expect.element(peek).toMatchTextContent(/in commit 6/);
  expect(peek.element().contains(document.activeElement)).toBe(false);
  await chip(1).hover();
  await expect.element(peek).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await expect
    .element(page.getByRole("dialog", { name: "Ref 1 at src/lib.js:4-5" }))
    .not.toBeInTheDocument();
});
