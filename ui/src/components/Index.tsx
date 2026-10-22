import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { filesOf, sectionLabel, titleOf } from "../lib/commit.ts";
import { describeEntry, groupsOf, type Marks, progressOf, unreadByCommit } from "../lib/outline.ts";
import { badgesOf } from "../lib/stack.ts";
import { scrollToCommit, usePage } from "../page.tsx";
import { useDerived, usePlacements, useReview } from "../store.tsx";

/** The marks of every commit, by index. */
function useMarks(): readonly Marks[] {
  const { state, unread } = useReview();
  const { isViewed, resolved } = usePage();
  const placements = usePlacements();
  return useMemo(() => {
    const commitOf = new Map<string, number>();
    for (const c of state.comments)
      if (c.anchor.kind !== "plan") commitOf.set(c.id, c.anchor.commit);
    for (const p of placements) if (p.commit !== null) commitOf.set(p.comment.id, p.commit);
    const unreadAt = unreadByCommit(unread, commitOf);
    return state.commits.map((commit) => {
      const badges = badgesOf(commit, state.comments, state.concerns, resolved);
      return {
        viewed: isViewed(commit),
        open: badges.open,
        waiting: badges.waiting,
        unread: unreadAt.get(commit.index) ?? 0,
        undecided: badges.undecided,
      };
    });
  }, [state.commits, state.comments, state.concerns, resolved, unread, placements, isViewed]);
}

/** Up, Down, Home and End move between the index's commits; only the current one is a tab stop. */
function onEntryKeys(event: KeyboardEvent<HTMLElement>): void {
  const entries = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-entry]")];
  const at = entries.findIndex((e) => e.matches(":focus"));
  const to =
    event.key === "ArrowDown"
      ? at + 1
      : event.key === "ArrowUp"
        ? at - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? entries.length - 1
            : null;
  if (to === null || at < 0) return;
  event.preventDefault();
  entries[Math.max(0, Math.min(entries.length - 1, to))]?.focus();
}

/** Keeps the current commit's entry inside the index's own scroll, without moving the page. */
function useKeepInView(current: number) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scroller.current;
    const entry = box?.querySelector<HTMLElement>(`[data-entry="${current}"]`);
    if (box === null || box === undefined || entry === null || entry === undefined) return;
    const top = entry.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + entry.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top + entry.offsetHeight - box.clientHeight;
  }, [current]);
  return scroller;
}

function Dot({ tone }: { tone: "unread" | "concern" }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 rounded-full", tone === "unread" ? "bg-violet-500" : "bg-amber-500")}
    />
  );
}

function EntryMarks({ marks }: { marks: Marks }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px]">
      {marks.viewed ? <CheckIcon className="size-3.5 text-emerald-600" /> : null}
      {marks.open > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 font-medium tabular-nums leading-4",
            marks.waiting > 0
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {marks.open}
        </span>
      ) : null}
      {marks.unread > 0 ? <Dot tone="unread" /> : null}
      {marks.undecided > 0 ? <Dot tone="concern" /> : null}
    </span>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border bg-background px-1 font-mono text-[10px] leading-4">
      {children}
    </kbd>
  );
}

/**
 * The index: every commit under its section heading with its marks, the current one bold with its
 * files beneath. Clicking a commit scrolls to it.
 */
function IndexPanel() {
  const { state } = useReview();
  const { units } = useDerived();
  const { current, setIndexOpen } = usePage();
  const marks = useMarks();
  const scroller = useKeepInView(current);
  const groups = groupsOf(state.commits);
  const viewed = marks.filter((m) => m.viewed).length;
  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-between pr-2 pl-3">
        <span className="font-semibold text-[11px] text-muted-foreground tracking-widest">
          INDEX
        </span>
        <button
          type="button"
          aria-label="Hide index"
          title="Hide index ([)"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setIndexOpen(false)}
        >
          <Kbd>[</Kbd> hide
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the buttons inside */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-2" onKeyDown={onEntryKeys}>
        {groups.map((group) => (
          <div key={`${group.section}-${group.commits[0]?.index}`}>
            {group.section === null ? null : (
              <h3 className="px-3 pt-3 pb-1 font-medium text-muted-foreground text-xs">
                {sectionLabel(group.section)}
              </h3>
            )}
            <ul>
              {group.commits.map((commit) => {
                const mine = marks[commit.index] ?? {
                  viewed: false,
                  open: 0,
                  waiting: 0,
                  unread: 0,
                  undecided: 0,
                };
                const here = commit.index === current;
                return (
                  <li key={commit.index}>
                    <button
                      type="button"
                      data-entry={commit.index}
                      tabIndex={here ? 0 : -1}
                      aria-current={here ? "location" : undefined}
                      aria-label={describeEntry(commit, mine)}
                      onClick={() => scrollToCommit(commit.index)}
                      className={cn(
                        "flex w-full items-start gap-2 py-1 pr-2 pl-3 text-left text-[13px] leading-5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        here &&
                          "bg-sky-500/10 font-semibold shadow-[inset_3px_0_0] shadow-sky-500 hover:bg-sky-500/15",
                      )}
                    >
                      <span className="w-4 shrink-0 text-right font-normal text-muted-foreground tabular-nums">
                        {commit.index + 1}
                      </span>
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {titleOf(commit.message)}
                      </span>
                      <EntryMarks marks={mine} />
                    </button>
                    {here ? (
                      <ul
                        aria-label={`Files in commit ${commit.index + 1}`}
                        className="space-y-0.5 bg-sky-500/5 pt-0.5 pr-2 pb-1.5 pl-9 font-mono text-[11px] text-muted-foreground"
                      >
                        {filesOf(commit, units).map((file) => (
                          <li key={file.path} className="[overflow-wrap:anywhere]">
                            {file.path}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t px-3 py-2 text-muted-foreground text-xs">
        <div>{progressOf(marks)}</div>
        <div
          role="progressbar"
          aria-label="Commits viewed"
          aria-valuemin={0}
          aria-valuemax={marks.length}
          aria-valuenow={viewed}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${marks.length === 0 ? 0 : (100 * viewed) / marks.length}%` }}
          />
        </div>
      </div>
    </>
  );
}

/** The collapsed index: a rail of numbers with the same marks, named in full by a tooltip. */
function IndexRail() {
  const { state } = useReview();
  const { current, setIndexOpen } = usePage();
  const marks = useMarks();
  const scroller = useKeepInView(current);
  const groups = groupsOf(state.commits);
  return (
    <TooltipProvider delayDuration={150}>
      <button
        type="button"
        aria-label="Show index"
        title="Show index ([)"
        className="mx-auto mt-2 mb-1 flex shrink-0 rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setIndexOpen(true)}
      >
        <Kbd>[</Kbd>
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the buttons inside */}
      <div
        ref={scroller}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-2"
        onKeyDown={onEntryKeys}
      >
        {groups.map((group, g) => (
          <div key={`${group.section}-${group.commits[0]?.index}`}>
            {g > 0 && group.section !== null ? (
              <hr aria-hidden className="mx-auto my-1.5 w-4 border-border" />
            ) : null}
            <ul>
              {group.commits.map((commit) => {
                const mine = marks[commit.index];
                const here = commit.index === current;
                const name =
                  mine === undefined ? `${commit.index + 1}` : describeEntry(commit, mine);
                return (
                  <li key={commit.index}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-entry={commit.index}
                          tabIndex={here ? 0 : -1}
                          aria-current={here ? "location" : undefined}
                          aria-label={name}
                          onClick={() => scrollToCommit(commit.index)}
                          className={cn(
                            "relative flex h-7 w-full items-center justify-center text-muted-foreground text-xs tabular-nums outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                            mine?.viewed && "text-emerald-700 dark:text-emerald-400",
                            here &&
                              "bg-sky-500/10 font-semibold text-foreground shadow-[inset_3px_0_0] shadow-sky-500",
                          )}
                        >
                          {commit.index + 1}
                          {mine?.viewed ? (
                            <CheckIcon
                              aria-hidden
                              className="absolute top-0.5 right-1 size-2.5 text-emerald-600"
                            />
                          ) : null}
                          <span aria-hidden className="absolute right-1 bottom-1 flex gap-0.5">
                            {mine !== undefined && mine.unread > 0 ? (
                              <span className="size-1.5 rounded-full bg-violet-500" />
                            ) : null}
                            {mine !== undefined && mine.undecided > 0 ? (
                              <span className="size-1.5 rounded-full bg-amber-500" />
                            ) : null}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={6}>
                        {name}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

/** The index column, sticky under the page header, 216px open or a 40px rail. */
export function Index() {
  const { indexOpen } = usePage();
  return (
    <nav
      aria-label="Index"
      className={cn(
        "sticky top-11 flex h-[calc(100vh-2.75rem)] shrink-0 flex-col border-r bg-muted/20",
        indexOpen ? "w-[216px]" : "w-10",
      )}
    >
      {indexOpen ? <IndexPanel /> : <IndexRail />}
    </nav>
  );
}

/** Focuses the current commit in the index, for `s` while the stack menu is hidden. */
export function focusIndex(): void {
  document
    .querySelector<HTMLElement>('nav[aria-label="Index"] [data-entry][aria-current]')
    ?.focus();
}
