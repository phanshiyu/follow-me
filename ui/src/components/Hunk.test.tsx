import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { aState } from "../test/factories.ts";
import { renderReview } from "../test/render.tsx";

const guards = () => page.getByRole("listbox", { name: "Rows of src/lib.js" }).nth(1);
const row = (name: RegExp) => guards().getByRole("option", { name });

async function dragGutter(from: RegExp, to: RegExp) {
  const start = row(from).element().getBoundingClientRect();
  const end = row(to).element().getBoundingClientRect();
  // The gutter is the first 40px of a row.
  await userEvent.dragAndDrop(row(from), row(to), {
    sourcePosition: { x: 10, y: start.height / 2 },
    targetPosition: { x: 10, y: end.height / 2 },
  });
}

test("dragging the gutter over context and added rows posts their offsets and own changes", async () => {
  const { server } = await renderReview(aState());
  server.on("POST", "/api/comments", () => ({ id: "c_aaaaaa" }));
  await dragGutter(/^Context 3: export function add/, /^Added 5: assertNumber\(b\)/);
  await expect.element(row(/^Context 3/)).toHaveAttribute("aria-selected", "true");
  await expect.element(row(/^Added 5/)).toHaveAttribute("aria-selected", "true");

  await guards().getByRole("button", { name: "Ask", exact: true }).click();
  await userEvent.keyboard("Why both?");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

  await expect
    .poll(() => server.calls.find((c) => c.method === "POST")?.body)
    .toEqual({
      anchor: {
        kind: "hunk",
        unit: "h_7da8387be1bf",
        commit: 1,
        changes: [2, 3],
        offsets: [2, 3, 4],
      },
      context: {
        commitMessage: "Guard add\n\nadd now rejects strings.",
        path: "src/lib.js",
        lines: ["export function add(a, b) {", "  assertNumber(a);", "  assertNumber(b);"],
      },
      body: "Why both?",
      kind: "question",
    });
  await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
});

test("selecting code text picks the rows it spans and offers Flag and Ask", async () => {
  await renderReview(aState());
  const from = row(/^Added 4/)
    .element()
    .querySelector("span:last-of-type");
  const to = row(/^Context 6/).element();
  const range = document.createRange();
  if (from === null) throw new Error("row 4 has code");
  range.setStart(from, 0);
  range.setEnd(to, 1);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  to.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await expect.element(row(/^Added 5/)).toHaveAttribute("aria-selected", "true");
  await expect.element(row(/^Context 6/)).toHaveAttribute("aria-selected", "true");
  await expect.element(row(/^Context 3/)).toHaveAttribute("aria-selected", "false");
  await expect.element(guards().getByRole("button", { name: "Flag", exact: true })).toBeVisible();
});

test("the keyboard picks rows: Space, Shift+Down to extend, f to flag, Escape to clear", async () => {
  await renderReview(aState());
  const start = row(/^Context 3/).element();
  if (!(start instanceof HTMLElement)) throw new Error("a row is an element");
  start.focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
  await expect.element(row(/^Added 4/)).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("f");
  await expect.element(page.getByRole("textbox", { name: "Flag lines 3-4" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
});
