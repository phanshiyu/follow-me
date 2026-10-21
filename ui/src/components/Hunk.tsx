import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { hunkHeader } from "../lib/commit.ts";
import type { Span } from "../lib/highlight.ts";
import { type LineNumber, ownersOf, rowsOf, scopeOf } from "../lib/rows.ts";
import { useSpans } from "../lib/useSpans.ts";
import type { HunkLine, TextHunk } from "../lib/wire.ts";
import { useDerived } from "../store.tsx";

export function scrollToCommit(index: number): void {
  document.getElementById(`commit-${index + 1}`)?.scrollIntoView({ block: "start" });
}

function Code({ line, spans }: { line: HunkLine; spans: Span[] | undefined }) {
  const text = line.text.replace(/\n$/, "");
  if (spans === undefined) return <>{text}</>;
  return (
    <>
      {spans.map((span, i) => (
        // Spans have no identity beyond their position in the row.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <span key={i} className={span.tone === null ? undefined : `tok-${span.tone}`}>
          {span.text}
        </span>
      ))}
    </>
  );
}

function folded(count: number, commit: number): string {
  return `${count} line${count === 1 ? "" : "s"} arrive${count === 1 ? "s" : ""} in commit ${commit + 1}`;
}

/**
 * One hunk as one commit shows it. The commit's own rows are the change, earlier commits' lines
 * read as context, later ones fold into a row that links down the page. Long lines wrap rather
 * than scroll, so the cards under a row and the buttons at its right edge stay in view.
 */
export function Hunk({
  hunk,
  commit,
  under,
}: {
  hunk: TextHunk;
  commit: number;
  /** Cards that sit under a row, keyed by body index. */
  under?: ReadonlyMap<number, ReactNode>;
}) {
  const { owners, numbers } = useDerived();
  const spans = useSpans(hunk);
  const own = ownersOf(hunk, owners);
  const rows = rowsOf(hunk.body, own, commit);
  const at: readonly LineNumber[] = numbers.get(hunk.id) ?? [];
  const first = rows.find((r) => r.kind === "line" && r.mine);
  const scope = first?.kind === "line" ? scopeOf(hunk.body, first.line) : null;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div
        className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1 font-mono text-muted-foreground text-xs"
        title={hunk.id}
      >
        <span>{hunkHeader(at)}</span>
        {scope === null ? null : <span className="text-foreground/80">{scope}</span>}
      </div>
      <div className="font-mono text-[12.5px] leading-5">
        {rows.map((row) => {
          if (row.kind === "fold") {
            return (
              <button
                key={`fold-${row.lines[0]}`}
                type="button"
                className="block w-full bg-muted/40 px-3 py-0.5 text-left font-sans text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
                onClick={() => scrollToCommit(row.commit)}
              >
                ⋯ {folded(row.lines.length, row.commit)}
              </button>
            );
          }
          const line = hunk.body[row.line];
          if (line === undefined) return null;
          const n = at[row.line];
          const op = row.mine ? line.op : " ";
          return (
            <div key={row.line}>
              <div
                data-row={row.line}
                className={cn(
                  "group relative flex",
                  op === "+" && "bg-emerald-500/10",
                  op === "-" && "bg-rose-500/10",
                )}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">
                  {n?.old ?? ""}
                </span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">
                  {n?.new ?? ""}
                </span>
                <span
                  className={cn(
                    "w-5 shrink-0 select-none text-center",
                    op === "+" && "text-emerald-700 dark:text-emerald-400",
                    op === "-" && "text-rose-700 dark:text-rose-400",
                  )}
                >
                  {op}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap pr-6 [overflow-wrap:anywhere]">
                  <Code line={line} spans={spans?.[row.line]} />
                </span>
              </div>
              {under?.get(row.line)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
