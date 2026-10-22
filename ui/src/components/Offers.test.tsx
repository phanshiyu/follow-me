import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { OfferId, State } from "../lib/wire.ts";
import { aCommit, anOffer, aReply, aState, HUNK, OFFER } from "../test/factories.ts";
import { index } from "../test/pages.ts";
import { renderReview } from "../test/render.tsx";

const ON_HUNK = "o_00000002";

/** Commit 2 offers a state machine under its message and a sequence above its hunk. */
function withOffers(overrides: Partial<State> = {}): State {
  const base = aState();
  const second = base.commits[1] ?? aCommit(1);
  return aState({
    commits: [
      base.commits[0] ?? aCommit(0),
      {
        ...second,
        offers: [
          anOffer(),
          anOffer({
            id: JSON.parse(`"${ON_HUNK}"`),
            label: "Draw add as a sequence",
            kind: "sequence",
            unit: JSON.parse(`"${HUNK}"`),
          }),
        ],
      },
    ],
    ...overrides,
  });
}

const commit2 = () => page.getByRole("region", { name: "Guard add" });
const chip = (thing: string) => page.getByRole("button", { name: `Agent can draw: ${thing}` });
const offerCard = () =>
  page.getByRole("article", { name: "Offer: Draw UploadButton as a state machine" });

const before = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test("a commit offer sits after the agent's note, a unit offer above its hunk, none in the index", async () => {
  await renderReview(withOffers());
  const onCommit = chip("UploadButton as a state machine");
  const onHunk = chip("add as a sequence");
  await expect.element(onCommit).toBeVisible();
  await expect.element(onHunk).toBeVisible();
  const note = commit2().getByText("Look at the order of the checks.").element();
  const hunk = commit2().getByRole("listbox", { name: "Rows of src/lib.js" }).element();
  expect(before(note, onCommit.element())).toBe(true);
  expect(before(onCommit.element(), onHunk.element())).toBe(true);
  expect(before(onHunk.element(), hunk)).toBe(true);
  expect(index().element().textContent).not.toMatch(/can draw|UploadButton/);
});

test("accepting asks the agent in place and the card waits until the diagram lands", async () => {
  const { server } = await renderReview(withOffers());
  server.on("POST", "/api/comments", () => ({ id: "c_offer1" }));
  await chip("UploadButton as a state machine").click();

  await expect.element(offerCard().getByText("Waiting for the agent…")).toBeVisible();
  await expect.element(chip("UploadButton as a state machine")).not.toBeInTheDocument();
  expect(server.calls.find((c) => c.path === "/api/comments")?.body).toEqual({
    kind: "question",
    offer: OFFER,
    body: "Draw UploadButton as a state machine",
    anchor: { kind: "message", commit: 1 },
    context: { commitMessage: "Guard add\n\nadd now rejects strings.", path: null },
  });

  const posted = server.calls.find((c) => c.path === "/api/comments")?.body;
  server.push({
    type: "comment",
    comment: JSON.parse(
      JSON.stringify({
        ...(typeof posted === "object" && posted !== null ? posted : {}),
        id: "c_offer1",
        createdAt: "2026-10-22T10:00:00Z",
      }),
    ),
  });
  await expect.element(offerCard().getByText("You asked")).toBeVisible();
  await expect.element(offerCard().getByText("Waiting for the agent…")).toBeVisible();
  expect(page.getByRole("article", { name: "Question thread" }).elements()).toHaveLength(0);

  server.push({
    type: "reply",
    commentId: JSON.parse('"c_offer1"'),
    reply: aReply({ body: "Here it is.", diagram: "stateDiagram-v2\n  Idle --> Uploading" }),
  });
  await expect.element(offerCard().getByText("Here it is.")).toBeVisible();
  await expect.element(offerCard().getByText("Waiting for the agent…")).not.toBeInTheDocument();
  await expect
    .element(offerCard().getByRole("button", { name: "Enlarge The agent's diagram" }))
    .toBeVisible();
  await expect.element(chip("UploadButton as a state machine")).not.toBeInTheDocument();
});

test("a reply that only carries a diagram shows no empty words above it", async () => {
  const accepted = JSON.parse(
    JSON.stringify({
      id: "c_offer1",
      anchor: { kind: "message", commit: 1 },
      context: { commitMessage: "Guard add", path: null },
      body: "Draw UploadButton as a state machine",
      createdAt: "2026-10-22T10:00:00Z",
      kind: "question",
      offer: OFFER,
      replies: [aReply({ body: "", diagram: "stateDiagram-v2\n  Idle --> Uploading" })],
    }),
  );
  await renderReview(withOffers({ comments: [accepted] }));
  const enlarge = offerCard().getByRole("button", { name: "Enlarge The agent's diagram" });
  await expect.element(enlarge).toBeVisible();
  const turn = enlarge.element().closest(".border-l-2");
  expect(turn?.querySelector(".prose-fm")).toBeNull();
  expect(turn?.children[1]?.className).toBe("");
});

test("an accept the server refuses brings the chip back", async () => {
  await renderReview(withOffers());
  await chip("UploadButton as a state machine").click();
  await expect.element(chip("UploadButton as a state machine")).toBeVisible();
  await expect.element(page.getByRole("alert")).toBeVisible();
});

test("× dismisses an offer for good, from the keyboard too", async () => {
  const dismissed: OfferId = JSON.parse(`"${ON_HUNK}"`);
  const { server } = await renderReview(withOffers());
  server.on("POST", `/api/offers/${ON_HUNK}/dismiss`, () =>
    server.push({ type: "offer-dismissed", offer: dismissed }),
  );
  page.getByRole("button", { name: "Dismiss offer: Draw add as a sequence" }).element().focus();
  await userEvent.keyboard("{Enter}");

  await expect.element(chip("add as a sequence")).not.toBeInTheDocument();
  await expect.element(chip("UploadButton as a state machine")).toBeVisible();
  expect(server.calls.some((c) => c.path === `/api/offers/${ON_HUNK}/dismiss`)).toBe(true);
});

test("an offer dismissed in another tab goes away here too", async () => {
  const { server } = await renderReview(withOffers());
  await expect.element(chip("add as a sequence")).toBeVisible();
  server.push({ type: "offer-dismissed", offer: JSON.parse(`"${ON_HUNK}"`) });
  await expect.element(chip("add as a sequence")).not.toBeInTheDocument();
});

test("an offer the reviewer already answered or dismissed never shows as a chip", async () => {
  const accepted = JSON.parse(
    JSON.stringify({
      id: "c_offer1",
      anchor: { kind: "message", commit: 1 },
      context: { commitMessage: "Guard add", path: null },
      body: "Draw UploadButton as a state machine",
      createdAt: "2026-10-22T10:00:00Z",
      kind: "question",
      offer: OFFER,
    }),
  );
  await renderReview(
    withOffers({ comments: [accepted], dismissedOffers: [JSON.parse(`"${ON_HUNK}"`)] }),
  );
  await expect.element(offerCard().getByText("Waiting for the agent…")).toBeVisible();
  expect(page.getByRole("button", { name: /^Agent can draw/ }).elements()).toHaveLength(0);
});
