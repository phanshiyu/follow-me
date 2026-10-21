import type { Placement } from "../lib/carried.ts";
import { useReview } from "../store.tsx";
import { Markdown } from "./Markdown.tsx";
import { ThreadCard } from "./Thread.tsx";

const chip = "rounded-full bg-amber-500/15 px-2 py-px text-amber-800 dark:text-amber-300";

/**
 * A thread from the previous plan version, placed in this one. Replies still go to the old
 * comment id, so the conversation carries on where the code now is.
 */
export function CarriedCard({
  placement,
  className,
}: {
  placement: Placement;
  className?: string;
}) {
  const { state } = useReview();
  const { comment, kind } = placement;
  const was = state.previous?.version;
  const lines = comment.context.lines ?? [];
  const response = state.previous?.responses.find((r) => r.comment === comment.id);
  return (
    <ThreadCard
      comment={comment}
      className={className}
      chip={
        kind === "changed" ? (
          <span className={chip}>Code changed since you asked</span>
        ) : kind === "gone" ? (
          <span className={chip}>This code is gone in v{state.version}</span>
        ) : undefined
      }
      extra={
        <>
          {kind !== "same" && lines.length > 0 ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                What you commented on, in v{was}
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono">
                {lines.join("\n")}
              </pre>
            </details>
          ) : null}
          {response === undefined ? null : (
            <div className="mt-3 border-l-2 border-sky-500/60 pl-3">
              <div className="mb-1 font-medium text-xs">Agent</div>
              <Markdown text={response.note} />
            </div>
          )}
        </>
      }
    />
  );
}
