import { expect, test } from "vitest";
import {
  aComment,
  aCommit,
  aHunk,
  anOffer,
  aReply,
  aState,
  HUNK,
  OFFER,
} from "../test/factories.ts";
import { acceptance, chipText, isOfferThread, offersAt, waiting } from "./offers.ts";
import type { OfferId, Unit, UnitId } from "./wire.ts";

const hunk: UnitId = JSON.parse(`"${HUNK}"`);
const offerId: OfferId = JSON.parse(`"${OFFER}"`);
const onCommit = anOffer();
const onHunk = anOffer({
  id: JSON.parse(`"o_00000002"`),
  label: "Draw add as a sequence",
  unit: hunk,
});
const commit = aCommit(1, { message: "Guard add", offers: [onCommit, onHunk] });
const none = new Set<OfferId>();
const accepted = aComment({ id: JSON.parse('"c_offer1"'), offer: offerId });

test("the chip names the thing to draw after the words the page adds", () => {
  expect(chipText("Draw UploadButton as a state machine")).toBe(
    "Agent can draw: UploadButton as a state machine",
  );
  expect(chipText("The upload flow")).toBe("Agent can draw: The upload flow");
});

test("a commit offer sits under the message and a unit offer above its hunk", () => {
  const state = aState();
  expect(offersAt(commit, null, state, none)).toEqual([{ offer: onCommit, kind: "chip" }]);
  expect(offersAt(commit, hunk, state, none)).toEqual([{ offer: onHunk, kind: "chip" }]);
  expect(offersAt(commit, JSON.parse('"h_other"'), state, none)).toEqual([]);
});

test("an accepted offer shows as its thread, and a dismissed one shows nothing", () => {
  expect(offersAt(commit, null, aState({ comments: [accepted] }), none)).toEqual([
    { offer: onCommit, kind: "accepted", comment: accepted },
  ]);
  expect(offersAt(commit, null, aState({ dismissedOffers: [offerId] }), none)).toEqual([]);
  expect(offersAt(commit, null, aState(), new Set([offerId]))).toEqual([]);
});

test("an offer accepted in an earlier version does not come back as a chip", () => {
  const carried = JSON.parse(
    JSON.stringify({ comment: accepted, version: 1, place: null, changed: false }),
  );
  expect(offersAt(commit, null, aState({ carried: [carried] }), none)).toEqual([]);
});

test("a thread is an offer's only while the commit still carries that offer", () => {
  expect(isOfferThread(commit, accepted)).toBe(true);
  expect(isOfferThread(aCommit(1), accepted)).toBe(false);
  expect(isOfferThread(commit, aComment())).toBe(false);
});

test("accepting asks a question on the message, or on the whole hunk for a unit offer", () => {
  const units = new Map<UnitId, Unit>([[hunk, aHunk()]]);
  expect(acceptance(onCommit, commit, units)).toEqual({
    kind: "question",
    offer: OFFER,
    body: "Draw UploadButton as a state machine",
    anchor: { kind: "message", commit: 1 },
    context: { commitMessage: "Guard add", path: null },
  });
  expect(acceptance(onHunk, commit, units)).toEqual({
    kind: "question",
    offer: "o_00000002",
    body: "Draw add as a sequence",
    anchor: { kind: "hunk", unit: HUNK, commit: 1, changes: null },
    context: { commitMessage: "Guard add", path: "src/lib.js" },
  });
});

test("the card waits until the agent replies", () => {
  expect(waiting(accepted)).toBe(true);
  expect(waiting({ ...accepted, replies: [aReply({ author: "reviewer" })] })).toBe(true);
  expect(waiting({ ...accepted, replies: [aReply()] })).toBe(false);
});
