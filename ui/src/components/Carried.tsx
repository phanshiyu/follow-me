import { cn } from "@/lib/utils";
import type { Placement } from "../lib/carried.ts";
import { newRows, whatChanged } from "../lib/whatChanged.ts";
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
  const unit = state.units.find((u) => u.id === placement.carried.unit);
  const now = unit?.kind === "hunk" ? newRows(unit.body, placement.carried.offsets ?? []) : [];
  const diff = kind === "changed" ? whatChanged(lines, now) : null;
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
          {diff === null ? null : (
            <details open className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">What changed</summary>
              <section
                aria-label="What changed"
                className="mt-1 overflow-x-auto whitespace-pre rounded bg-muted py-1 font-mono"
              >
                {diff.lines.map((line, i) => (
                  <div
                    // Diff lines repeat; their place in the diff is their identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    key={i}
                    className={cn(
                      "px-2",
                      line.op === "+" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                      line.op === "-" && "bg-rose-500/10 text-rose-800 dark:text-rose-300",
                    )}
                  >
                    {line.op} {line.text}
                  </div>
                ))}
                {diff.more > 0 ? (
                  <div className="px-2 text-muted-foreground">… {diff.more} more</div>
                ) : null}
              </section>
            </details>
          )}
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
