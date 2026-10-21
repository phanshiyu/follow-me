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
import { api, sessionPrefix } from "./lib/api.ts";
import { arrival, type Placement, placeCarried } from "./lib/carried.ts";
import { titleOf } from "./lib/commit.ts";
import { applyEvent } from "./lib/live.ts";
import { type LineNumber, lineNumbers, ownership } from "./lib/rows.ts";
import type { ServerEvent, State, Unit, UnitId } from "./lib/wire.ts";

type Store = {
  readonly state: State;
  readonly ended: boolean;
  readonly error: string | null;
  /** Runs one API call, shows its failure, and says whether it went through. */
  run(action: () => Promise<unknown>): Promise<boolean>;
  refresh(): Promise<void>;
  /** The one-line notice that a new plan version arrived, until the reviewer dismisses it. */
  readonly arrived: string | null;
  dismissArrived(): void;
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
  const [arrived, setArrived] = useState<string | null>(null);
  const seq = useRef(initial.seq);
  seq.current = state.seq;
  const latest = useRef(state);
  latest.current = state;
  const keep = useRef<{ title: string; offset: number } | null>(null);

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
        if (event.type === "version") {
          keep.current = topCommit(latest.current);
          void refresh().then(() => setArrived(`v${event.version}`));
        }
        if (event.type === "ended") setEnded(true);
      };
      source.onerror = () => {
        // A closed stream means the server restarted or the review ended; read state afresh.
        if (source?.readyState !== EventSource.CLOSED || stopped) return;
        retry = setTimeout(() => {
          refresh()
            .then(connect)
            .catch(() => setEnded(true));
        }, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [ended, refresh]);

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

  const store = useMemo(
    () => ({
      state,
      ended,
      error,
      run,
      refresh,
      arrived: arrived === null ? null : arrival(state.version, state.carried ?? []),
      dismissArrived: () => setArrived(null),
    }),
    [state, ended, error, run, refresh, arrived],
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

/** The previous version's questions, each placed where its answer now lives. */
export function useAnswers(): readonly AnswerCard[] {
  const { state } = useReview();
  const { previous, resolved, commits, carried } = state;
  return useMemo(
    () => answerCards(previous, resolved, commits, new Set((carried ?? []).map((c) => c.comment))),
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
