// Offers: where each of the agent's "I can draw this" chips sits, whether it is still open, and the
// comment that accepts one. Pure.

import type {
  NewComment,
  Offer,
  OfferId,
  ProjectedCommit,
  State,
  Unit,
  UnitId,
  WireComment,
} from "./wire.ts";

/** "Draw UploadButton as a state machine" reads "Agent can draw: UploadButton as a state machine". */
export function chipText(label: string): string {
  const thing = label.trim().replace(/^draw\s+/i, "");
  return `Agent can draw: ${thing}`;
}

/** An offer at its place: open as a chip, or accepted and shown as the thread that accepted it. */
export type Placed =
  | { readonly offer: Offer; readonly kind: "chip" }
  | { readonly offer: Offer; readonly kind: "accepted"; readonly comment: WireComment };

/**
 * The offers of a commit that sit at one place: `unit` for those above a hunk, null for those
 * under the message. One accepted in this version shows as its thread; one dismissed, or accepted
 * in an earlier version, shows nothing.
 */
export function offersAt(
  commit: ProjectedCommit,
  unit: UnitId | null,
  state: Pick<State, "comments" | "carried" | "dismissedOffers">,
  dismissed: ReadonlySet<OfferId>,
): Placed[] {
  const done = new Set<string>([...(state.dismissedOffers ?? []), ...dismissed]);
  for (const carried of state.carried ?? []) {
    const offer = carried.comment.offer;
    if (offer !== undefined) done.add(offer);
  }
  return (commit.offers ?? []).flatMap((offer): Placed[] => {
    if ((offer.unit ?? null) !== unit) return [];
    const comment = state.comments.find((c) => c.offer === offer.id);
    if (comment !== undefined) return [{ offer, kind: "accepted", comment }];
    return done.has(offer.id) ? [] : [{ offer, kind: "chip" }];
  });
}

/** Whether a comment shows as an accepted offer of this commit rather than as a plain thread. */
export function isOfferThread(commit: ProjectedCommit, comment: WireComment): boolean {
  return comment.offer !== undefined && (commit.offers ?? []).some((o) => o.id === comment.offer);
}

/**
 * The question that accepts an offer: on the hunk for a unit offer, on the message for a commit
 * offer, with the label as its words so `watch` and the report read it like any question.
 */
export function acceptance(
  offer: Offer,
  commit: ProjectedCommit,
  units: ReadonlyMap<UnitId, Unit>,
): NewComment {
  const unit = offer.unit === undefined ? undefined : units.get(offer.unit);
  return {
    kind: "question",
    offer: offer.id,
    body: offer.label,
    anchor:
      offer.unit === undefined
        ? { kind: "message", commit: commit.index }
        : { kind: "hunk", unit: offer.unit, commit: commit.index, changes: null },
    context: { commitMessage: commit.message, path: unit?.path ?? null },
  };
}

/** The agent has not answered yet: no agent reply on the thread. */
export function waiting(comment: WireComment): boolean {
  return !(comment.replies ?? []).some((r) => r.author === "agent");
}
