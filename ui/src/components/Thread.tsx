import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import type { WireComment } from "../lib/wire.ts";
import { usePage } from "../page.tsx";
import { useReview } from "../store.tsx";
import { CommentBox } from "./CommentBox.tsx";
import { Diagram } from "./Diagram.tsx";
import { Markdown } from "./Markdown.tsx";
import { SeverityChip } from "./Severity.tsx";
import { StateMachine } from "./StateMachine.tsx";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** Card chrome shared by threads, concerns and answers: indented to the code column. */
export function Card({
  children,
  className,
  label,
  open = false,
  threadId,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
  /** An unresolved thread, which `u` steps through. */
  open?: boolean;
  /** The comment this card shows, so a notification can find and flash it. */
  threadId?: string;
}) {
  return (
    <article
      aria-label={label}
      data-open-thread={open ? "" : undefined}
      data-thread-id={threadId}
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
export function ThreadCard({
  comment,
  className,
  chip,
  extra,
  label,
}: {
  comment: WireComment;
  className?: string;
  /** The card's accessible name, when the kind of thread does not say enough. */
  label?: string;
  /** A tag beside the author, such as "Code changed since you asked". */
  chip?: ReactNode;
  /** Shown under the opening words, above the replies. */
  extra?: ReactNode;
}) {
  const { run } = useReview();
  const { resolved, setLocallyResolved } = usePage();
  const [replying, setReplying] = useState(false);
  const { unread, markSeen } = useReview();
  const mine = unread.filter((n) => n.thread === comment.id).map((n) => n.key);
  const watched = mine.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: watched stands for mine
  useEffect(() => {
    if (mine.length === 0) return;
    const card = document.querySelector(`[data-thread-id="${CSS.escape(comment.id)}"]`);
    if (card === null) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (!document.hidden && entries.some((e) => e.isIntersecting)) markSeen(mine);
      },
      { threshold: 0.6 },
    );
    watch.observe(card);
    return () => watch.disconnect();
  }, [watched, comment.id, markSeen]);
  if (resolved.has(comment.id)) {
    return (
      <Card
        label="Resolved thread"
        threadId={comment.id}
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
      label={label ?? (comment.kind === "question" ? "Question thread" : "Thread")}
      className={className}
      threadId={comment.id}
      open
    >
      <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{who(comment)}</span>
        {comment.severity === undefined ? null : <SeverityChip severity={comment.severity} />}
        {chip}
      </div>
      {comment.author === "agent" ? <Markdown text={comment.body} /> : <Text>{comment.body}</Text>}
      {comment.diagram === undefined ? null : (
        <div className="mt-2">
          <Diagram source={comment.diagram} title="The agent's diagram" />
        </div>
      )}
      {extra}
      {(comment.replies ?? []).map((reply) => (
        <div
          key={reply.id}
          className={cn("mt-3 border-l-2 pl-3", reply.author === "agent" && "border-sky-500/60")}
        >
          <div className="mb-1 font-medium text-xs">
            {reply.author === "agent" ? "Agent" : "You"}
          </div>
          {reply.author === "agent" ? <Markdown text={reply.body} /> : <Text>{reply.body}</Text>}
          {reply.diagram === undefined ? null : (
            <div className="mt-2">
              {reply.map === undefined ? (
                <Diagram source={reply.diagram} title="The agent's diagram" />
              ) : (
                <StateMachine
                  source={reply.diagram}
                  map={reply.map}
                  from={comment.anchor.kind === "plan" ? 0 : comment.anchor.commit}
                  title="The agent's state machine"
                />
              )}
            </div>
          )}
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
        </div>
      )}
    </Card>
  );
}
