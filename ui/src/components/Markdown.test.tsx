import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../index.css";
import { Markdown } from "./Markdown.tsx";

const reply = [
  "Because **a** is read first. See [the docs](https://example.com) and `assertNumber`.",
  "",
  '<img src="x" onerror="window.hacked = true"> <b>raw</b> ![alt text](https://example.com/x.png)',
  "",
  "```mermaid",
  "flowchart LR",
  "  add --> assertNumber",
  "```",
  "",
  "[bad](javascript:alert(1))",
].join("\n");

test("markdown renders safely and a mermaid fence becomes a diagram that opens in a lightbox", async () => {
  const screen = await render(<Markdown text={reply} title="Why a first" />);
  await expect.element(screen.getByText("a", { exact: true })).toBeVisible();
  expect(screen.container.querySelector("strong")?.textContent).toBe("a");
  expect(screen.container.querySelector("code")?.textContent).toBe("assertNumber");
  expect(screen.container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(screen.container.querySelector("img")).toBeNull();
  expect(screen.container.querySelector("b")).toBeNull();
  await expect.element(screen.getByText(/<b>raw<\/b>/)).toBeVisible();
  expect(screen.container.textContent).toContain("alt text");
  expect(screen.container.querySelector('a[href^="javascript"]')).toBeNull();
  expect(Reflect.get(window, "hacked")).toBeUndefined();

  const diagram = screen.getByRole("button", { name: "Enlarge Why a first" });
  await expect
    .poll(() => diagram.element().querySelector("svg"), { timeout: 45_000 })
    .not.toBeNull();
  await diagram.click();
  const dialog = page.getByRole("dialog", { name: "Why a first" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Actual size" })).toBeVisible();
  expect(dialog.element().querySelector("svg")).not.toBeNull();
}, 60_000);
