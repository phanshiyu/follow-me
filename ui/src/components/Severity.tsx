import { cn } from "@/lib/utils";
import type { Severity } from "../lib/wire.ts";

export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];

const TONE: Record<Severity, string> = {
  blocker: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  major: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  minor: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

export function SeverityChip({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span className={cn("rounded-full px-2 py-px font-medium text-xs", TONE[severity], className)}>
      {severity}
    </span>
  );
}

/** Optional severity: clicking the chosen chip again clears it. */
export function SeverityPicker({
  value,
  onChange,
}: {
  value: Severity | null;
  onChange: (severity: Severity | null) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">Severity</legend>
      {SEVERITIES.map((level) => (
        <button
          key={level}
          type="button"
          aria-pressed={value === level}
          onClick={() => onChange(value === level ? null : level)}
          className={cn(
            "rounded-full px-2 py-px text-xs ring-1 ring-border transition-colors",
            value === level ? TONE[level] : "text-muted-foreground hover:bg-muted",
          )}
        >
          {level}
        </button>
      ))}
    </fieldset>
  );
}
