import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { aComment, aCommit, aHunk, aReply, aState, HUNK } from "../test/factories.ts";
import { renderReview } from "../test/render.tsx";

/** Plan v3: eight commits so the page scrolls, the v2 flag on the guard rows, its code changed. */
function v3() {
  const base = aState();
  const [first, second] = base.commits;
  if (first === undefined || second === undefined) throw new Error("two commits");
  return aState({
    version: JSON.parse("3"),
    commits: [
      first,
      second,
      ...Array.from({ length: 6 }, (_, i) =>
        aCommit(i + 2, {
          message: `Step ${i + 3}`,
          refs: [{ unit: aHunk().id, select: { kind: "lines", changes: [i + 10] } }],
        }),
      ),
    ],
    previous: { version: JSON.parse("2"), comments: [], responses: [] },
    carried: [
      {
        comment: aComment({
          kind: undefined,
          body: "Guard both in one call",
          replies: [aReply({ body: "Done, both are checked in one call." })],
        }),
        unit: JSON.parse(JSON.stringify(HUNK)),
        offsets: null,
        changed: true,
        path: JSON.parse('"src/lib.js"'),
        newLine: 5,
      },
      {
        comment: aComment({
          id: JSON.parse('"c_gone00"'),
          kind: undefined,
          body: "Drop the helper",
        }),
        unit: null,
        offsets: null,
        changed: true,
        path: JSON.parse('"src/lib.js"'),
        newLine: null,
      },
    ],
  });
}

test("a new plan version shows its banner, keeps the commit in place and carries the thread live", async () => {
  const { server } = await renderReview(aState({ commits: v3().commits }));
  await page.getByRole("button", { name: /Commit 1 of 8/ }).click();
  await page.getByRole("menuitem", { name: /Step 6/ }).click();
  await expect.element(page.getByRole("button", { name: /Commit 6 of 8/ })).toBeVisible();
  const top = () => document.getElementById("commit-6")?.getBoundingClientRect().top ?? 0;
  const before = top();

  server.on("GET", "/api/state", () => v3());
  server.push({
    type: "version",
    version: JSON.parse("3"),
    hash: "h3",
    carried: v3().carried ?? [],
  });

  await expect
    .element(page.getByText("Plan v3 arrived: 2 threads moved to changed code"))
    .toBeVisible();
  expect(Math.abs(top() - before)).toBeLessThan(2);

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();

  const changed = page.getByRole("article", { name: "Thread" }).first();
  await expect.element(changed.getByText("Code changed since you asked")).toBeVisible();
  await expect.element(changed.getByText("What you commented on, in v2")).toBeVisible();
  // The v2 quote is the first guard; the rows now at that place add the second.
  await expect
    .element(changed.getByRole("region", { name: "What changed" }))
    .toHaveTextContent("assertNumber(a);+ assertNumber(b);");
  await expect.element(changed.getByText("Done, both are checked in one call.")).toBeVisible();
  await expect.element(page.getByText("This code is gone in v3")).toBeVisible();

  server.on("POST", "/api/comments/c_aaaaaa/replies", () => ({ id: "r_bbbbbb" }));
  await changed.getByRole("button", { name: "Reply" }).click();
  await userEvent.keyboard("Thanks");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await expect
    .poll(() => server.calls.find((c) => c.path === "/api/comments/c_aaaaaa/replies")?.body)
    .toEqual({ author: "reviewer", body: "Thanks" });

  server.push({
    type: "reply",
    commentId: JSON.parse('"c_aaaaaa"'),
    reply: aReply({ id: JSON.parse('"r_cccccc"'), body: "Merged into one assert." }),
  });
  await expect.element(changed.getByText("Merged into one assert.")).toBeVisible();
});
