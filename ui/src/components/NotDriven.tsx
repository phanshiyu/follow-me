import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import { composeComment, type Draft } from "../lib/compose.ts";
import type { Sequence } from "../lib/stateMachine.ts";
import { useReview } from "../store.tsx";
import { CommentBox } from "./CommentBox.tsx";

/** How many sequences show before "+N more". */
const SHOWN = 3;

const ORDER_NOTE =
  '"Drives" means one test covers every step; lcov per test does not record their order.';

/** "Idle → Loading → Failed". */
export function sequenceLabel(sequence: Sequence): string {
  return sequence.states.join(" → ");
}

/** The body a Flag as missing test box starts with for a sequence. */
export function missingSequenceDraft(sequence: Sequence): string {
  return `Missing test: no single test drives ${sequenceLabel(sequence)}; each step has its own test.`;
}

/** Posts a comment on the commit message, as the commit's own Comment menu does. */
function usePostOnCommit(commit: number): (draft: Draft) => Promise<boolean> {
  const { state, run } = useReview();
  const message = state.commits.find((c) => c.index === commit)?.message ?? "";
  return (draft) =>
    run(() =>
      api.comment(
        composeComment({ kind: "message", commit }, { commitMessage: message, path: null }, draft),
      ),
    );
}

/** What Ask the agent sends when the run has no per-test detail. */
export const PER_TEST_ASK =
  "Paths and sequences need one coverage run per test. Please run the tests one at a time with coverage and pass each run with `follow-me coverage <lcov> --test <id>`.";

/**
 * Under a state machine marked from an aggregate run: says what per-test runs would add, and asks
 * the agent for them as a question, so the request goes through the normal thread loop.
 */
export function PerTestAsk({ commit }: { commit: number }) {
  const post = usePostOnCommit(commit);
  const [asked, setAsked] = useState(false);
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
      <span>Paths and sequences need one coverage run per test.</span>
      {asked ? (
        <span>Asked the agent.</span>
      ) : (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs"
          onClick={async () => {
            if (await post({ body: PER_TEST_ASK, kind: "ask", severity: null })) setAsked(true);
          }}
        >
          Ask the agent
        </Button>
      )}
    </p>
  );
}

/**
 * The sequences from the initial state each step of which has a test but no one test takes whole,
 * shortest first. Show outlines one on the diagram while hovered or focused, and keeps it there
 * when pressed; Flag as missing test opens a flag box on the commit with the sequence as its body.
 */
export function NotDriven({
  sequences,
  shown,
  pinned,
  onHover,
  onPin,
  commit,
}: {
  sequences: readonly Sequence[];
  /** The sequence outlined on the diagram, by its place in `sequences`. */
  shown: number | null;
  /** The sequence Show was pressed on, which stays outlined. */
  pinned: number | null;
  onHover: (index: number | null) => void;
  onPin: (index: number | null) => void;
  /** The commit the diagram sits in, which a flag is posted on. */
  commit: number;
}) {
  const post = usePostOnCommit(commit);
  const heading = useId();
  const [flagging, setFlagging] = useState<number | null>(null);
  if (sequences.length === 0) return null;
  const flagged = flagging === null ? undefined : sequences[flagging];
  const more = sequences.length - SHOWN;
  return (
    <section aria-labelledby={heading} className="mt-3 rounded-lg border p-3">
      <h4 id={heading} className="font-medium text-sm" title={ORDER_NOTE}>
        Not driven by any one test · {sequences.length}
      </h4>
      <p className="mt-0.5 text-muted-foreground text-xs">
        Every step below has a test, but no single test takes all of them. Sequences with a red edge
        are not repeated here.
      </p>
      <ul className="mt-2 space-y-1.5">
        {sequences.slice(0, SHOWN).map((sequence, index) => {
          const label = sequenceLabel(sequence);
          return (
            <li
              key={sequence.moves.join()}
              aria-label={label}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5",
                shown === index && "border-[var(--cov-uncovered)]",
              )}
            >
              <span className="font-mono text-xs">{label}</span>
              <span className="text-muted-foreground text-xs">
                each step tested, never in one test
              </span>
              <span className="ml-auto flex gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  aria-pressed={pinned === index}
                  aria-label={`Show ${label}`}
                  onMouseEnter={() => onHover(index)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(index)}
                  onBlur={() => onHover(null)}
                  onClick={() => onPin(pinned === index ? null : index)}
                >
                  Show
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  className="text-[var(--cov-uncovered)]"
                  aria-label={`Flag ${label} as missing test`}
                  onClick={() => setFlagging(index)}
                >
                  Flag as missing test
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className="mt-1.5 text-muted-foreground text-xs">+{more} more</p> : null}
      {flagged === undefined ? null : (
        <CommentBox
          key={flagging}
          className="mt-2 shadow-none"
          kind="flag"
          label={`Flag ${sequenceLabel(flagged)}`}
          initialBody={missingSequenceDraft(flagged)}
          onCancel={() => setFlagging(null)}
          actions={(kind) => [
            { label: kind === "ask" ? "Send question" : "Send flag", primary: true, run: post },
          ]}
        />
      )}
      <p className="mt-2 text-muted-foreground text-xs">{ORDER_NOTE}</p>
    </section>
  );
}
