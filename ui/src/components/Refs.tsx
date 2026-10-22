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
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { isMac } from "../lib/definition.ts";
import { HISTORY_LIMIT } from "../lib/history.ts";
import { flash } from "../lib/jump.ts";
import { captionsOf } from "../lib/markdown.ts";
import {
  landing,
  type PlacedRef,
  placeRef,
  type RefTarget,
  refLabel,
  refNumberOf,
  refPlace,
  refWhere,
} from "../lib/refs.ts";
import type { Candidate, CodeRef } from "../lib/wire.ts";
import { HEADER_PX, usePage } from "../page.tsx";
import { useDerived, useReview } from "../store.tsx";
import { Peek, useDepart } from "./Definition.tsx";
import { Markdown } from "./Markdown.tsx";

const MAC = isMac(navigator.platform);

/** The hunk row a target names, when its commit and file are open on the page. */
function rowElement(target: RefTarget): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `#commit-${target.commit + 1} [data-unit="${CSS.escape(target.unit)}"] [data-row="${target.row}"]`,
  );
}

/** Every open row of a ref, in page order. */
function rowsOfRef(placed: PlacedRef, commit?: number): HTMLElement[] {
  if (placed.kind !== "on") return [];
  return placed.targets
    .filter((t) => commit === undefined || t.commit === commit)
    .flatMap((t) => rowElement(t) ?? []);
}

export type Tone = "light" | "strong" | "faint";

/**
 * Tints the rows of every ref, badges the first row of each in the gutter, and returns the undo.
 * The marks live on the rows themselves, so painting never re-renders the hunks.
 */
function paint(placed: readonly PlacedRef[], toneOf: (n: number) => Tone): () => void {
  const touched: HTMLElement[] = [];
  for (const p of placed) {
    let first = true;
    for (const row of rowsOfRef(p)) {
      row.dataset["refTint"] = toneOf(p.ref.n);
      touched.push(row);
      const gutter = row.querySelector<HTMLElement>("[data-gutter] > span");
      if (first && gutter !== null) {
        gutter.dataset["refBadge"] = String(p.ref.n);
        touched.push(gutter);
      }
      first = false;
    }
  }
  return () => {
    for (const element of touched) {
      delete element.dataset["refTint"];
      delete element.dataset["refBadge"];
    }
  };
}

/** Where a ref sits against the viewport: above, below, or null when it is in view. */
function offscreen(placed: PlacedRef): "↑" | "↓" | null {
  const target = landing(placed);
  if (target === null) return null;
  const element =
    rowElement(target) ?? document.getElementById(`commit-${target.commit + 1}`) ?? null;
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  if (rect.bottom < HEADER_PX) return "↑";
  if (rect.top > window.innerHeight) return "↓";
  return null;
}

type Painted = {
  readonly key: string;
  readonly placed: readonly PlacedRef[];
  readonly strong: number | null;
};

/** A reply's refs stepped through in order; captions are the list items that hold them. */
export type Walk = {
  readonly key: string;
  readonly placed: readonly PlacedRef[];
  readonly captions: ReadonlyMap<number, string>;
  /** The commit the thread sits in, or null for the whole branch. */
  readonly own: number | null;
  readonly step: number;
  /** How many departures Back had once the walkthrough left the reply; fewer means Back was used. */
  readonly depth: number;
};

type RefsApi = {
  /** Paints a reply's refs while it is hovered or focused; null clears them if `key` painted. */
  paint(key: string, placed: readonly PlacedRef[] | null, strong?: number | null): void;
  /** Jumps to a ref the page shows, with Back to the reply; false when there is nowhere to go. */
  go(placed: PlacedRef, from: number): boolean;
  /** Leaves the reply, with one Back to it, and shows its ref at `step`. */
  start(walk: Omit<Walk, "depth">, from: number): void;
};

const RefsContext = createContext<RefsApi | null>(null);

function useRefsApi(): RefsApi {
  const api = useContext(RefsContext);
  if (api === null) throw new Error("useRefsApi outside RefsProvider");
  return api;
}

type Walking = {
  readonly walk: Walk | null;
  /** Moves by one step, staying on the first or the last. */
  move(by: 1 | -1): void;
  end(): void;
};

const WalkContext = createContext<Walking | null>(null);

/** Keys typed into a field, or with a modifier, belong to the field or the browser. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select") !== null))
  );
}

/** Where a ref's code is put on show: scrolled to 30% from the top and flashed. */
function useShow(): (placed: PlacedRef) => boolean {
  const { reveal } = usePage();
  return useCallback(
    (placed: PlacedRef) => {
      const target = landing(placed);
      if (target === null) return false;
      // A Viewed commit opens to show it, as a jump to a definition does.
      flushSync(() => reveal(target.commit, placed.ref.path));
      const rows = rowsOfRef(placed, target.commit);
      const first = rows[0];
      if (first === undefined) return false;
      window.scrollBy(0, first.getBoundingClientRect().top - window.innerHeight * 0.3);
      for (const row of rows) flash(row, "row-flash");
      return true;
    },
    [reveal],
  );
}

/**
 * Holds which reply's refs are painted on the code, the jump with Back to the reply, and the
 * walkthrough: `.` and `,` step, Esc ends it, and Back to the reply ends it too.
 */
export function RefsProvider({ children }: { children: ReactNode }) {
  const [painted, setPainted] = useState<Painted | null>(null);
  const [walk, setWalk] = useState<Walk | null>(null);
  const { depart, departures } = useDepart();
  const show = useShow();

  // A hovered reply shows its own refs; otherwise a walkthrough keeps its current step strong.
  useLayoutEffect(() => {
    // The reply being stepped through keeps its walkthrough tint while it is hovered.
    if (painted !== null && !(painted.key === walk?.key && painted.strong === null)) {
      const { strong } = painted;
      return paint(painted.placed, (n) =>
        strong === null ? "light" : n === strong ? "strong" : "faint",
      );
    }
    if (walk === null) return;
    const current = walk.placed[walk.step]?.ref.n;
    return paint(walk.placed, (n) => (n === current ? "strong" : "light"));
  }, [painted, walk]);

  if (walk !== null && departures < walk.depth) setWalk(null);

  const api = useMemo<RefsApi>(
    () => ({
      paint: (key, placed, strong = null) =>
        setPainted((before) =>
          placed === null ? (before?.key === key ? null : before) : { key, placed, strong },
        ),
      go: (placed, from) => {
        if (landing(placed) === null) return false;
        depart(from, "the reply");
        return show(placed);
      },
      start: (next, from) => {
        depart(from, "the reply");
        setPainted(null);
        setWalk({ ...next, depth: Math.min(departures + 1, HISTORY_LIMIT) });
        const at = next.placed[next.step];
        if (at !== undefined) show(at);
      },
    }),
    [depart, departures, show],
  );

  const walking = useMemo<Walking>(
    () => ({
      walk,
      move: (by) => {
        if (walk === null) return;
        const step = Math.max(0, Math.min(walk.placed.length - 1, walk.step + by));
        if (step === walk.step) return;
        setWalk({ ...walk, step });
        const at = walk.placed[step];
        if (at !== undefined) show(at);
      },
      end: () => setWalk(null),
    }),
    [walk, show],
  );

  const { move, end } = walking;
  const active = walk !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      if (event.key === ".") move(1);
      else if (event.key === ",") move(-1);
      else if (event.key === "Escape") end();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, move, end]);

  return (
    <RefsContext value={api}>
      <WalkContext value={walking}>{children}</WalkContext>
    </RefsContext>
  );
}

/**
 * The walkthrough's bar, pinned to the bottom of the code column: which step of how many, where
 * it is, its caption, and the keys. A step the page cannot show opens its quote above the bar.
 */
export function WalkthroughBar() {
  const walking = useContext(WalkContext);
  const bar = useRef<HTMLDivElement>(null);
  const walk = walking?.walk ?? null;
  const placed = walk?.placed[walk.step];
  if (walking === null || walk === null || placed === undefined) return null;
  const { ref } = placed;
  const where = refWhere(placed, walk.own);
  const caption = walk.captions.get(ref.n) ?? null;
  return (
    <Popover open={placed.kind !== "on"}>
      <PopoverAnchor asChild>
        <div
          ref={bar}
          role="toolbar"
          aria-label="Agent's walkthrough"
          className="ref-bar sticky bottom-4 z-30 mx-auto mt-6 flex max-w-[1000px] items-center gap-2.5 rounded-[10px] border bg-background px-3 py-2 font-sans text-[13px] shadow-lg"
        >
          <span className="shrink-0 font-semibold text-[var(--ref-ink)]">Agent's walkthrough</span>
          <span className="ref-badge">{ref.n}</span>
          <span className="shrink-0 tabular-nums">
            {walk.step + 1} of {walk.placed.length}
          </span>
          <span className="shrink-0 font-mono text-xs" title={refPlace(ref)}>
            {refLabel(ref)} {where === null ? null : <span className="ref-where">{where}</span>}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={caption ?? ""}>
            {caption}
          </span>
          <Button
            variant="outline"
            size="xs"
            aria-label="Previous step"
            disabled={walk.step === 0}
            onClick={() => walking.move(-1)}
          >
            ‹ <kbd>,</kbd>
          </Button>
          <Button
            variant="outline"
            size="xs"
            aria-label="Next step"
            disabled={walk.step === walk.placed.length - 1}
            onClick={() => walking.move(1)}
          >
            <kbd>.</kbd> ›
          </Button>
          <span className="hidden shrink-0 text-muted-foreground text-xs xl:inline">
            <kbd>{MAC ? "⌥←" : "Alt+←"}</kbd> back to the reply
          </span>
          <Button variant="ghost" size="xs" aria-label="End the walkthrough" onClick={walking.end}>
            Esc
          </Button>
        </div>
      </PopoverAnchor>
      {placed.kind === "on" ? null : (
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(600px,90vw)] gap-0 p-0"
          aria-label={`Ref ${ref.n} at ${refPlace(ref)}`}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && bar.current?.contains(event.target))
              event.preventDefault();
          }}
        >
          <RefPeek placed={placed} />
        </PopoverContent>
      )}
    </Popover>
  );
}

/** The quote of a ref as a peek candidate: the lines as the agent wrote them. */
function quoteOf(ref: CodeRef): Candidate {
  return {
    path: ref.path,
    newLine: ref.start,
    kind: "other",
    unit: null,
    row: null,
    commit: null,
    preview: ref.quote,
  };
}

function whereInPeek(placed: PlacedRef): string {
  if (placed.kind === "stale") return `${refWhere(placed, null)}, the code may differ now`;
  if (placed.kind === "off") return "outside this branch's changes";
  return `in commit ${placed.commit + 1}`;
}

/** A ref's lines beside its chip, for code that is off screen or not on the page at all. */
export function RefPeek({ placed }: { placed: PlacedRef }) {
  const { ref } = placed;
  return (
    <Peek
      candidate={quoteOf(ref)}
      kind=""
      place={refPlace(ref)}
      where={whereInPeek(placed)}
      badge={ref.n}
      empty="The agent's reply quoted no lines here."
    />
  );
}

const HOVER_MS = 200;

/**
 * One ref in the agent's words: its number, the file and lines, and where it sits when that is
 * not the reply's own commit. Clicking jumps to the code; code the page does not show, or that
 * changed since, opens its quote instead, as hovering does for code off screen.
 */
function RefChip({
  placed,
  own,
  arrow,
  onGo,
  onHot,
}: {
  placed: PlacedRef;
  own: number | null;
  arrow: "↑" | "↓" | null;
  onGo: (placed: PlacedRef) => boolean;
  onHot: (n: number | null) => void;
}) {
  const [peek, setPeek] = useState<"hover" | "pinned" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { ref } = placed;
  const where = refWhere(placed, own);
  const onPage = placed.kind === "on";
  return (
    <Popover open={peek !== null} onOpenChange={(on) => (on ? undefined : setPeek(null))}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className="ref-chip"
          data-ref-chip={ref.n}
          data-ref-state={placed.kind}
          title={refPlace(ref)}
          aria-label={`Ref ${ref.n}: ${refPlace(ref)}${where === null ? "" : `, ${where}`}`}
          onPointerEnter={() => {
            onHot(ref.n);
            clearTimeout(timer.current);
            if (onPage && offscreen(placed) === null) return;
            timer.current = setTimeout(() => setPeek((open) => open ?? "hover"), HOVER_MS);
          }}
          onPointerLeave={() => {
            onHot(null);
            clearTimeout(timer.current);
            setPeek((open) => (open === "hover" ? null : open));
          }}
          onClick={() => {
            clearTimeout(timer.current);
            if (onGo(placed)) setPeek(null);
            else setPeek((open) => (open === "pinned" ? null : "pinned"));
          }}
        >
          <span className="ref-badge">{ref.n}</span>
          <span>{refLabel(ref)}</span>
          {where === null ? null : <span className="ref-where">{where}</span>}
          {arrow === null || !onPage ? null : (
            <span aria-hidden className="ref-where">
              {arrow}
            </span>
          )}
        </button>
      </PopoverAnchor>
      {peek === null ? null : (
        <PopoverContent
          align="start"
          className="w-[min(600px,90vw)] gap-0 p-0"
          aria-label={`Ref ${ref.n} at ${refPlace(ref)}`}
          // A glance must not take focus from the reply it belongs to.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <RefPeek placed={placed} />
        </PopoverContent>
      )}
    </Popover>
  );
}

/** Each ref of a reply where the page shows it now. */
export function usePlaced(refs: readonly CodeRef[]): readonly PlacedRef[] {
  const { state } = useReview();
  const { units, owners, numbers } = useDerived();
  return useMemo(
    () => refs.map((ref) => placeRef(ref, state.anchor.tip, state.commits, units, owners, numbers)),
    [refs, state.anchor.tip, state.commits, units, owners, numbers],
  );
}

/**
 * The agent's words with their refs as chips. While the reply is hovered or focused its code is
 * tinted; hovering one chip makes its rows stronger and fades the others.
 */
export function RefBody({
  id,
  text,
  refs,
  own,
}: {
  /** The reply or comment the words belong to. */
  id: string;
  text: string;
  refs: readonly CodeRef[];
  /** The commit the thread sits in, or null for the whole branch. */
  own: number | null;
}) {
  const api = useRefsApi();
  const { current } = usePage();
  const placed = usePlaced(refs);
  const [arrows, setArrows] = useState<ReadonlyMap<number, "↑" | "↓" | null>>(new Map());
  const numberOf = useCallback((code: string) => refNumberOf(code, refs), [refs]);
  const captions = useMemo(() => captionsOf(text, numberOf), [text, numberOf]);
  const walkable = placed.length >= 2;
  const from = own ?? current;
  const startAt = (step: number) => api.start({ key: id, placed, captions, own, step }, from);
  const on = () => {
    api.paint(id, placed);
    setArrows(new Map(placed.map((p) => [p.ref.n, offscreen(p)])));
  };
  const off = () => api.paint(id, null);
  const chip = (n: number) => {
    const at = placed.findIndex((p) => p.ref.n === n);
    const here = placed[at];
    if (here === undefined) return null;
    return (
      <RefChip
        placed={here}
        own={own}
        arrow={arrows.get(n) ?? null}
        onGo={(p) => {
          if (!walkable) return api.go(p, from);
          startAt(at);
          return true;
        }}
        onHot={(hot) => api.paint(id, placed, hot)}
      />
    );
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only paint the code
    <div
      data-refs={id}
      className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ref-violet)]"
      tabIndex={walkable ? 0 : undefined}
      aria-describedby={walkable ? `${id}-steps` : undefined}
      onPointerEnter={on}
      onPointerLeave={off}
      onFocus={on}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) off();
      }}
      onKeyDown={(event) => {
        if (!walkable || event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        startAt(0);
      }}
    >
      {walkable ? (
        <p id={`${id}-steps`} className="mb-1 text-muted-foreground text-xs">
          {placed.length} places · press <kbd>Enter</kbd> to step through
        </p>
      ) : null}
      <Markdown text={text} numberOf={numberOf} chip={chip} />
    </div>
  );
}
