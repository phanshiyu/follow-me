// Named places and actions on the review page, shared by the page tests.

import { expect } from "vitest";
import { page } from "vitest/browser";

export const index = () => page.getByRole("navigation", { name: "Index" });

/** An index row or rail number, named "4 · title · marks". */
export const indexEntry = (name: string | RegExp) => index().getByRole("button", { name });

/** Scrolls to a commit from the index and waits until it is the current one. */
export async function goToCommit(name: RegExp): Promise<void> {
  await indexEntry(name).click();
  await expect.element(indexEntry(name)).toHaveAttribute("aria-current", "location");
}
