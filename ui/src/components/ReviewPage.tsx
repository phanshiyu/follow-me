import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { commitKey } from "../lib/commit.ts";
import { HEADER_PX, PageProvider, scrollToCommit, usePage } from "../page.tsx";
import { useCoverageData, useReview } from "../store.tsx";
import { AskBranch, BranchSummary } from "./Branch.tsx";
import { CommitSection } from "./CommitSection.tsx";
import { BranchCoverage, CoverageToggle, useUncoveredSteps } from "./Coverage.tsx";
import { useDefinitions } from "./Definition.tsx";
import { focusIndex, Index } from "./Index.tsx";
import { KeySheet } from "./KeySheet.tsx";
import { Notices, PageOptions, UnreadMenu } from "./Notices.tsx";
import { StackPicker } from "./StackPicker.tsx";
import { SubmitDialog } from "./SubmitDialog.tsx";

/** Keys typed into a field, or with a modifier, belong to the field or the browser. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [role=menu]") !== null)
  );
}

/** The next unresolved thread below the viewport's top, wrapping to the first. */
function nextUnresolved(): void {
  const cards = [...document.querySelectorAll<HTMLElement>("article[data-open-thread]")];
  const next = cards.find((card) => card.getBoundingClientRect().top > HEADER_PX + 60) ?? cards[0];
  next?.scrollIntoView({ block: "center" });
}

function usePageKeys(openStack: () => void, openSheet: () => void, openSubmit: () => void) {
  const { state } = useReview();
  const {
    current,
    isViewed,
    setViewed,
    pick,
    setPick,
    setBox,
    indexOpen,
    setIndexOpen,
    coverageOn,
    setCoverageOn,
  } = usePage();
  const stepUncovered = useUncoveredSteps();
  const hasCoverage = useCoverageData() !== null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        openSubmit();
        return;
      }
      if (event.key === "Escape" && pick !== null) {
        setPick(null);
        return;
      }
      if (isTyping(event)) return;
      const last = state.commits.length - 1;
      const here = state.commits[current];
      switch (event.key) {
        case "j":
        case "c":
          scrollToCommit(Math.min(last, current + 1));
          break;
        case "k":
          scrollToCommit(Math.max(0, current - 1));
          break;
        case "x":
        case "X":
          stepUncovered(event.key === "x" ? 1 : -1);
          break;
        case "g":
          if (!hasCoverage) return;
          setCoverageOn(!coverageOn);
          break;
        case "n": {
          const next = state.commits.find((c) => c.index > current && !isViewed(c));
          if (next !== undefined) scrollToCommit(next.index);
          break;
        }
        case "v":
          if (here !== undefined) setViewed(here, !isViewed(here));
          break;
        case "s":
          if (indexOpen) focusIndex();
          else openStack();
          break;
        case "[":
          setIndexOpen(!indexOpen);
          break;
        case "f":
        case "a":
          if (pick === null) return;
          setBox(event.key === "f" ? "flag" : "ask");
          break;
        case "u":
          nextUnresolved();
          break;
        case "?":
          openSheet();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    state.commits,
    current,
    isViewed,
    setViewed,
    openStack,
    openSheet,
    openSubmit,
    pick,
    setPick,
    setBox,
    indexOpen,
    setIndexOpen,
    stepUncovered,
    coverageOn,
    setCoverageOn,
    hasCoverage,
  ]);
}

function Page() {
  const { state, error, ended, arrived, dismissArrived, reconnecting } = useReview();
  const { indexOpen } = usePage();
  const definitions = useDefinitions();
  const [stackOpen, setStackOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  usePageKeys(
    () => setStackOpen(true),
    () => setSheetOpen(true),
    () => setSubmitOpen(true),
  );
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 h-11 border-b bg-background/95 backdrop-blur">
        <div className="grid h-full grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 text-sm">
          <div className="min-w-0 truncate">
            <strong>follow-me</strong>
            <span className="text-muted-foreground">
              {" "}
              · {state.anchor.branch} → {state.anchor.baseRef} · plan v{state.version}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {indexOpen ? null : <StackPicker open={stackOpen} onOpenChange={setStackOpen} />}
            {definitions.back}
          </div>
          <div className="flex items-center justify-end gap-2">
            <BranchCoverage />
            <CoverageToggle />
            <UnreadMenu />
            <AskBranch />
            <Button size="sm" onClick={() => setSubmitOpen(true)}>
              Submit review
            </Button>
            <PageOptions />
          </div>
        </div>
        {reconnecting ? (
          <div className="border-b bg-amber-500/10 px-6 py-1 text-center text-amber-900 text-sm dark:text-amber-100">
            Reconnecting… your drafts are kept.
          </div>
        ) : null}
        {arrived === null ? null : (
          <div
            role="status"
            className="absolute top-full left-1/2 mt-2 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-sky-50 py-0.5 pr-1 pl-4 text-sky-900 text-sm shadow-md dark:bg-sky-950 dark:text-sky-100"
          >
            <span>{arrived}</span>
            <Button variant="ghost" size="xs" onClick={dismissArrived}>
              Dismiss
            </Button>
          </div>
        )}
        {error === null && !ended ? null : (
          <div
            role="alert"
            className="border-b bg-rose-500/10 px-6 py-1.5 text-center text-rose-800 text-sm dark:text-rose-200"
          >
            {ended ? "This review has ended. Nothing more can be saved here." : error}
          </div>
        )}
      </header>
      <div className="flex">
        <Index />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1232px] px-6">
            <BranchSummary />
            {state.commits.map((commit) => (
              <CommitSection key={commitKey(commit)} commit={commit} />
            ))}
          </div>
        </main>
      </div>
      {definitions.layer}
      <Notices />
      <KeySheet open={sheetOpen} onOpenChange={setSheetOpen} />
      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />
    </div>
  );
}

export function ReviewPage() {
  return (
    <PageProvider>
      <Page />
    </PageProvider>
  );
}
