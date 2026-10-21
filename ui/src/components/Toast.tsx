import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export const TOAST_MS = 8000;

/** One toast: it goes away after `ms`, and never while the pointer is on it. */
export function Toast({
  title,
  preview,
  onView,
  onDismiss,
  ms = TOAST_MS,
}: {
  title: string;
  preview: string;
  onView: () => void;
  onDismiss: () => void;
  ms?: number;
}) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timer = setTimeout(onDismiss, ms);
    return () => clearTimeout(timer);
  }, [hovered, ms, onDismiss]);
  return (
    <article
      aria-label="Notification"
      className="pointer-events-auto w-80 rounded-lg border bg-popover p-3 text-popover-foreground text-sm shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <div className="truncate text-muted-foreground text-xs">{preview}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </div>
      <Button size="xs" className="mt-2" onClick={onView}>
        View
      </Button>
    </article>
  );
}
