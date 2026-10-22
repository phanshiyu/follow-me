import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { flash } from "../lib/jump.ts";
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

type RefsApi = {
  /** Paints a reply's refs while it is hovered or focused; null clears them if `key` painted. */
  paint(key: string, placed: readonly PlacedRef[] | null, strong?: number | null): void;
  /** Jumps to a ref the page shows, with Back to the reply; false when there is nowhere to go. */
  go(placed: PlacedRef, from: number): boolean;
};

const RefsContext = createContext<RefsApi | null>(null);

function useRefsApi(): RefsApi {
  const api = useContext(RefsContext);
  if (api === null) throw new Error("useRefsApi outside RefsProvider");
  return api;
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

/** Holds which reply's refs are painted on the code, and the jump with Back to the reply. */
export function RefsProvider({ children }: { children: ReactNode }) {
  const [painted, setPainted] = useState<Painted | null>(null);
  const { depart } = useDepart();
  const show = useShow();

  useLayoutEffect(() => {
    if (painted === null) return;
    const { strong } = painted;
    return paint(painted.placed, (n) =>
      strong === null ? "light" : n === strong ? "strong" : "faint",
    );
  }, [painted]);

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
    }),
    [depart, show],
  );
  return <RefsContext value={api}>{children}</RefsContext>;
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
  const on = () => {
    api.paint(id, placed);
    setArrows(new Map(placed.map((p) => [p.ref.n, offscreen(p)])));
  };
  const off = () => api.paint(id, null);
  const chip = (n: number) => {
    const at = placed.find((p) => p.ref.n === n);
    if (at === undefined) return null;
    return (
      <RefChip
        placed={at}
        own={own}
        arrow={arrows.get(n) ?? null}
        onGo={(p) => api.go(p, own ?? current)}
        onHot={(hot) => api.paint(id, placed, hot)}
      />
    );
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only paint the code
    <div
      data-refs={id}
      className="rounded-sm"
      onPointerEnter={on}
      onPointerLeave={off}
      onFocus={on}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) off();
      }}
    >
      <Markdown text={text} numberOf={numberOf} chip={chip} />
    </div>
  );
}
