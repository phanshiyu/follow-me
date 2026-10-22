import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { BoxKind, Draft } from "../lib/compose.ts";
import type { Severity } from "../lib/wire.ts";
import { SeverityPicker } from "./Severity.tsx";

const KINDS: readonly BoxKind[] = ["ask", "flag"];

/** One way to save the box. The first primary action is what Cmd+Enter does. */
export type BoxAction = {
  readonly label: string;
  readonly primary?: boolean;
  readonly run: (draft: Draft) => Promise<boolean>;
};

/**
 * A textarea with Ask or Flag. Cmd or Ctrl+Enter takes the primary action and Escape cancels. The
 * box closes only once a save went through, so a failed save keeps the text.
 */
export function CommentBox({
  kind: initialKind,
  label,
  placeholder,
  actions,
  onCancel,
  kinds = true,
  className,
  initialBody = "",
}: {
  kind: BoxKind;
  label: string;
  placeholder?: string;
  actions: (kind: BoxKind) => readonly BoxAction[];
  onCancel: () => void;
  kinds?: boolean;
  className?: string;
  /** A first line the reviewer goes on from; the caret starts after it. */
  initialBody?: string;
}) {
  const [body, setBody] = useState(initialBody);
  const caretPlaced = useRef(false);
  const [kind, setKind] = useState(initialKind);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [busy, setBusy] = useState(false);
  const available = actions(kind);
  const run = async (action: BoxAction | undefined) => {
    if (action === undefined || body.trim() === "" || busy) return;
    setBusy(true);
    const ok = await action.run({
      body: body.trim(),
      kind,
      severity: kind === "flag" ? severity : null,
    });
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <div className={cn("space-y-2 rounded-lg border bg-card p-3 font-sans shadow-sm", className)}>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span>{label}</span>
        {kinds ? (
          <fieldset className="ml-auto flex rounded-md bg-muted p-0.5">
            <legend className="sr-only">Kind</legend>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs",
                  kind === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                {k === "ask" ? "Ask" : "Flag"}
              </button>
            ))}
          </fieldset>
        ) : null}
      </div>
      <Textarea
        // The box opens because the reviewer asked for it, so typing starts at once.
        autoFocus
        aria-label={label}
        value={body}
        onFocus={(event) => {
          if (caretPlaced.current) return;
          caretPlaced.current = true;
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        placeholder={
          placeholder ?? (kind === "ask" ? "What would you like to know?" : "What should change?")
        }
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
            event.preventDefault();
            void run(available.find((a) => a.primary) ?? available[0]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {kind === "flag" && kinds ? (
          <SeverityPicker value={severity} onChange={setSeverity} />
        ) : null}
        <span className="ml-auto" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {available.map((action) => (
          <Button
            key={action.label}
            size="sm"
            variant={action.primary ? "default" : "outline"}
            disabled={busy || body.trim() === ""}
            onClick={() => void run(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
