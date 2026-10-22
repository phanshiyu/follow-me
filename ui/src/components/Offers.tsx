import { WorkflowIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../lib/api.ts";
import { acceptance, chipText, offersAt, waiting } from "../lib/offers.ts";
import type { Offer, OfferId, ProjectedCommit, UnitId } from "../lib/wire.ts";
import { useDerived, useReview } from "../store.tsx";
import { Card, Text, ThreadCard } from "./Thread.tsx";

/** Where the agent's diagram will land, at the width it will take. */
function Waiting() {
  return (
    <div role="status" className="mt-2">
      <p className="mb-2 text-muted-foreground text-xs">Waiting for the agent…</p>
      <div aria-hidden className="h-40 animate-pulse rounded-lg border bg-muted/60" />
    </div>
  );
}

function Chip({
  offer,
  onAccept,
  onDismiss,
}: {
  offer: Offer;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex max-w-[760px] items-center gap-1 rounded-md border border-dashed py-0.5 pr-0.5 pl-2 text-muted-foreground text-sm">
      <button
        type="button"
        title="Ask the agent to draw it"
        onClick={onAccept}
        className="flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <WorkflowIcon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{chipText(offer.label)}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Dismiss offer: ${offer.label}`}
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * The agent's offers at one place: under the message for `unit` null, above the hunk otherwise.
 * A chip turns into its question thread in place; × waves it away for good.
 */
export function Offers({ commit, unit }: { commit: ProjectedCommit; unit: UnitId | null }) {
  const { state, run, refresh } = useReview();
  const { units } = useDerived();
  const [dismissed, setDismissed] = useState<ReadonlySet<OfferId>>(new Set());
  const [accepting, setAccepting] = useState<ReadonlySet<OfferId>>(new Set());
  const placed = offersAt(commit, unit, state, dismissed);
  if (placed.length === 0) return null;
  const accept = async (offer: Offer) => {
    setAccepting((before) => new Set([...before, offer.id]));
    const ok = await run(() => api.comment(acceptance(offer, commit, units)));
    if (!ok) setAccepting((before) => new Set([...before].filter((id) => id !== offer.id)));
  };
  const dismiss = async (offer: Offer) => {
    setDismissed((before) => new Set([...before, offer.id]));
    const ok = await run(() => api.dismissOffer(offer.id));
    if (ok) await refresh().catch(() => undefined);
    else setDismissed((before) => new Set([...before].filter((id) => id !== offer.id)));
  };
  return placed.map((p) => {
    const label = `Offer: ${p.offer.label}`;
    if (p.kind === "accepted") {
      return (
        <ThreadCard
          key={p.offer.id}
          comment={p.comment}
          label={label}
          className="ml-0 max-w-none"
          extra={waiting(p.comment) ? <Waiting /> : null}
        />
      );
    }
    if (accepting.has(p.offer.id)) {
      return (
        <Card key={p.offer.id} label={label} className="ml-0 max-w-none">
          <div className="mb-1 font-medium text-xs">You asked</div>
          <Text>{p.offer.label}</Text>
          <Waiting />
        </Card>
      );
    }
    return (
      <Chip
        key={p.offer.id}
        offer={p.offer}
        onAccept={() => void accept(p.offer)}
        onDismiss={() => void dismiss(p.offer)}
      />
    );
  });
}
