import { useEffect, useState } from "react";
import { commitKey } from "../lib/commit.ts";
import { PageProvider, scrollToCommit, usePage } from "../page.tsx";
import { useReview } from "../store.tsx";
import { CommitSection } from "./CommitSection.tsx";
import { StackPicker } from "./StackPicker.tsx";

/** Keys typed into a field, or with a modifier, belong to the field or the browser. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [role=menu]") !== null)
  );
}

function useCommitKeys(openStack: () => void) {
  const { state } = useReview();
  const { current, isViewed, setViewed } = usePage();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      const last = state.commits.length - 1;
      const here = state.commits[current];
      switch (event.key) {
        case "j":
        case "c":
          scrollToCommit(Math.min(last, current + 1));
          break;
        case "k":
        case "x":
          scrollToCommit(Math.max(0, current - 1));
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
          openStack();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.commits, current, isViewed, setViewed, openStack]);
}

function Page() {
  const { state } = useReview();
  const [stackOpen, setStackOpen] = useState(false);
  useCommitKeys(() => setStackOpen(true));
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 h-11 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto grid h-full max-w-[1232px] grid-cols-[1fr_auto_1fr] items-center gap-2 px-6 text-sm">
          <div className="min-w-0 truncate">
            <strong>follow-me</strong>
            <span className="text-muted-foreground">
              {" "}
              · {state.anchor.branch} → {state.anchor.baseRef} · plan v{state.version}
            </span>
          </div>
          <StackPicker open={stackOpen} onOpenChange={setStackOpen} />
          <div />
        </div>
      </header>
      <main className="mx-auto max-w-[1232px] px-6">
        {state.commits.map((commit) => (
          <CommitSection key={commitKey(commit)} commit={commit} />
        ))}
      </main>
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
