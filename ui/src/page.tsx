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
import type { Spot } from "./lib/history.ts";
import { indexOpenAtStart } from "./lib/outline.ts";
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
  /** Native notifications for the agent's answers while the tab is in the background. */
  readonly notify: boolean;
  /** Turning it on asks the browser for permission, once, here and nowhere else. */
  setNotify(on: boolean): Promise<void>;
  /** The index column beside the document; collapsed, it is a rail of numbers. */
  readonly indexOpen: boolean;
  setIndexOpen(open: boolean): void;
  /**
   * Whether a commit, or one of its files, shows its code although marked Viewed: a jump to a
   * definition opens what it lands in without taking the mark away.
   */
  isRevealed(commit: number, path?: string): boolean;
  reveal(commit: number, path: string): void;
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

/** The commit section at the top of the viewport and how far it has scrolled under the header. */
export function spotOfViewport(): Spot {
  let spot: Spot = { commit: 0, offset: 0 };
  for (const section of document.querySelectorAll<HTMLElement>("section[data-commit]")) {
    const top = section.getBoundingClientRect().top;
    if (top > HEADER_PX + 1) break;
    spot = { commit: Number(section.dataset["commit"]), offset: HEADER_PX - top };
  }
  return spot;
}

export function scrollToSpot(spot: Spot): void {
  const section = document.getElementById(`commit-${spot.commit + 1}`);
  if (section === null) return;
  window.scrollBy(0, section.getBoundingClientRect().top - HEADER_PX + spot.offset);
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
  const [notify, setNotifyState] = useState(
    () =>
      loadSet("prefs").has("notify") &&
      "Notification" in window &&
      Notification.permission === "granted",
  );
  const setNotify = useCallback(async (on: boolean) => {
    const granted =
      on && "Notification" in window && (await Notification.requestPermission()) === "granted";
    setNotifyState(granted);
    saveSet("prefs", new Set(granted ? ["notify"] : []));
  }, []);
  const [indexOpen, setIndexOpenState] = useState(() =>
    indexOpenAtStart(loadSet("index"), window.innerWidth),
  );
  const setIndexOpen = useCallback((open: boolean) => {
    setIndexOpenState(open);
    saveSet("index", new Set([open ? "open" : "closed"]));
  }, []);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const reveal = useCallback(
    (commit: number, path: string) =>
      setRevealed((before) => new Set([...before, `${commit}`, `${commit}|${path}`])),
    [],
  );
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
      notify,
      setNotify,
      indexOpen,
      setIndexOpen,
      isRevealed: (commit, path) =>
        revealed.has(path === undefined ? `${commit}` : `${commit}|${path}`),
      reveal,
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
    notify,
    setNotify,
    indexOpen,
    setIndexOpen,
    revealed,
    reveal,
  ]);

  return <PageContext value={page}>{children}</PageContext>;
}
