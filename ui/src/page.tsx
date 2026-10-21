import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { commitKey } from "./lib/commit.ts";
import type { BoxKind } from "./lib/compose.ts";
import type { Pick } from "./lib/selection.ts";
import { loadSet, saveSet } from "./lib/storage.ts";
import type { ProjectedCommit, UnitId } from "./lib/wire.ts";

/** Rows picked in one hunk of one commit. Only one pick exists on the page at a time. */
export type PagePick = Pick & { readonly commit: number; readonly unit: UnitId };

import { useReview } from "./store.tsx";

type Page = {
  /** The commit at the top of the viewport. */
  readonly current: number;
  isViewed(commit: ProjectedCommit): boolean;
  setViewed(commit: ProjectedCommit, viewed: boolean): void;
  isFileViewed(commit: ProjectedCommit, path: string): boolean;
  setFileViewed(commit: ProjectedCommit, path: string, viewed: boolean): void;
  /** Threads the reviewer resolved: earlier versions' questions on the server, the rest here. */
  readonly resolved: ReadonlySet<string>;
  setLocallyResolved(id: string, resolved: boolean): void;
  readonly pick: PagePick | null;
  setPick(pick: PagePick | null): void;
  /** The comment box under the pick, open with the kind its button chose. */
  readonly box: BoxKind | null;
  setBox(box: BoxKind | null): void;
};

const PageContext = createContext<Page | null>(null);

export function usePage(): Page {
  const page = useContext(PageContext);
  if (page === null) throw new Error("usePage outside PageProvider");
  return page;
}

export const HEADER_PX = 44;

export function scrollToCommit(index: number): void {
  document.getElementById(`commit-${index + 1}`)?.scrollIntoView({ block: "start" });
}

/** The last commit section whose top has passed under the page header. */
function useCurrentCommit(): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const sections = document.querySelectorAll<HTMLElement>("section[data-commit]");
      let at = 0;
      for (const section of sections) {
        if (section.getBoundingClientRect().top > HEADER_PX + 1) break;
        at = Number(section.dataset["commit"]);
      }
      setCurrent(at);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return current;
}

/**
 * Marks that live in the browser: Viewed on commits and files. A mark is keyed by the commit's
 * units and selections, so a new plan version that changes a commit clears its mark.
 */
export function PageProvider({ children }: { children: ReactNode }) {
  const { state } = useReview();
  const current = useCurrentCommit();
  const [viewed, setViewedSet] = useState(() => loadSet("viewed"));
  const [local, setLocal] = useState(() => loadSet("resolved"));
  const [pick, setPickState] = useState<PagePick | null>(null);
  const [box, setBox] = useState<BoxKind | null>(null);
  const setPick = useCallback((next: PagePick | null) => {
    setPickState(next);
    if (next === null) setBox(null);
  }, []);
  const setLocallyResolved = useCallback((id: string, on: boolean) => {
    setLocal((before) => {
      const next = new Set(before);
      if (on) next.add(id);
      else next.delete(id);
      saveSet("resolved", next);
      return next;
    });
  }, []);

  const toggle = useCallback((key: string, on: boolean) => {
    setViewedSet((before) => {
      const next = new Set(before);
      if (on) next.add(key);
      else next.delete(key);
      saveSet("viewed", next);
      return next;
    });
  }, []);

  const page = useMemo<Page>(() => {
    const fileKey = (commit: ProjectedCommit, path: string) => `${commitKey(commit)}|${path}`;
    return {
      current,
      isViewed: (commit) => viewed.has(commitKey(commit)),
      setViewed: (commit, on) => {
        toggle(commitKey(commit), on);
        if (!on) return;
        const next = state.commits.find((c) => c.index > commit.index && !viewed.has(commitKey(c)));
        if (next !== undefined) requestAnimationFrame(() => scrollToCommit(next.index));
      },
      isFileViewed: (commit, path) => viewed.has(fileKey(commit, path)),
      setFileViewed: (commit, path, on) => toggle(fileKey(commit, path), on),
      resolved: new Set([...state.resolved, ...local]),
      setLocallyResolved,
      pick,
      setPick,
      box: pick === null ? null : box,
      setBox,
    };
  }, [
    current,
    viewed,
    toggle,
    state.commits,
    state.resolved,
    local,
    setLocallyResolved,
    pick,
    setPick,
    box,
  ]);

  return <PageContext value={page}>{children}</PageContext>;
}
