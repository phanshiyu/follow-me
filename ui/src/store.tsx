import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AnswerCard, answerCards } from "./lib/answers.ts";
import { ApiError, api, sessionPrefix } from "./lib/api.ts";
import { arrival, type Placement, placeCarried } from "./lib/carried.ts";
import { titleOf } from "./lib/commit.ts";
import { type Coverage, type PageCoverage, pageCoverage } from "./lib/coverage.ts";
import { applyEvent } from "./lib/live.ts";
import { type LineNumber, lineNumbers, ownership } from "./lib/rows.ts";
import { type Notice, noticeOf, unreadOf } from "./lib/unread.ts";
import type { ServerEvent, State, Unit, UnitId } from "./lib/wire.ts";

type Store = {
  readonly state: State;
  readonly ended: boolean;
  readonly error: string | null;
  /** The server stopped answering; the page keeps its drafts and retries the same URL. */
  readonly reconnecting: boolean;
  /** Runs one API call, shows its failure, and says whether it went through. */
  run(action: () => Promise<unknown>): Promise<boolean>;
  refresh(): Promise<void>;
  /** The one-line notice that a new plan version arrived, until the reviewer dismisses it. */
  readonly arrived: string | null;
  dismissArrived(): void;
  /** Every event so far that told the reviewer something, for toasts and the unread badge. */
  readonly events: readonly ServerEvent[];
  /** What the agent said that the reviewer has not looked at yet. */
  readonly unread: readonly Notice[];
  markSeen(keys: readonly string[]): void;
  /** The last test run handed over, null until one arrives. */
  readonly coverage: Coverage | null;
};

const ReviewContext = createContext<Store | null>(null);

export function useReview(): Store {
  const store = useContext(ReviewContext);
  if (store === null) throw new Error("useReview outside ReviewProvider");
  return store;
}

const RECONNECT_MS = 2000;
const HEADER_PX = 44;

/** The commit at the top of the viewport by title, and how far below the header its section starts. */
function topCommit(state: State): { title: string; offset: number } | null {
  let found: { title: string; offset: number } | null = null;
  for (const section of document.querySelectorAll<HTMLElement>("section[data-commit]")) {
    const top = section.getBoundingClientRect().top;
    const commit = state.commits[Number(section.dataset["commit"])];
    if (commit === undefined) continue;
    if (found !== null && top > HEADER_PX + 1) break;
    found = { title: titleOf(commit.message), offset: top - HEADER_PX };
  }
  return found;
}

function restoreTop(state: State, at: { title: string; offset: number }): void {
  const commit = state.commits.find((c) => titleOf(c.message) === at.title);
  if (commit === undefined) return;
  const section = document.getElementById(`commit-${commit.index + 1}`);
  if (section === null) return;
  window.scrollBy(0, section.getBoundingClientRect().top - HEADER_PX - at.offset);
}

/**
 * Holds the session state and keeps it live over the event stream. Writes go through `run` and
 * come back as events, so the page never patches its own copy after a write.
 */
export function ReviewProvider({ initial, children }: { initial: State; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [arrived, setArrived] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly ServerEvent[]>([]);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(initial.seq);
  seq.current = state.seq;
  const latest = useRef(state);
  latest.current = state;
  const keep = useRef<{ title: string; offset: number } | null>(null);

  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const loadCoverage = useCallback(() => {
    // Without coverage the page reads as before, so a failed fetch only leaves the marks off.
    api
      .coverage()
      .then(setCoverage)
      .catch(() => undefined);
  }, []);
  useEffect(loadCoverage, [loadCoverage]);

  const refresh = useCallback(async () => {
    const fresh = await api.state();
    setState(fresh);
  }, []);

  useEffect(() => {
    if (ended) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      source = new EventSource(`${sessionPrefix}/api/events/stream?since=${seq.current}`);
      source.onmessage = (message: MessageEvent<string>) => {
        const event: ServerEvent = JSON.parse(message.data);
        setState((current) => applyEvent(current, event));
        if (noticeOf(event) !== null) setEvents((before) => [...before, event]);
        if (event.type === "version") {
          keep.current = topCommit(latest.current);
          void refresh().then(() => setArrived(`v${event.version}`));
        }
        // A new version can move the tip, which changes which files are stale.
        if (event.type === "coverage" || event.type === "version") loadCoverage();
        if (event.type === "ended") setEnded(true);
      };
      source.onopen = () => setReconnecting(false);
      source.onerror = () => {
        if (stopped) return;
        setReconnecting(true);
        // The browser retries a dropped stream itself; a closed one needs us. Either way the
        // server may have restarted, so read state afresh once it answers on this URL again.
        if (source?.readyState !== EventSource.CLOSED) return;
        const attempt = () => {
          refresh()
            .then(() => {
              // A restarted server does not replay coverage events, so read it afresh too.
              loadCoverage();
              setReconnecting(false);
              connect();
            })
            .catch((failure: unknown) => {
              // The session is gone for good; a server that is merely down is waited for.
              if (failure instanceof ApiError && failure.status === 404) setEnded(true);
              else retry = setTimeout(attempt, RECONNECT_MS);
            });
        };
        retry = setTimeout(attempt, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [ended, refresh, loadCoverage]);

  // The page shows the swapped plan in the same place: the commit that was at the top stays there.
  const version = state.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the plan version changes
  useLayoutEffect(() => {
    const at = keep.current;
    keep.current = null;
    if (at !== null) restoreTop(latest.current, at);
  }, [version]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  }, []);

  const unread = useMemo(() => unreadOf(seen, events), [seen, events]);
  const markSeen = useCallback(
    (keys: readonly string[]) => setSeen((before) => new Set([...before, ...keys])),
    [],
  );

  const store = useMemo(
    () => ({
      state,
      ended,
      error,
      reconnecting,
      run,
      refresh,
      arrived: arrived === null ? null : arrival(state.version, state.carried ?? []),
      dismissArrived: () => setArrived(null),
      events,
      unread,
      markSeen,
      coverage,
    }),
    [state, ended, error, reconnecting, run, refresh, arrived, events, unread, markSeen, coverage],
  );
  return <ReviewContext value={store}>{children}</ReviewContext>;
}

export type Derived = {
  readonly units: ReadonlyMap<UnitId, Unit>;
  readonly owners: ReadonlyMap<UnitId, ReadonlyMap<number, number>>;
  readonly numbers: ReadonlyMap<UnitId, readonly LineNumber[]>;
};

/** Lookups that change only with the plan, not with every comment. */
export function useDerived(): Derived {
  const { state } = useReview();
  const { units, commits } = state;
  return useMemo(
    () => ({
      units: new Map(units.map((u) => [u.id, u])),
      owners: ownership(commits),
      numbers: lineNumbers(units),
    }),
    [units, commits],
  );
}

/** The run laid over the page, or null when there is none. */
export function useCoverageData(): PageCoverage | null {
  const { state, coverage } = useReview();
  const { units, owners, numbers } = useDerived();
  return useMemo(
    () =>
      coverage === null ? null : pageCoverage(coverage, state.commits, units, owners, numbers),
    [coverage, state.commits, units, owners, numbers],
  );
}

/** The previous version's questions, each placed where its answer now lives. */
export function useAnswers(): readonly AnswerCard[] {
  const { state } = useReview();
  const { previous, resolved, commits, carried } = state;
  return useMemo(
    () =>
      answerCards(previous, resolved, commits, new Set((carried ?? []).map((c) => c.comment.id))),
    [previous, resolved, commits, carried],
  );
}

/** The previous version's threads, each placed in the current plan. */
export function usePlacements(): readonly Placement[] {
  const { state } = useReview();
  // biome-ignore lint/correctness/useExhaustiveDependencies: placement reads these parts of state
  return useMemo(
    () => placeCarried(state),
    [state.previous, state.carried, state.commits, state.units],
  );
}
