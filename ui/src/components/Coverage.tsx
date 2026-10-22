import { cn } from "@/lib/utils";
import { type MarkKind, percentOf, type Tally, toneOf } from "../lib/coverage.ts";
import { useCoverage } from "../page.tsx";

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
