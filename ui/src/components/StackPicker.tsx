import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { titleOf } from "../lib/commit.ts";
import { badgesOf } from "../lib/stack.ts";
import { scrollToCommit, usePage } from "../page.tsx";
import { useReview } from "../store.tsx";

/** "Commit 3 of 8 · Guard add ▾" with Prev and Next; the menu lists every commit in full. */
export function StackPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state } = useReview();
  const { current, isViewed, resolved } = usePage();
  const total = state.commits.length;
  const here = state.commits[current];
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous commit"
        disabled={current === 0}
        onClick={() => scrollToCommit(current - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 max-w-[480px] gap-1.5">
            <span className="hidden min-w-0 truncate min-[900px]:inline">
              Commit {current + 1} of {total}
              {here === undefined ? "" : ` · ${titleOf(here.message)}`}
            </span>
            <span className="min-[900px]:hidden">
              {current + 1}/{total}
            </span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="max-h-[70vh] w-[440px]">
          {state.commits.map((commit) => {
            const badges = badgesOf(commit, state.comments, state.concerns, resolved);
            return (
              <DropdownMenuItem
                key={commit.index}
                className={cn("items-start gap-2", commit.index === current && "bg-muted/60")}
                onSelect={() => scrollToCommit(commit.index)}
              >
                <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">
                  {commit.index + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-normal">{titleOf(commit.message)}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs">
                  {badges.open > 0 ? (
                    <span
                      title={`${badges.open} open thread${badges.open === 1 ? "" : "s"}`}
                      className={cn(
                        "rounded-full px-1.5 tabular-nums",
                        badges.waiting > 0
                          ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                          : "bg-muted",
                      )}
                    >
                      {badges.open}
                    </span>
                  ) : null}
                  {badges.undecided > 0 ? (
                    <span
                      title="Agent concerns to decide"
                      className="size-2 rounded-full bg-amber-500"
                    />
                  ) : null}
                  {isViewed(commit) ? (
                    <CheckIcon aria-label="Viewed" className="size-4 text-emerald-600" />
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next commit"
        disabled={current >= total - 1}
        onClick={() => scrollToCommit(current + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
