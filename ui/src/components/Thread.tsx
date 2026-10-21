import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import type { WireComment } from "../lib/wire.ts";
import { usePage } from "../page.tsx";
import { useReview } from "../store.tsx";
import { CommentBox } from "./CommentBox.tsx";
import { SeverityChip } from "./Severity.tsx";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** Card chrome shared by threads, concerns and answers: indented to the code column. */
export function Card({
  children,
  className,
  label,
  open = false,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
  /** An unresolved thread, which `u` steps through. */
  open?: boolean;
}) {
  return (
    <article
      aria-label={label}
      data-open-thread={open ? "" : undefined}
      className={cn(
        "my-2 ml-24 max-w-[760px] rounded-lg border bg-card p-3 font-sans text-sm shadow-xs",
        className,
      )}
    >
      {children}
    </article>
  );
}

export function Text({ children }: { children: string }) {
  return <p className="max-w-[72ch] whitespace-pre-wrap leading-6">{children}</p>;
}

function who(comment: WireComment): string {
  if (comment.author === "agent") return "Agent";
  return comment.kind === "question" ? "You asked" : "You flagged";
}

/** A thread inline under its lines: the opening words, the replies, Reply and Resolve. */
export function ThreadCard({ comment, className }: { comment: WireComment; className?: string }) {
  const { run } = useReview();
  const { resolved, setLocallyResolved } = usePage();
  const [replying, setReplying] = useState(false);
  if (resolved.has(comment.id)) {
    return (
      <Card
        label="Resolved thread"
        className="flex items-center gap-2 py-1.5 text-muted-foreground"
      >
        <span className="min-w-0 truncate">✓ Resolved · {firstLine(comment.body)}</span>
        <Button
          variant="link"
          size="xs"
          className="ml-auto"
          onClick={() => setLocallyResolved(comment.id, false)}
        >
          Reopen
        </Button>
      </Card>
    );
  }
  return (
    <Card
      label={comment.kind === "question" ? "Question thread" : "Thread"}
      className={className}
      open
    >
      <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{who(comment)}</span>
        {comment.severity === undefined ? null : <SeverityChip severity={comment.severity} />}
        {comment.pending ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-px text-amber-800 dark:text-amber-300">
            Pending
          </span>
        ) : null}
      </div>
      <Text>{comment.body}</Text>
      {(comment.replies ?? []).map((reply) => (
        <div key={reply.id} className="mt-3 border-l-2 pl-3">
          <div className="mb-1 font-medium text-xs">
            {reply.author === "agent" ? "Agent" : "You"}
          </div>
          <Text>{reply.body}</Text>
        </div>
      ))}
      {replying ? (
        <CommentBox
          className="mt-3 shadow-none"
          kind="ask"
          kinds={false}
          label="Reply"
          placeholder="Reply to the agent"
          onCancel={() => setReplying(false)}
          actions={() => [
            { label: "Reply", primary: true, run: (d) => run(() => api.reply(comment.id, d.body)) },
          ]}
        />
      ) : (
        <div className="mt-2 flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setReplying(true)}>
            Reply
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setLocallyResolved(comment.id, true)}>
            Resolve
          </Button>
          {comment.pending ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void run(() => api.remove(comment.id))}
            >
              Discard
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
