import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cardsAt } from "../lib/answers.ts";
import { api } from "../lib/api.ts";
import { bodyOf, filesOf, noteOf, titleOf } from "../lib/commit.ts";
import { type BoxKind, composeComment, type Draft } from "../lib/compose.ts";
import type { ProjectedCommit, Unit } from "../lib/wire.ts";
import { usePage } from "../page.tsx";
import { useAnswers, useDerived, useReview } from "../store.tsx";
import { AnswerCard, ConcernCard } from "./Cards.tsx";
import { Check } from "./Check.tsx";
import { CommentBox } from "./CommentBox.tsx";
import { Diagram } from "./Diagram.tsx";
import { boxActions, Hunk } from "./Hunk.tsx";
import { ThreadCard } from "./Thread.tsx";

function describeUnit(unit: Exclude<Unit, { kind: "hunk" }>): string {
  if (unit.kind === "mode") return `mode change ${unit.from} → ${unit.to}`;
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.reason} file ${change}`;
}

export function CommitSection({ commit }: { commit: ProjectedCommit }) {
  const { state, run } = useReview();
  const { units } = useDerived();
  const answers = useAnswers();
  const shownUnits = commit.refs.map((r) => r.unit);
  const [box, setBox] = useState<{ anchor: "message" | "position"; kind: BoxKind } | null>(null);
  const said = state.comments.filter(
    (c) =>
      (c.anchor.kind === "message" || c.anchor.kind === "position") &&
      c.anchor.commit === commit.index,
  );
  const post = (anchor: "message" | "position") => (pending: boolean, draft: Draft) =>
    run(() =>
      api.comment(
        composeComment(
          { kind: anchor, commit: commit.index },
          { commitMessage: commit.message, path: null },
          draft,
          pending,
        ),
      ),
    );
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More on commit ${commit.index + 1}`}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setBox({ anchor: "message", kind: "ask" })}>
              Comment on message
            </DropdownMenuItem>
            {state.mode === "split" ? (
              <DropdownMenuItem onSelect={() => setBox({ anchor: "position", kind: "flag" })}>
                Move this commit…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
          {commit.diagram?.trim() ? (
            <Diagram source={commit.diagram} title={`Diagram of commit ${commit.index + 1}`} />
          ) : null}
          {cardsAt(answers, commit.index, null, shownUnits).map((card) => (
            <AnswerCard key={card.id} card={card} className="ml-0" />
          ))}
          {(commit.concerns ?? [])
            .filter((k) => k.unit === undefined || units.get(k.unit)?.kind !== "hunk")
            .map((concern) => (
              <ConcernCard key={concern.id} concern={concern} className="ml-0" />
            ))}
          {said.map((comment) => (
            <ThreadCard key={comment.id} comment={comment} className="ml-0" />
          ))}
          {box === null ? null : (
            <CommentBox
              className="max-w-[760px]"
              kind={box.kind}
              label={
                box.anchor === "message" ? "Comment on the message" : "Where should this commit go?"
              }
              onCancel={() => setBox(null)}
              actions={boxActions(post(box.anchor))}
            />
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
                          {ref.diagram?.trim() ? (
                            <Diagram source={ref.diagram} title={`Diagram of ${unit.path}`} />
                          ) : null}
                          {cardsAt(answers, commit.index, unit.id, shownUnits).map((card) => (
                            <AnswerCard key={card.id} card={card} className="ml-0" />
                          ))}
                          <Hunk hunk={unit} commit={commit} />
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
