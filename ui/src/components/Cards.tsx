import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { type AnswerCard as Answer, askAgain } from "../lib/answers.ts";
import { api } from "../lib/api.ts";
import type { PlacedConcern, Severity } from "../lib/wire.ts";
import { scrollToCommit } from "../page.tsx";
import { useReview } from "../store.tsx";
import { CommentBox } from "./CommentBox.tsx";
import { Markdown } from "./Markdown.tsx";
import { SEVERITIES, SeverityChip } from "./Severity.tsx";
import { Card, Text } from "./Thread.tsx";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** The agent's concern as a review comment it would leave: Keep makes it a flag, Dismiss folds it. */
export function ConcernCard({
  concern,
  className,
}: {
  concern: PlacedConcern;
  className?: string;
}) {
  const { state, run } = useReview();
  const decision = state.concerns.find((d) => d.concern === concern.id);
  const [picked, setPicked] = useState<Severity | null>(null);
  const severity = decision?.severity ?? picked ?? concern.severity;
  const decide = (verdict: "kept" | "dismissed", level: Severity = severity) =>
    run(() => api.decide(concern.id, verdict, level === concern.severity ? undefined : level));
  if (decision?.decision === "dismissed") {
    return (
      <Card
        label="Dismissed concern"
        className={cn("flex items-center gap-2 py-1.5 text-muted-foreground", className)}
      >
        <span className="min-w-0 truncate">Dismissed · {firstLine(concern.text)}</span>
        <Button variant="link" size="xs" className="ml-auto" onClick={() => void decide("kept")}>
          Keep instead
        </Button>
      </Card>
    );
  }
  const kept = decision?.decision === "kept";
  return (
    <Card
      label="Agent concern"
      open={!kept}
      className={cn(kept ? "border-amber-500/40" : "border-dashed border-amber-500/60", className)}
    >
      <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">Agent flagged</span>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`Severity ${severity}`} className="rounded-full">
            <SeverityChip severity={severity} />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-32">
            {SEVERITIES.map((level) => (
              <DropdownMenuItem
                key={level}
                onSelect={() => (kept ? void decide("kept", level) : setPicked(level))}
              >
                {level}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span>{concern.kind}</span>
        {kept ? (
          <span className="ml-auto text-amber-700 dark:text-amber-300">Kept · in your review</span>
        ) : null}
      </div>
      <Text>{concern.text}</Text>
      <div className="mt-2 flex gap-1">
        {kept ? null : (
          <Button size="xs" onClick={() => void decide("kept")}>
            Keep
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => void decide("dismissed")}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}

function statusOf(card: Answer): string {
  const status = card.response?.status;
  if (status === "answered") return "Answered";
  if (status === "deferred") return "Deferred";
  if (status === undefined) return "Not answered";
  return "Answered by changing the plan";
}

/** A question from the previous version with the agent's answer, where the answer now lives. */
export function AnswerCard({ card, className }: { card: Answer; className?: string }) {
  const { state, run } = useReview();
  const [asking, setAsking] = useState(false);
  const { comment, response, place } = card;
  const resolve = (resolved: boolean) => run(() => api.resolve(card.id, resolved));
  if (card.resolved) {
    return (
      <Card
        label="Resolved answer"
        className={cn("flex items-center gap-2 py-1.5 text-muted-foreground", className)}
      >
        <span className="min-w-0 truncate">✓ Resolved · {firstLine(comment.body)}</span>
        <Button variant="link" size="xs" className="ml-auto" onClick={() => void resolve(false)}>
          Reopen
        </Button>
      </Card>
    );
  }
  const lines = comment.context.lines ?? [];
  return (
    <Card label="Answer to your question" open className={className}>
      <div className="mb-1 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">You asked</span> in v{state.previous?.version}{" "}
        · {statusOf(card)}
      </div>
      <Text>{comment.body}</Text>
      {lines.length > 0 ? (
        <pre className="mt-2 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
          {lines.join("\n")}
        </pre>
      ) : null}
      {response === null ? null : (
        <div className="mt-3 border-l-2 border-sky-500/60 pl-3">
          <div className="mb-1 font-medium text-xs">Agent</div>
          <Markdown text={response.note} />
        </div>
      )}
      {place === null && comment.anchor.kind === "hunk" ? (
        <p className="mt-2 text-muted-foreground text-xs">
          The code you asked about has changed since.
        </p>
      ) : null}
      {(place?.continues ?? []).map((index) => (
        <Button key={index} variant="link" size="xs" onClick={() => scrollToCommit(index)}>
          continues in commit {index + 1}
        </Button>
      ))}
      {asking ? (
        <CommentBox
          className="mt-3 shadow-none"
          kind="ask"
          kinds={false}
          label="Ask again"
          placeholder="What is still unclear?"
          onCancel={() => setAsking(false)}
          actions={() => [
            {
              label: "Ask again",
              primary: true,
              run: (d) => run(() => api.comment(askAgain(card, d.body))),
            },
          ]}
        />
      ) : (
        <div className="mt-2 flex gap-1">
          <Button size="xs" onClick={() => void resolve(true)}>
            Resolve
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setAsking(true)}>
            Ask again
          </Button>
        </div>
      )}
    </Card>
  );
}
