import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../lib/api.ts";
import { titleOf } from "../lib/commit.ts";
import { navigate } from "../lib/route.ts";
import { useReview } from "../store.tsx";
import { SeverityChip } from "./Severity.tsx";

/**
 * Submit review: an optional summary and the concerns nobody decided. Submitting finishes the
 * review and opens the hand-off page. Comments are not held back, so it sends none.
 */
export function SubmitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, run, refresh } = useReview();
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const decided = new Set(state.concerns.map((d) => d.concern));
  const undecided = state.commits.flatMap((c) =>
    (c.concerns ?? []).filter((k) => !decided.has(k.id)).map((k) => ({ concern: k, commit: c })),
  );
  const decideAll = (decision: "kept" | "dismissed") =>
    run(async () => {
      for (const { concern } of undecided) await api.decide(concern.id, decision);
    });
  const submit = async () => {
    setBusy(true);
    const ok = await run(() => api.submit(summary));
    setBusy(false);
    if (!ok) return;
    await refresh().catch(() => undefined);
    onOpenChange(false);
    navigate("report");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit review</DialogTitle>
          <DialogDescription>
            Your flags and questions already reached the agent. Submitting finishes the review and
            opens the hand-off.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Summary"
          placeholder="Summary for the agent (optional)"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
        {undecided.length === 0 ? null : (
          <div className="space-y-2">
            <div className="font-medium text-sm">
              {undecided.length} agent concern{undecided.length === 1 ? "" : "s"} undecided
            </div>
            <ul className="max-h-48 space-y-1.5 overflow-y-auto text-sm">
              {undecided.map(({ concern, commit }) => (
                <li key={concern.id} className="flex items-start gap-2">
                  <SeverityChip severity={concern.severity} />
                  <span className="min-w-0">
                    {concern.text}
                    <span className="text-muted-foreground"> · {titleOf(commit.message)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void decideAll("kept")}>
                Keep all
              </Button>
              <Button size="sm" variant="outline" onClick={() => void decideAll("dismissed")}>
                Dismiss all
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Undecided concerns are left out of the report.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Go back
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            Submit review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
