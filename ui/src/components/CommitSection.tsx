import { bodyOf, filesOf, noteOf, titleOf } from "../lib/commit.ts";
import type { ProjectedCommit, Unit } from "../lib/wire.ts";
import { useDerived, useReview } from "../store.tsx";
import { Hunk } from "./Hunk.tsx";

function describeUnit(unit: Exclude<Unit, { kind: "hunk" }>): string {
  if (unit.kind === "mode") return `mode change ${unit.from} → ${unit.to}`;
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.reason} file ${change}`;
}

export function CommitSection({ commit }: { commit: ProjectedCommit }) {
  const { state } = useReview();
  const { units } = useDerived();
  const body = bodyOf(commit.message);
  const note = noteOf(commit);
  const files = filesOf(commit, units);
  return (
    <section
      id={`commit-${commit.index + 1}`}
      data-commit={commit.index}
      aria-labelledby={`commit-${commit.index + 1}-title`}
      className="scroll-mt-11 pb-10"
    >
      <header className="sticky top-11 z-20 -mx-6 flex h-11 items-center gap-3 border-b bg-background/95 px-6 backdrop-blur">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs tabular-nums">
          {commit.index + 1}
        </span>
        <h2 id={`commit-${commit.index + 1}-title`} className="min-w-0 truncate font-semibold">
          {titleOf(commit.message)}
        </h2>
        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
          {commit.index + 1} of {state.commits.length}
        </span>
      </header>
      <div className="space-y-4 pt-4">
        {body === "" ? null : (
          <p className="max-w-[72ch] whitespace-pre-wrap text-sm leading-6">{body}</p>
        )}
        {note === null ? null : (
          <div className="max-w-[72ch] text-sm leading-6">
            <div className="mb-0.5 font-medium text-muted-foreground text-xs">Agent's note</div>
            <p className="whitespace-pre-wrap text-muted-foreground">{note}</p>
          </div>
        )}
        {files.map((file) => (
          <div key={file.path} className="space-y-2">
            <div className="flex items-center gap-2 pt-2 font-mono text-sm">
              <span className="font-medium">{file.path}</span>
            </div>
            {file.parts.map(({ ref, unit }) =>
              unit.kind === "hunk" ? (
                <div key={ref.unit} className="space-y-2">
                  {ref.narration?.trim() ? (
                    <p className="max-w-[72ch] text-muted-foreground text-sm">
                      {ref.narration.trim()}
                    </p>
                  ) : null}
                  <Hunk hunk={unit} commit={commit.index} />
                </div>
              ) : (
                <div
                  key={ref.unit}
                  className="rounded-lg border bg-card px-3 py-2 text-muted-foreground text-sm"
                >
                  {describeUnit(unit)}
                </div>
              ),
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
