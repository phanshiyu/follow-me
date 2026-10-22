import { useCallback } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import {
  type Loc,
  locate,
  type Mark,
  type MarkKind,
  type Place,
  percentOf,
  stepUncovered,
  type Tally,
  type Target,
  takenLabel,
  testNameOf,
  testsOf,
  toneOf,
} from "../lib/coverage.ts";
import { flash } from "../lib/jump.ts";
import type { Candidate } from "../lib/wire.ts";
import { useCoverage, usePage } from "../page.tsx";
import { useCoverageData, useDerived, useReview } from "../store.tsx";
import { type Measurable, useGoTo } from "./Definition.tsx";

export const TONE: Readonly<Record<MarkKind, string>> = {
  covered: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  partly: "bg-amber-500/15 text-amber-900 dark:text-amber-200",
  uncovered: "bg-rose-500/10 text-rose-800 dark:text-rose-300",
};

const BAR: Readonly<Record<MarkKind, string>> = {
  covered: "bg-[var(--cov-covered)]",
  partly: "bg-[var(--cov-partly)]",
  uncovered: "bg-[var(--cov-uncovered)]",
};

/** "2 of 3 new lines covered" after a commit's title, red while any added line was not run. */
export function CommitCoverage({ commit }: { commit: number }) {
  const tally = useCoverage()?.commits[commit];
  if (tally === undefined || tally.total === 0) return null;
  const tone = toneOf(tally);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-full px-2 py-0.5 text-xs tabular-nums",
        TONE[tone],
      )}
    >
      {tally.run} of {tally.total} new lines covered
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-foreground/10">
        <span className={cn("block h-full", BAR[tone])} style={{ width: `${percentOf(tally)}%` }} />
      </span>
    </span>
  );
}

/** "6/7 covered" on a file's line. */
export function FileCoverage({ tally }: { tally: Tally | undefined }) {
  if (tally === undefined || tally.total === 0) return null;
  return (
    <span className={cn("rounded px-1.5 font-sans text-xs tabular-nums", TONE[toneOf(tally)])}>
      {tally.run}/{tally.total} covered
    </span>
  );
}

/** "Changed lines covered 84%" in the page header, over every commit's added lines. */
export function BranchCoverage() {
  const coverage = useCoverage();
  if (coverage === null || coverage.branch.total === 0) return null;
  return (
    <span
      className={cn(
        "hidden shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums lg:inline",
        TONE[toneOf(coverage.branch)],
      )}
      title={`${coverage.branch.run} of ${coverage.branch.total} added lines the tests can run`}
    >
      Changed lines covered {percentOf(coverage.branch)}%
    </span>
  );
}

/** Shows or hides every mark and figure; also `g`. Only there once a run has arrived. */
export function CoverageToggle() {
  const data = useCoverageData();
  const { coverageOn, setCoverageOn } = usePage();
  if (data === null) return null;
  return (
    <Button
      variant={coverageOn ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={coverageOn}
      title="Show or hide coverage (g)"
      onClick={() => setCoverageOn(!coverageOn)}
    >
      Coverage
    </Button>
  );
}

/** Where x and X put a row: 30% down the window, as VS Code does. */
const READING = 0.3;

function rowOf(target: Target): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `#commit-${target.commit + 1} [data-unit="${CSS.escape(target.unit)}"] [data-row="${target.row}"]`,
  );
}

/** A row on the page by its own top; one folded away under Viewed by its commit's. */
function placeOf(target: Target, line: number): Place {
  const row = rowOf(target);
  const top = (
    row ?? document.getElementById(`commit-${target.commit + 1}`)
  )?.getBoundingClientRect().top;
  if (top === undefined) return "below";
  if (row !== null && Math.abs(top - line) < 2) return "at";
  return top < line ? "above" : "below";
}

/**
 * x and X: the next or previous added row the suite did not run, in document order across
 * commits. The row opens if Viewed folded it, lands 30% down the window, flashes and takes focus.
 */
export function useUncoveredSteps(): (dir: 1 | -1) => void {
  const coverage = useCoverage();
  const { reveal } = usePage();
  return useCallback(
    (dir) => {
      const targets = coverage?.uncovered ?? [];
      const line = window.innerHeight * READING;
      const target =
        targets[
          stepUncovered(
            targets.map((t) => placeOf(t, line)),
            dir,
          ) ?? -1
        ];
      if (target === undefined) return;
      flushSync(() => reveal(target.commit, target.path));
      const row = rowOf(target);
      if (row === null) return;
      window.scrollBy(0, row.getBoundingClientRect().top - line);
      row.focus({ preventScroll: true });
      flash(row, "row-flash");
    },
    [coverage, reveal],
  );
}

const TEST = { title: "Test", kind: "test" } as const;

/** A place for the jump or the peek; a test has no preview of its own. */
function placeAt(at: Loc, shown: { unit: Candidate["unit"]; row: number; commit: number } | null) {
  return {
    path: at.path,
    newLine: at.start,
    kind: "other",
    unit: shown?.unit ?? null,
    row: shown?.row ?? null,
    commit: shown?.commit ?? null,
    preview: [],
  } satisfies Candidate;
}

const hitTimes = (n: number) => (n === 1 ? "Hit once" : `Hit ${n} times`);

/**
 * What the run did on one line, from a click on its mark. A test that sits in the branch links
 * into the document with Back; one outside it opens a peek, through the server's definition lookup
 * when its id names a function.
 */
export function MarkDetails({
  mark,
  path,
  line,
  commit,
  near,
  onFlag,
  onClose,
}: {
  mark: Mark;
  path: string;
  line: number;
  commit: number;
  near: Measurable;
  onFlag: () => void;
  onClose: () => void;
}) {
  const coverage = useCoverage();
  const { state } = useReview();
  const { units, owners, numbers } = useDerived();
  const goTo = useGoTo();
  if (coverage === null) return null;
  if (mark.kind === "uncovered") {
    return (
      <div className="space-y-2">
        <p>
          Not run by the suite at <code className="font-mono">{coverage.tip.slice(0, 7)}</code> (
          {takenLabel(coverage.takenAt)})
        </p>
        <Button size="sm" variant="outline" onClick={onFlag}>
          Flag as missing test
        </Button>
      </div>
    );
  }
  const tests = testsOf(coverage.tests, path, line);
  const shownAt = (at: Loc | null) =>
    at === null ? null : locate(at, state.commits, units, owners, numbers);
  const open = async (id: string, at: Loc | null) => {
    onClose();
    const shown = shownAt(at);
    if (at !== null && shown !== null) return goTo(placeAt(at, shown), id, commit, near, TEST);
    const named = testNameOf(id);
    const file = at?.path ?? named.path;
    if (named.name !== null && file !== null) {
      const answer = await api.definition(named.name, file).catch(() => ({ candidates: [] }));
      const found = answer.candidates.find((c) => c.path === file);
      if (found !== undefined) return goTo(found, named.name, commit, near, TEST);
    }
    if (at !== null) goTo(placeAt(at, null), id, commit, near, TEST);
  };
  return (
    <div className="space-y-2">
      <div>
        <p>{hitTimes(mark.hits)}</p>
        {mark.branches === null ? null : (
          <p className="text-muted-foreground">
            {mark.branches[0]} of {mark.branches[1]} branches taken
          </p>
        )}
      </div>
      {tests === null ? (
        <p className="text-muted-foreground text-xs">No per-test detail in this run</p>
      ) : tests.length === 0 ? (
        <p className="text-muted-foreground text-xs">No test in this run's detail ran this line</p>
      ) : (
        <div>
          <p className="mb-1 font-medium text-xs">
            Run by {tests.length === 1 ? "1 test" : `${tests.length} tests`}
          </p>
          <ul className="-mx-1 max-h-56 overflow-y-auto">
            {tests.map((test) => {
              const shown = shownAt(test.at);
              const linked = test.at !== null || testNameOf(test.id).name !== null;
              const where =
                test.at === null
                  ? null
                  : `${test.at.path}:${test.at.start} · ${shown === null ? "outside this branch" : `in commit ${shown.commit + 1}`}`;
              return (
                <li key={test.id}>
                  {linked ? (
                    <button
                      type="button"
                      className="w-full rounded px-1 py-0.5 text-left outline-none hover:bg-muted focus-visible:bg-muted"
                      onClick={() => void open(test.id, test.at)}
                    >
                      <span className="block font-mono text-xs [overflow-wrap:anywhere]">
                        {test.id}
                      </span>
                      {where === null ? null : (
                        <span className="block text-muted-foreground text-xs">{where}</span>
                      )}
                    </button>
                  ) : (
                    <span className="block px-1 py-0.5 font-mono text-xs [overflow-wrap:anywhere]">
                      {test.id}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
