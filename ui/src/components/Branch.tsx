import { MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { answeredCount } from "../lib/answers.ts";
import { api } from "../lib/api.ts";
import { composeComment, type Draft } from "../lib/compose.ts";
import { commitStats } from "../lib/rows.ts";
import { useAnswers, useDerived, useReview } from "../store.tsx";
import { AnswerCard } from "./Cards.tsx";
import { CommentBox } from "./CommentBox.tsx";
import { boxActions } from "./Hunk.tsx";
import { ThreadCard } from "./Thread.tsx";

function usePostOnBranch() {
  const { run } = useReview();
  return (pending: boolean, draft: Draft) =>
    run(() =>
      api.comment(
        composeComment({ kind: "plan" }, { commitMessage: "", path: null }, draft, pending),
      ),
    );
}

/** "Ask about the branch": a question or flag on no line in particular, from the header. */
export function AskBranch() {
  const [open, setOpen] = useState(false);
  const post = usePostOnBranch();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <MessageCircleQuestionIcon />
          <span className="hidden xl:inline">Ask about the branch</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-0">
        <CommentBox
          className="border-0 shadow-none"
          kind="ask"
          label="About the whole branch"
          onCancel={() => setOpen(false)}
          actions={boxActions(post)}
        />
      </PopoverContent>
    </Popover>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What the branch is at a glance, what the agent answered, and talk about no line in particular. */
export function BranchSummary() {
  const { state } = useReview();
  const { units, owners } = useDerived();
  const answers = useAnswers();
  const files = new Set(state.units.map((u) => u.path)).size;
  const lines = state.commits
    .map((c) => commitStats(c, units, owners))
    .reduce((sum, s) => ({ added: sum.added + s.added, removed: sum.removed + s.removed }), {
      added: 0,
      removed: 0,
    });
  const { answered, asked } = answeredCount(state.previous);
  const general = state.comments.filter((c) => c.anchor.kind === "plan");
  const homeless = answers.filter((a) => a.place === null);
  const firstOpen = () =>
    document
      .querySelector('[aria-label="Answer to your question"]')
      ?.scrollIntoView({ block: "center" });
  return (
    <section aria-label="Branch" className="space-y-3 py-6">
      <p className="text-muted-foreground text-sm">
        {plural(state.commits.length, "commit")} · {plural(files, "file")} ·{" "}
        <span className="text-emerald-700 dark:text-emerald-400">+{lines.added}</span>{" "}
        <span className="text-rose-700 dark:text-rose-400">−{lines.removed}</span>
        {asked === 0 ? null : (
          <>
            {" "}
            · v{state.version} answers {answered} of your {plural(asked, "question")}{" "}
            <Button variant="link" size="xs" className="h-auto p-0" onClick={firstOpen}>
              first answer →
            </Button>
          </>
        )}
      </p>
      {general.length + homeless.length === 0 ? null : (
        <div className="space-y-2">
          <h2 className="font-medium text-sm">Branch discussion</h2>
          {homeless.map((card) => (
            <AnswerCard key={card.id} card={card} className="ml-0" />
          ))}
          {general.map((comment) => (
            <ThreadCard key={comment.id} comment={comment} className="ml-0" />
          ))}
        </div>
      )}
    </section>
  );
}
