import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, sessionPrefix } from "./lib/api.ts";
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
};

const ReviewContext = createContext<Store | null>(null);

export function useReview(): Store {
  const store = useContext(ReviewContext);
  if (store === null) throw new Error("useReview outside ReviewProvider");
  return store;
}

const RECONNECT_MS = 2000;

/**
 * Holds the session state and keeps it live over the event stream. Writes go through `run` and
 * come back as events, so the page never patches its own copy after a write.
 */
export function ReviewProvider({ initial, children }: { initial: State; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(initial.seq);
  seq.current = state.seq;

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
        if (event.type === "version") void refresh();
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
    () => ({ state, ended, error, run, refresh }),
    [state, ended, error, run, refresh],
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
