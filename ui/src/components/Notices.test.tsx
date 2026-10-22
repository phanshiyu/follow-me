import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { saveSet } from "../lib/storage.ts";
import { aComment, aLongState, aReply } from "../test/factories.ts";
import { goToCommit } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";
import { Toast } from "./Toast.tsx";

const thread = () => page.getByRole("article", { name: "Question thread" });
const agentReply = {
  type: "reply" as const,
  commentId: JSON.parse('"c_aaaaaa"'),
  reply: aReply({ id: JSON.parse('"r_cccccc"'), body: "Because a is read first, always." }),
};

/** The page scrolled to the last commit, so the thread under commit 2 is out of sight. */
async function awayFromThread() {
  const rendered = await renderReview(aLongState({ comments: [aComment()] }));
  await goToCommit(/^8 · Step 8/);
  return rendered;
}

const inView = () => {
  const box = thread().element().getBoundingClientRect();
  return box.top >= 44 && box.bottom <= window.innerHeight;
};

test("an agent reply toasts where it landed and counts as new; View jumps to the thread", async () => {
  const { server } = await awayFromThread();
  expect(inView()).toBe(false);

  server.push(agentReply);

  const toast = page.getByRole("article", { name: "Notification" });
  await expect.element(toast.getByText("Agent replied on src/lib.js:4")).toBeVisible();
  await expect.element(toast.getByText("Because a is read first, always.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "1 new from the agent" })).toBeVisible();

  await toast.getByRole("button", { name: "View" }).click();
  await expect.poll(inView).toBe(true);
  await expect.element(thread()).toHaveClass(/thread-flash/);
  await expect.element(toast).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /new from the agent/ }))
    .not.toBeInTheDocument();
});

test("the badge lists each unseen reply and clicking one jumps and marks it seen", async () => {
  const { server } = await awayFromThread();
  server.push(agentReply);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.getByRole("button", { name: "1 new from the agent" }).click();
  await page.getByRole("menuitem", { name: /Agent replied on src\/lib.js:4/ }).click();
  await expect.poll(inView).toBe(true);
  await expect
    .element(page.getByRole("button", { name: /new from the agent/ }))
    .not.toBeInTheDocument();
});

test("the reviewer's own reply makes no toast", async () => {
  const { server } = await awayFromThread();
  server.push({ ...agentReply, reply: aReply({ author: "reviewer" }) });
  await expect.element(page.getByRole("article", { name: "Notification" })).not.toBeInTheDocument();
});

test("a thread scrolled into view counts as seen", async () => {
  const { server } = await awayFromThread();
  server.push(agentReply);
  await expect.element(page.getByRole("button", { name: "1 new from the agent" })).toBeVisible();
  thread().element().scrollIntoView({ block: "center" });
  await expect
    .element(page.getByRole("button", { name: /new from the agent/ }))
    .not.toBeInTheDocument();
});

function hide(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  Reflect.deleteProperty(document, "hidden");
  vi.unstubAllGlobals();
});

test("in a background tab the title carries the unread count and a native notification jumps back", async () => {
  const made: {
    title: string;
    options: NotificationOptions | undefined;
    onclick: (() => void) | null;
  }[] = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      made.push({ title, options, onclick: null });
      const entry = made.at(-1);
      Object.defineProperty(this, "onclick", {
        set: (fn: () => void) => {
          if (entry) entry.onclick = fn;
        },
        get: () => entry?.onclick ?? null,
      });
    }
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  saveSet("prefs", new Set(["notify"]));
  const title = document.title;
  const { server } = await awayFromThread();

  hide(true);
  server.push(agentReply);
  await expect.poll(() => document.title).toBe(`(1) ${title}`);
  expect(made).toHaveLength(1);
  expect(made[0]?.title).toBe("Agent replied on src/lib.js:4");

  hide(false);
  await expect.poll(() => document.title).toBe(title);
  made[0]?.onclick?.();
  await expect.poll(inView).toBe(true);
});

test("permission is asked only when the reviewer turns the switch on", async () => {
  const asked = vi.fn(async () => "granted");
  vi.stubGlobal(
    "Notification",
    Object.assign(class {}, { permission: "default", requestPermission: asked }),
  );
  await awayFromThread();
  expect(asked).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Page options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Notify me when the agent replies" }).click();
  await expect.poll(() => asked.mock.calls.length).toBe(1);
});

test("a toast goes after its time, but not while the pointer is on it", async () => {
  const gone = vi.fn();
  await render(
    <Toast title="Agent replied" preview="Because" ms={300} onView={() => {}} onDismiss={gone} />,
  );
  await userEvent.hover(page.getByRole("article", { name: "Notification" }));
  await new Promise((r) => setTimeout(r, 600));
  expect(gone).not.toHaveBeenCalled();
  await userEvent.unhover(page.getByRole("article", { name: "Notification" }));
  await expect.poll(() => gone.mock.calls.length).toBe(1);
});
