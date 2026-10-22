import { useCallback } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type MarkKind,
  type Place,
  percentOf,
  stepUncovered,
  type Tally,
  type Target,
  toneOf,
} from "../lib/coverage.ts";
import { flash } from "../lib/jump.ts";
import { useCoverage, usePage } from "../page.tsx";
import { useCoverageData } from "../store.tsx";

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
