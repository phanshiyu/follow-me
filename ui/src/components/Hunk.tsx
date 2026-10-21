import { PlusIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { api } from "../lib/api.ts";
import { hunkHeader } from "../lib/commit.ts";
import { type BoxKind, composeComment, type Draft } from "../lib/compose.ts";
import type { Span } from "../lib/highlight.ts";
import { describeRows, type LineNumber, ownersOf, rowsOf, scopeOf } from "../lib/rows.ts";
import {
  anchorFor,
  lastShown,
  pickRow,
  rowsBetween,
  rowsOfAnchor,
  selectionRange,
  snapshotRows,
  stepRow,
} from "../lib/selection.ts";
import { useSpans } from "../lib/useSpans.ts";
import type { HunkLine, ProjectedCommit, TextHunk } from "../lib/wire.ts";
import { scrollToCommit, usePage } from "../page.tsx";
import { useDerived, useReview } from "../store.tsx";
import { type BoxAction, CommentBox } from "./CommentBox.tsx";
import { ThreadCard } from "./Thread.tsx";

function Code({ line, spans }: { line: HunkLine; spans: Span[] | undefined }) {
  const text = line.text.replace(/\n$/, "");
  if (spans === undefined) return <>{text || " "}</>;
  return (
    <>
      {spans.map((span, i) => (
        // Spans have no identity beyond their position in the row.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <span key={i} className={span.tone === null ? undefined : `tok-${span.tone}`}>
          {span.text}
        </span>
      ))}
    </>
  );
}

function folded(count: number, commit: number): string {
  return `${count} line${count === 1 ? "" : "s"} arrive${count === 1 ? "s" : ""} in commit ${commit + 1}`;
}

function rowOf(node: Node | null, within: HTMLElement): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>("[data-row]");
  return row && within.contains(row) ? Number(row.dataset["row"]) : null;
}

/** What the box offers. A question asks now; a flag is saved as a change request. */
export function boxActions(post: (pending: boolean, draft: Draft) => Promise<boolean>) {
  return (kind: BoxKind): BoxAction[] =>
    kind === "ask"
      ? [{ label: "Ask now", primary: true, run: (d) => post(false, d) }]
      : [{ label: "Flag", primary: true, run: (d) => post(false, d) }];
}

/**
 * One hunk as one commit shows it. The commit's own rows are the change, earlier commits' lines
 * read as context, later ones fold into a row that links down the page. Long lines wrap rather
 * than scroll, so the cards under a row and the buttons at its right edge stay in view.
 *
 * Any shown row can be picked: click or drag the gutter, shift-click to extend, or select text
 * in the code. A pick stays inside this hunk.
 */
export function Hunk({
  hunk,
  commit,
  under,
}: {
  hunk: TextHunk;
  commit: ProjectedCommit;
  /** Cards that sit under a row, keyed by body index, besides the threads this hunk places. */
  under?: ReadonlyMap<number, ReactNode>;
}) {
  const { state, run } = useReview();
  const { owners, numbers } = useDerived();
  const { pick: pagePick, setPick, box, setBox } = usePage();
  const spans = useSpans(hunk);
  const own = ownersOf(hunk, owners);
  const rows = rowsOf(hunk.body, own, commit.index);
  const visible = rows.flatMap((r) => (r.kind === "line" ? [r.line] : []));
  const at: readonly LineNumber[] = numbers.get(hunk.id) ?? [];
  const first = rows.find((r) => r.kind === "line" && r.mine);
  const scope = first?.kind === "line" ? scopeOf(hunk.body, first.line) : null;
  const pick = pagePick?.unit === hunk.id && pagePick.commit === commit.index ? pagePick : null;
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);

  const shownSet = new Set(visible);
  const threads = new Map<number, ReactNode[]>();
  const loose: ReactNode[] = [];
  for (const comment of state.comments) {
    const { anchor } = comment;
    if (anchor.kind !== "hunk" || anchor.unit !== hunk.id || anchor.commit !== commit.index)
      continue;
    const card = <ThreadCard key={comment.id} comment={comment} />;
    const row = lastShown(rowsOfAnchor(anchor, hunk.body), shownSet);
    if (row === null) loose.push(card);
    else threads.set(row, [...(threads.get(row) ?? []), card]);
  }
  const marked = new Set(
    state.comments.flatMap((c) =>
      c.anchor.kind === "hunk" && c.anchor.unit === hunk.id && c.anchor.commit === commit.index
        ? rowsOfAnchor(c.anchor, hunk.body)
        : [],
    ),
  );

  const choose = (lines: readonly number[], from: number) =>
    setPick(lines.length === 0 ? null : { commit: commit.index, unit: hunk.id, from, lines });

  // A gutter drag ends wherever the mouse is let go, even outside the hunk.
  useEffect(() => {
    if (drag === null) return;
    const up = () => {
      setDrag(null);
      if (drag.from === drag.to) {
        const next = pickRow(visible, pick, drag.from, false);
        choose(next?.lines ?? [], drag.from);
      } else choose(selectionRange(visible, drag.from, drag.to), drag.from);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  });

  const onGutterDown = (event: MouseEvent, row: number) => {
    if (event.button !== 0) return;
    // A gutter press picks rows; without this it would also start selecting page text.
    event.preventDefault();
    if (event.shiftKey) {
      const next = pickRow(visible, pick, row, true);
      choose(next?.lines ?? [], next?.from ?? row);
      return;
    }
    setDrag({ from: row, to: row });
  };

  const onCodeUp = () => {
    const root = container.current;
    const selection = window.getSelection();
    if (root === null || selection === null || selection.isCollapsed) return;
    const picked = rowsBetween(
      visible,
      rowOf(selection.anchorNode, root),
      rowOf(selection.focusNode, root),
    );
    if (picked !== null) choose(picked.lines, picked.from);
  };

  const onRowKey = (event: KeyboardEvent, row: number) => {
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move !== 0) {
      const to = stepRow(visible, row, move);
      if (event.shiftKey) {
        const base = pick ?? { from: row, lines: [row] };
        const next = pickRow(visible, base, to, true);
        choose(next?.lines ?? [], next?.from ?? row);
      }
      setFocus(to);
      container.current?.querySelector<HTMLElement>(`[data-row="${to}"]`)?.focus();
    } else if (event.key === " ") {
      const next = pickRow(visible, pick, row, event.shiftKey);
      choose(next?.lines ?? [], next?.from ?? row);
    } else return;
    event.preventDefault();
  };

  const last = pick === null ? null : Math.max(...pick.lines);
  const range = drag === null ? null : new Set(selectionRange(visible, drag.from, drag.to));
  const tabStop = focus !== null && shownSet.has(focus) ? focus : visible[0];

  const post = async (pending: boolean, draft: Draft) => {
    if (pick === null) return false;
    const anchor = anchorFor(
      { id: hunk.id, commit: commit.index, body: hunk.body, owners: own },
      pick.lines,
    );
    const context = {
      commitMessage: commit.message,
      path: hunk.path,
      lines: snapshotRows(hunk.body, pick.lines),
    };
    const ok = await run(() => api.comment(composeComment(anchor, context, draft, pending)));
    if (ok) setPick(null);
    return ok;
  };

  return (
    <div className="rounded-lg border bg-card">
      <div
        className="flex items-center gap-2 rounded-t-lg border-b bg-muted/50 px-3 py-1 font-mono text-muted-foreground text-xs"
        title={hunk.id}
      >
        <span>{hunkHeader(at)}</span>
        {scope === null ? null : <span className="text-foreground/80">{scope}</span>}
      </div>
      <div
        ref={container}
        className="font-mono text-[12.5px] leading-5"
        role="listbox"
        aria-multiselectable
        aria-label={`Rows of ${hunk.path}`}
        onMouseUp={onCodeUp}
      >
        {rows.map((row) => {
          if (row.kind === "fold") {
            return (
              <button
                key={`fold-${row.lines[0]}`}
                type="button"
                className="block w-full bg-muted/40 px-3 py-0.5 text-left font-sans text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
                onClick={() => scrollToCommit(row.commit)}
              >
                ⋯ {folded(row.lines.length, row.commit)}
              </button>
            );
          }
          const line = hunk.body[row.line];
          if (line === undefined) return null;
          const n = at[row.line];
          const op = row.mine ? line.op : " ";
          const picked = range?.has(row.line) ?? pick?.lines.includes(row.line) ?? false;
          const what = op === "+" ? "Added" : op === "-" ? "Removed" : "Context";
          return (
            <div key={row.line}>
              <div
                role="option"
                aria-selected={picked}
                aria-label={`${what} ${n?.new ?? n?.old ?? ""}: ${line.text.trim() || "blank line"}`}
                tabIndex={row.line === tabStop ? 0 : -1}
                data-row={row.line}
                onKeyDown={(event) => onRowKey(event, row.line)}
                onFocus={() => setFocus(row.line)}
                onMouseDown={(event) => {
                  if (event.target instanceof Element && event.target.closest("[data-gutter]")) {
                    onGutterDown(event, row.line);
                  }
                }}
                onMouseEnter={() => setDrag((d) => (d === null ? d : { ...d, to: row.line }))}
                className={cn(
                  "group relative flex outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  op === "+" && "bg-emerald-500/10",
                  op === "-" && "bg-rose-500/10",
                  marked.has(row.line) && "shadow-[inset_3px_0_0] shadow-amber-500/70",
                  picked && "bg-sky-500/20 shadow-[inset_3px_0_0] shadow-sky-500",
                )}
              >
                <span
                  data-gutter
                  className="flex shrink-0 cursor-pointer select-none text-muted-foreground/70"
                >
                  <span className="flex w-6 items-center justify-center">
                    <span
                      aria-hidden
                      className="hidden size-4 items-center justify-center rounded bg-sky-600 text-white group-hover:flex group-focus-visible:flex"
                    >
                      <PlusIcon className="size-3" />
                    </span>
                  </span>
                  <span className="w-10 pr-2 text-right">{n?.old ?? ""}</span>
                  <span className="w-10 pr-2 text-right">{n?.new ?? ""}</span>
                </span>
                <span
                  className={cn(
                    "w-5 shrink-0 select-none text-center",
                    op === "+" && "text-emerald-700 dark:text-emerald-400",
                    op === "-" && "text-rose-700 dark:text-rose-400",
                  )}
                >
                  {op}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap pr-28 [overflow-wrap:anywhere]">
                  <Code line={line} spans={spans?.[row.line]} />
                </span>
                {row.line === last && box === null && drag === null ? (
                  <span className="absolute top-0 right-2 flex gap-1 font-sans">
                    <button
                      type="button"
                      className="h-5 rounded bg-background px-2 text-xs shadow ring-1 ring-border hover:bg-muted"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setBox("flag")}
                    >
                      Flag
                    </button>
                    <button
                      type="button"
                      className="h-5 rounded bg-primary px-2 text-primary-foreground text-xs shadow hover:bg-primary/85"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setBox("ask")}
                    >
                      Ask
                    </button>
                  </span>
                ) : null}
              </div>
              {under?.get(row.line)}
              {threads.get(row.line)}
              {row.line === last && box !== null && pick !== null ? (
                <CommentBox
                  key={box}
                  className="my-2 ml-24 max-w-[760px]"
                  kind={box}
                  label={`${box === "ask" ? "Ask about" : "Flag"} ${describeRows(hunk.body, at, pick.lines)}`}
                  onCancel={() => setPick(null)}
                  actions={boxActions(post)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {loose.length > 0 ? <div className="border-t px-1 pb-1">{loose}</div> : null}
    </div>
  );
}
