import { BellIcon, EllipsisIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { jumpToThread } from "../lib/jump.ts";
import { type Notice, noticeOf, titleOfNotice } from "../lib/unread.ts";
import { usePage } from "../page.tsx";
import { useReview } from "../store.tsx";
import { Toast } from "./Toast.tsx";

type Shown = { readonly key: string; readonly notice: Notice; readonly title: string };

/** Marks the notice seen and takes the reviewer to its thread. */
function useOpen() {
  const { markSeen } = useReview();
  return useCallback(
    (notice: Notice) => {
      markSeen([notice.key]);
      if (notice.thread !== null) jumpToThread(notice.thread);
    },
    [markSeen],
  );
}

function useHidden(): boolean {
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

/**
 * The agent's answers as they arrive: a stacked toast for each, a native notification when the tab
 * is in the background and the reviewer asked for them, and the unread count in the tab title.
 */
export function Notices() {
  const { state, events, unread } = useReview();
  const { notify } = usePage();
  const open = useOpen();
  const hidden = useHidden();
  const [toasts, setToasts] = useState<readonly Shown[]>([]);
  const handled = useRef(0);
  const latest = useRef(state);
  latest.current = state;
  const base = useRef(document.title);

  useEffect(() => {
    const fresh = events.slice(handled.current);
    handled.current = events.length;
    const shown = fresh.flatMap((event): Shown[] => {
      const notice = noticeOf(event);
      return notice === null
        ? []
        : [{ key: notice.key, notice, title: titleOfNotice(notice, latest.current) }];
    });
    if (shown.length === 0) return;
    setToasts((before) => [
      ...before,
      ...shown.filter((s) => !before.some((b) => b.key === s.key)),
    ]);
    if (document.hidden && notify && Notification.permission === "granted") {
      for (const { notice, title } of shown) {
        const native = new Notification(title, { body: notice.preview, tag: notice.key });
        native.onclick = () => {
          window.focus();
          open(notice);
          native.close();
        };
      }
    }
  }, [events, notify, open]);

  useEffect(() => {
    document.title =
      hidden && unread.length > 0 ? `(${unread.length}) ${base.current}` : base.current;
    return () => {
      document.title = base.current;
    };
  }, [hidden, unread.length]);

  const dismiss = useCallback(
    (key: string) => setToasts((before) => before.filter((t) => t.key !== key)),
    [],
  );
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
    >
      {toasts.map(({ key, notice, title }) => (
        <Toast
          key={key}
          title={title}
          preview={notice.preview}
          onView={() => {
            open(notice);
            dismiss(key);
          }}
          onDismiss={() => dismiss(key)}
        />
      ))}
    </section>
  );
}

/** "2 new" in the header: each answer not yet seen, by place and first words. */
export function UnreadMenu() {
  const { state, unread } = useReview();
  const open = useOpen();
  if (unread.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`${unread.length} new from the agent`}>
          <BellIcon />
          {unread.length} new
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {unread.map((notice) => (
          <DropdownMenuItem
            key={notice.key}
            className="flex-col items-start gap-0"
            onSelect={() => open(notice)}
          >
            <span className="font-medium">{titleOfNotice(notice, state)}</span>
            <span className="max-w-full truncate text-muted-foreground text-xs">
              {notice.preview}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header's ⋯: where the reviewer opts into native notifications. */
export function PageOptions() {
  const { notify, setNotify } = usePage();
  const blocked = !("Notification" in window) || Notification.permission === "denied";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Page options">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuCheckboxItem
          checked={notify}
          disabled={blocked}
          onCheckedChange={(on) => void setNotify(on)}
        >
          Notify me when the agent replies
        </DropdownMenuCheckboxItem>
        {blocked ? (
          <p className="px-2 pb-1.5 text-muted-foreground text-xs">
            Notifications are blocked in this browser.
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
