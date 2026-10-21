import { bodyOf, filesOf, noteOf, titleOf } from "../lib/commit.ts";
import type { ProjectedCommit, Unit } from "../lib/wire.ts";
import { usePage } from "../page.tsx";
import { useDerived } from "../store.tsx";
import { Check } from "./Check.tsx";
import { Hunk } from "./Hunk.tsx";

function describeUnit(unit: Exclude<Unit, { kind: "hunk" }>): string {
  if (unit.kind === "mode") return `mode change ${unit.from} → ${unit.to}`;
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.reason} file ${change}`;
}

export function CommitSection({ commit }: { commit: ProjectedCommit }) {
  const { units } = useDerived();
  const { isViewed, setViewed, isFileViewed, setFileViewed } = usePage();
  const viewed = isViewed(commit);
  const label = `commit-${commit.index + 1}`;
  const body = bodyOf(commit.message);
  const note = noteOf(commit);
  const files = filesOf(commit, units);
  return (
    <section
      id={label}
      data-commit={commit.index}
      aria-labelledby={`commit-${commit.index + 1}-title`}
      // The last section fills the viewport so that every commit can scroll to the top.
      className="scroll-mt-11 pb-10 last:min-h-[calc(100vh-44px)]"
    >
      <header className="sticky top-11 z-20 -mx-6 flex h-11 items-center gap-3 border-b bg-background/95 px-6 backdrop-blur">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs tabular-nums">
          {commit.index + 1}
        </span>
        <h2 id={`commit-${commit.index + 1}-title`} className="min-w-0 truncate font-semibold">
          {titleOf(commit.message)}
        </h2>
        <Check
          className="ml-auto"
          checked={viewed}
          onChange={(on) => setViewed(commit, on)}
          name={`Viewed commit ${commit.index + 1}`}
        >
          Viewed
        </Check>
      </header>
      {viewed ? null : (
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
          {files.map((file) => {
            const fileViewed = isFileViewed(commit, file.path);
            return (
              <div key={file.path} className="space-y-2">
                <div className="flex items-center gap-2 pt-2 text-sm">
                  <span className="font-medium font-mono">{file.path}</span>
                  <Check
                    className="ml-auto"
                    checked={fileViewed}
                    onChange={(on) => setFileViewed(commit, file.path, on)}
                    name={`Viewed ${file.path} in commit ${commit.index + 1}`}
                  >
                    Viewed
                  </Check>
                </div>
                {fileViewed
                  ? null
                  : file.parts.map(({ ref, unit }) =>
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
            );
          })}
        </div>
      )}
    </section>
  );
}
