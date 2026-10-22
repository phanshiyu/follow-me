import { useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import {
  candidateAt,
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

/**
 * "Changed lines covered 84%" in the page header, over every commit's added lines; "Covered 84%"
 * below 1280px, where the header also holds the commit picker.
 */
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
      <span className="xl:hidden">Covered {percentOf(coverage.branch)}%</span>
      <span className="hidden xl:inline">Changed lines covered {percentOf(coverage.branch)}%</span>
    </span>
  );
}

/** "coverage from b164dd3; this file changed since", on the line of a file the run predates. */
export function FileStale({ path }: { path: string }) {
  const coverage = useCoverage();
  if (coverage === null || !coverage.stale.has(path)) return null;
  return (
    <span className="text-amber-800 text-xs dark:text-amber-200">
      coverage from <code className="font-mono">{coverage.tip.slice(0, 7)}</code>; this file changed
      since
    </span>
  );
}

/** "Coverage is 2 files stale": the tip moved after the run, and the agent should run it again. */
export function StaleCoverage() {
  const coverage = useCoverage();
  const n = coverage?.stale.size ?? 0;
  if (n === 0) return null;
  return (
    <span
      className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums", TONE.partly)}
      title={`The branch moved after the run at ${coverage?.tip.slice(0, 7)}`}
    >
      Coverage is {n === 1 ? "1 file" : `${n} files`} stale
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

/**
 * A row on the page by its own top; one folded away under Viewed by its commit's. The row the last
 * step landed on is where we are while it is in view, even when the end of the page kept it from
 * reaching the reading line.
 */
function placeOf(target: Target, line: number, last: HTMLElement | null): Place {
  const row = rowOf(target);
  const top = (
    row ?? document.getElementById(`commit-${target.commit + 1}`)
  )?.getBoundingClientRect().top;
  if (top === undefined) return "below";
  if (
    row !== null &&
    (Math.abs(top - line) < 2 || (row === last && top >= 0 && top < window.innerHeight))
  )
    return "at";
  return top < line ? "above" : "below";
}

/**
 * x and X: the next or previous added row the suite did not run, in document order across
 * commits. The row opens if Viewed folded it, lands 30% down the window, flashes and takes focus.
 */
export function useUncoveredSteps(): (dir: 1 | -1) => void {
  const coverage = useCoverage();
  const { reveal } = usePage();
  const last = useRef<HTMLElement | null>(null);
  return useCallback(
    (dir) => {
      const targets = coverage?.uncovered ?? [];
      const line = window.innerHeight * READING;
      const places = targets.map((t) => placeOf(t, line, last.current));
      const target = targets[stepUncovered(places, dir) ?? -1];
      if (target === undefined) return;
      flushSync(() => reveal(target.commit, target.path));
      const row = rowOf(target);
      if (row === null) return;
      window.scrollBy(0, row.getBoundingClientRect().top - line);
      row.focus({ preventScroll: true });
      flash(row, "row-flash");
      last.current = row;
    },
    [coverage, reveal],
  );
}

const TEST = { title: "Test", kind: "test" } as const;

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
  const stale = mark.stale ? (
    <p className="text-amber-800 text-xs dark:text-amber-200">
      This file changed since {coverage.tip.slice(0, 7)}, so the line may have moved.
    </p>
  ) : null;
  if (mark.kind === "uncovered") {
    return (
      <div className="space-y-2">
        {stale}
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
  const open = async (id: string, at: Loc | null, preview: readonly string[] | null) => {
    onClose();
    const shown = shownAt(at);
    if (at !== null && shown !== null) return goTo(candidateAt(at, shown), id, commit, near, TEST);
    // The server sends a test's own lines when the branch leaves its file alone.
    if (at !== null && preview !== null)
      return goTo(candidateAt(at, null, preview), id, commit, near, TEST);
    const named = testNameOf(id);
    const file = at?.path ?? named.path;
    if (named.name !== null && file !== null) {
      const answer = await api.definition(named.name, file).catch(() => ({ candidates: [] }));
      const found = answer.candidates.find((c) => c.path === file);
      if (found !== undefined) return goTo(found, named.name, commit, near, TEST);
    }
    if (at !== null) goTo(candidateAt(at, null), id, commit, near, TEST);
  };
  return (
    <div className="space-y-2">
      {stale}
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
                      onClick={() => void open(test.id, test.at, test.preview)}
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
