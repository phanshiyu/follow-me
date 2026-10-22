import { ArrowLeftIcon } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { api } from "../lib/api.ts";
import {
  definitionKeyHeld,
  identifierAt,
  isMac,
  isOnPage,
  labelOf,
  outcomeOf,
  type Token,
} from "../lib/definition.ts";
import { backLabel, type History, popDeparture, pushDeparture } from "../lib/history.ts";
import { flash } from "../lib/jump.ts";
import { useCodeSpans } from "../lib/useSpans.ts";
import type { Candidate } from "../lib/wire.ts";
import { scrollToSpot, spotOfViewport, usePage } from "../page.tsx";
import { useDerived, useReview } from "../store.tsx";

const MAC = isMac(navigator.platform);
const HIGHLIGHT = "definition";
/** How long the pointer rests on a name before the page asks the server about it. */
const LOOKUP_MS = 120;
/** Prism tones that are never a name the server could define. */
const NOT_A_NAME = /\btok-(string|comment|keyword|number)\b/;

type Hit = {
  readonly code: HTMLElement;
  readonly token: Token;
  readonly range: Range;
  readonly path: string;
};

/** The text node and offset that a character offset inside an element falls on. */
function rangeOf(root: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= seen + length) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}

function inside(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** The name in a hunk's code under a point, or null when the point is on anything else. */
function hitAt(x: number, y: number): Hit | null {
  const caret = document.caretPositionFromPoint(x, y);
  const node = caret?.offsetNode;
  if (caret === null || caret === undefined || !(node instanceof Text)) return null;
  const parent = node.parentElement;
  const code = parent?.closest<HTMLElement>("[data-code]");
  const path = code?.closest<HTMLElement>("[data-path]")?.dataset["path"];
  if (parent === null || code === null || code === undefined || path === undefined) return null;
  if (NOT_A_NAME.test(parent.className)) return null;
  const before = document.createRange();
  before.setStart(code, 0);
  before.setEnd(node, caret.offset);
  const token = identifierAt(code.textContent ?? "", before.toString().length);
  const range = token === null ? null : rangeOf(code, token.start, token.end);
  if (token === null || range === null) return null;
  // The caret lands on the nearest character even when the pointer is past the end of the line.
  if (![...range.getClientRects()].some((rect) => inside(rect, x, y))) return null;
  return { code, token, range, path };
}

/** Every lookup once per plan, file and name; a failed lookup counts as no definition. */
function useLookup() {
  const { state } = useReview();
  const known = useRef(new Map<string, readonly Candidate[]>());
  const asked = useRef(new Map<string, Promise<readonly Candidate[]>>());
  const plan = state.planHash;
  const keyOf = useCallback((name: string, from: string) => `${plan}\0${from}\0${name}`, [plan]);
  const lookup = useCallback(
    (name: string, from: string): Promise<readonly Candidate[]> => {
      const key = keyOf(name, from);
      const hit = asked.current.get(key);
      if (hit !== undefined) return hit;
      const ask = api
        .definition(name, from)
        .then((answer) => answer.candidates)
        .catch(() => [])
        .then((candidates) => {
          known.current.set(key, candidates);
          return candidates;
        });
      asked.current.set(key, ask);
      return ask;
    },
    [keyOf],
  );
  const cached = useCallback(
    (name: string, from: string) => known.current.get(keyOf(name, from)),
    [keyOf],
  );
  return { lookup, cached };
}

/**
 * What a peek is of: "Definition" and the candidate's kind, or "Test" and "test". `empty` says why
 * a place has no lines to show.
 */
export type Subject = { readonly title: string; readonly kind: string; readonly empty?: string };

/** A popover beside a clicked name; `from` is the commit whose code was clicked. */
type Shown = { readonly name: string; readonly from: number; readonly subject?: Subject } & (
  | { readonly kind: "choose"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "peek"; readonly candidate: Candidate }
);

export type Measurable = { getBoundingClientRect(): DOMRect };

/**
 * Goes to a place the way Cmd-click does: a jump with the Back chip when the page shows it, a
 * peek beside `near` when it does not.
 */
export type GoTo = (
  candidate: Candidate,
  name: string,
  from: number,
  near: Measurable,
  subject?: Subject,
) => void;

/** Goes to one of several places: straight there for one, the list of places for more. */
export type GoToPlaces = (
  candidates: readonly Candidate[],
  name: string,
  from: number,
  near: Measurable,
  subject?: Subject,
) => void;

/**
 * Leaves for somewhere the caller scrolls to itself, so Back returns here; `label` names what Back
 * returns to. departures counts the spots Back can still return to.
 */
export type Depart = (from: number, label?: string) => void;

type Going = {
  readonly goTo: GoTo;
  readonly goToPlaces: GoToPlaces;
  readonly depart: Depart;
  readonly departures: number;
};

const GoToContext = createContext<Going | null>(null);
export const GoToProvider = GoToContext.Provider;

function useGoToContext() {
  const value = useContext(GoToContext);
  if (value === null) throw new Error("useGoTo outside GoToProvider");
  return value;
}

export function useGoTo(): GoTo {
  return useGoToContext().goTo;
}

export function useGoToPlaces(): GoToPlaces {
  return useGoToContext().goToPlaces;
}

export function useDepart(): { depart: Depart; departures: number } {
  const { depart, departures } = useGoToContext();
  return { depart, departures };
}

/**
 * Go to definition. Holding Cmd (Ctrl off macOS) underlines a name in the code once the server
 * knows where it is defined; Cmd-click jumps there, lists the places, or peeks at code the branch
 * does not change. Back, Alt+Left or the header chip, returns to where the jump started.
 */
export function useDefinitions(): Going & { back: ReactNode; layer: ReactNode } {
  const { state } = useReview();
  const { units } = useDerived();
  const { reveal } = usePage();
  const { lookup, cached } = useLookup();
  const [history, setHistory] = useState<History>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const anchor = useRef<Measurable | null>(null);

  const jump = useCallback(
    (candidate: Candidate, from: number) => {
      const { unit, commit } = candidate;
      if (unit === null || commit === null) return;
      const spot = spotOfViewport();
      setHistory((before) => pushDeparture(before, { spot, from }));
      flushSync(() => reveal(commit, units.get(unit)?.path ?? candidate.path));
      const section = document.getElementById(`commit-${commit + 1}`);
      const hunk = section?.querySelector(`[data-unit="${CSS.escape(unit)}"]`);
      const row =
        candidate.row === null ? null : hunk?.querySelector(`[data-row="${candidate.row}"]`);
      const target = row ?? hunk ?? section;
      target?.scrollIntoView({ block: "center" });
      if (row !== null && row !== undefined) flash(row, "row-flash");
      else if (hunk !== null && hunk !== undefined) flash(hunk);
    },
    [reveal, units],
  );

  const depart = useCallback<Depart>((from, label) => {
    const spot = spotOfViewport();
    setHistory((before) =>
      pushDeparture(before, { spot, from, ...(label === undefined ? {} : { label }) }),
    );
  }, []);

  const goBack = useCallback(() => {
    setShown(null);
    setHistory((before) => {
      const popped = popDeparture(before);
      if (popped === null) return before;
      requestAnimationFrame(() => scrollToSpot(popped.spot));
      return popped.rest;
    });
  }, []);

  const open = useCallback(
    (candidate: Candidate, name: string, from: number, subject?: Subject) => {
      setShown(null);
      if (isOnPage(candidate)) jump(candidate, from);
      else setShown({ kind: "peek", name, from, candidate, ...(subject ? { subject } : {}) });
    },
    [jump],
  );

  const goTo = useCallback<GoTo>(
    (candidate, name, from, near, subject) => {
      anchor.current = near;
      setShown(null);
      if (isOnPage(candidate)) jump(candidate, from);
      else setShown({ kind: "peek", name, from, candidate, ...(subject ? { subject } : {}) });
    },
    [jump],
  );

  const goToPlaces = useCallback<GoToPlaces>(
    (candidates, name, from, near, subject) => {
      anchor.current = near;
      const outcome = outcomeOf(candidates);
      if (outcome.kind === "choose") {
        setShown({ kind: "choose", name, from, candidates, ...(subject ? { subject } : {}) });
      } else if (outcome.kind !== "none") goTo(outcome.candidate, name, from, near, subject);
    },
    [goTo],
  );

  // The pointer and the modifier, tracked outside React so moving over code never re-renders.
  useEffect(() => {
    let held = false;
    let pointer: { x: number; y: number } | null = null;
    let hovered: { code: HTMLElement; start: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clear = () => {
      clearTimeout(timer);
      CSS.highlights.delete(HIGHLIGHT);
      hovered?.code.style.removeProperty("cursor");
      hovered = null;
    };
    const underline = (hit: Hit) => {
      CSS.highlights.set(HIGHLIGHT, new Highlight(hit.range));
      hit.code.style.cursor = "pointer";
    };
    const update = () => {
      if (!held || pointer === null) return clear();
      const hit = hitAt(pointer.x, pointer.y);
      if (hit === null) return clear();
      if (hovered?.code === hit.code && hovered.start === hit.token.start) return;
      clear();
      const mine = { code: hit.code, start: hit.token.start };
      hovered = mine;
      const { name } = hit.token;
      const known = cached(name, hit.path);
      if (known !== undefined) {
        if (known.length > 0) underline(hit);
        return;
      }
      timer = setTimeout(() => {
        void lookup(name, hit.path).then((candidates) => {
          if (hovered === mine && held && candidates.length > 0) underline(hit);
        });
      }, LOOKUP_MS);
    };

    const onKey = (event: globalThis.KeyboardEvent) => {
      held = definitionKeyHeld(event, MAC);
      update();
      if (event.type !== "keydown" || !event.altKey || event.key !== "ArrowLeft") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]"))
        return;
      event.preventDefault();
      goBack();
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      held = definitionKeyHeld(event, MAC);
      update();
    };
    const onBlur = () => {
      held = false;
      clear();
    };
    // A modified press on code would start a text selection, which picks rows for a comment.
    const onDown = (event: MouseEvent) => {
      if (definitionKeyHeld(event, MAC) && hitAt(event.clientX, event.clientY) !== null)
        event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !definitionKeyHeld(event, MAC)) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit === null) return;
      event.preventDefault();
      event.stopPropagation();
      const { range } = hit;
      const { name } = hit.token;
      const from = Number(hit.code.closest<HTMLElement>("section[data-commit]")?.dataset["commit"]);
      void lookup(name, hit.path).then((candidates) => {
        const outcome = outcomeOf(candidates);
        anchor.current = { getBoundingClientRect: () => range.getBoundingClientRect() };
        if (outcome.kind === "jump") jump(outcome.candidate, from);
        else if (outcome.kind === "peek")
          setShown({ kind: "peek", name, from, candidate: outcome.candidate });
        else if (outcome.kind === "choose")
          setShown({ kind: "choose", name, from, candidates: outcome.candidates });
      });
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      clear();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", update);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [cached, lookup, jump, goBack]);

  const label = backLabel(history);
  const back =
    label === null ? null : (
      <Button
        variant="secondary"
        size="sm"
        onClick={goBack}
        title={`${label} (${MAC ? "⌥←" : "Alt+←"})`}
      >
        <ArrowLeftIcon />
        {label}
      </Button>
    );

  const layer = (
    <Popover open={shown !== null} onOpenChange={(on) => (on ? undefined : setShown(null))}>
      <PopoverAnchor virtualRef={anchor} />
      {shown === null ? null : (
        <PopoverContent
          align="start"
          className="w-[min(600px,90vw)] gap-0 p-0"
          aria-label={
            shown.kind === "choose"
              ? `${shown.subject === undefined ? "Definitions" : "Places"} of ${shown.name}`
              : `${shown.subject?.title ?? "Definition"} of ${shown.name} at ${labelOf(shown.candidate, state.commits).place}`
          }
        >
          {shown.kind === "choose" ? (
            <Choices
              name={shown.name}
              what={shown.subject === undefined ? "definitions" : "places"}
              candidates={shown.candidates}
              onPick={(candidate) => open(candidate, shown.name, shown.from, shown.subject)}
            />
          ) : (
            <Peek
              candidate={shown.candidate}
              kind={shown.subject?.kind ?? shown.candidate.kind}
              empty={shown.subject?.empty ?? "The server sent no lines for this place."}
            />
          )}
        </PopoverContent>
      )}
    </Popover>
  );

  return { back, layer, goTo, goToPlaces, depart, departures: history.length };
}

function onListKeys(event: KeyboardEvent<HTMLElement>): void {
  const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (move === 0) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("button")];
  const at = buttons.findIndex((e) => e.matches(":focus"));
  event.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, at + move))]?.focus();
}

/** Several places define the name, or hold a state: path:line and where each sits, best first. */
function Choices({
  name,
  what,
  candidates,
  onPick,
}: {
  name: string;
  what: string;
  candidates: readonly Candidate[];
  onPick: (candidate: Candidate) => void;
}) {
  const { state } = useReview();
  return (
    <div>
      <div className="border-b px-3 py-1.5 text-muted-foreground text-xs">
        {candidates.length} {what} of <code className="font-mono">{name}</code>
      </div>
      <ul className="max-h-72 overflow-y-auto py-1" onKeyDown={onListKeys}>
        {candidates.map((candidate) => {
          const label = labelOf(candidate, state.commits);
          return (
            <li key={`${label.place}-${candidate.kind}`}>
              <button
                type="button"
                className="flex w-full items-baseline gap-3 px-3 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                onClick={() => onPick(candidate)}
              >
                <span className="font-mono text-xs">{label.place}</span>
                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                  {label.where}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The definition's own lines, highlighted, for code this page does not show. A ref's peek names
 * its range and where it sits itself, and `badge` puts its number beside them and tints the lines.
 */
export function Peek({
  candidate,
  kind,
  empty,
  place,
  where,
  badge,
}: {
  candidate: Candidate;
  kind: string;
  empty: string;
  place?: string;
  where?: string;
  badge?: number;
}) {
  const { state } = useReview();
  const label = labelOf(candidate, state.commits);
  const body = useMemo(
    () => candidate.preview.map((text): { op: " "; text: string } => ({ op: " ", text })),
    [candidate],
  );
  const spans = useCodeSpans(candidate.path, body);
  return (
    <div>
      <div className="flex items-baseline gap-2 border-b px-3 py-1.5 text-xs">
        {badge === undefined ? null : <span className="ref-badge">{badge}</span>}
        <span className="font-medium font-mono">{place ?? label.place}</span>
        <span className="text-muted-foreground">{kind}</span>
        <span className="ml-auto text-muted-foreground">{where ?? label.where}</span>
      </div>
      {candidate.preview.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">{empty}</p>
      ) : null}
      <pre className="max-h-72 overflow-auto py-1.5 font-mono text-[12.5px] leading-5 empty:hidden">
        {candidate.preview.map((text, i) => (
          // Preview lines have no identity beyond their position.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <div key={i} className="flex" data-ref-tint={badge === undefined ? undefined : "strong"}>
            <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground/70">
              {candidate.newLine + i}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap pr-3 [overflow-wrap:anywhere]">
              {spans?.[i]?.map((span, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                <span key={k} className={span.tone === null ? undefined : `tok-${span.tone}`}>
                  {span.text}
                </span>
              )) ??
                (text || " ")}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
