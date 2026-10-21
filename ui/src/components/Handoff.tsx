import { ArrowLeftIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, sessionPrefix } from "../lib/api.ts";
import {
  changedOf,
  isIncluded,
  locationOf,
  markdownOf,
  sourceOf,
  splitAnswer,
} from "../lib/report.ts";
import { navigate } from "../lib/route.ts";
import type { ReportItem } from "../lib/wire.ts";
import { useReview } from "../store.tsx";
import { Check } from "./Check.tsx";
import { Markdown } from "./Markdown.tsx";
import { SeverityChip } from "./Severity.tsx";

const COMMAND = "follow-me report --json";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      <CopyIcon />
      {done ? "Copied" : label}
    </Button>
  );
}

const KIND: Record<ReportItem["kind"], string> = {
  flag: "Flag",
  question: "Question",
  concern: "Kept concern",
};

function ItemCard({
  item,
  included,
  onInclude,
  lines,
  toggleable,
}: {
  item: ReportItem;
  included: boolean;
  onInclude: (included: boolean) => void;
  lines: readonly string[];
  toggleable: boolean;
}) {
  const location = locationOf(item);
  const changed = changedOf(item);
  const { said, answer } = splitAnswer(item.body);
  const rest = item.thread.filter(
    (entry) => answer === null || entry.body.trim() !== answer.trim(),
  );
  return (
    <article
      aria-label={`${KIND[item.kind]} ${location ?? "on the branch"}`}
      className={cn("rounded-lg border bg-card p-4 text-sm", !included && "opacity-60")}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {toggleable ? (
          <Check
            checked={included}
            onChange={onInclude}
            name={`Include ${location ?? KIND[item.kind]}`}
          >
            Include
          </Check>
        ) : null}
        {item.kind === "question" && !item.resolved ? (
          <span className="text-amber-700 text-xs dark:text-amber-300">still open</span>
        ) : null}
        <span className="font-mono text-xs">{location ?? "General"}</span>
        {item.severity === null ? null : <SeverityChip severity={item.severity} />}
        <span className="text-muted-foreground text-xs">{KIND[item.kind]}</span>
        {item.resolved ? <span className="text-muted-foreground text-xs">✓ resolved</span> : null}
        {changed === null ? null : (
          <span className="text-amber-700 text-xs dark:text-amber-300">{changed}</span>
        )}
        <span className="ml-auto flex gap-1">
          <CopyButton text={item.body} label="Copy comment" />
          {location === null ? null : (
            <CopyButton text={location.replace(/ \((new|old)\)$/, "")} label="Copy path:line" />
          )}
        </span>
      </div>
      {lines.length > 0 ? (
        <pre className="mb-2 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
          {lines.join("\n")}
        </pre>
      ) : null}
      {/* The chip already shows the severity line the body opens with. */}
      <Markdown text={said.replace(/^\*\*(blocker|major|minor)\*\*\n\n/, "")} />
      {answer === null ? null : (
        <div className="mt-3 border-sky-500/60 border-l-2 pl-3">
          <div className="mb-1 font-medium text-xs">Agent</div>
          <Markdown text={answer} />
        </div>
      )}
      {rest.length === 0 ? null : (
        <details className="mt-3 text-muted-foreground">
          <summary className="cursor-pointer text-xs">{rest.length} more in the thread</summary>
          <div className="mt-2 space-y-2">
            {rest.map((entry, i) => (
              // The thread is a fixed list in the order it was said.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <div key={i}>
                <div className="font-medium text-foreground text-xs">
                  {entry.author === "agent" ? "Agent" : "You"}
                </div>
                <Markdown text={entry.body} />
              </div>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

/**
 * The hand-off to the merge request: every item with its place on the original branch, which ones
 * to carry over, and the ways to carry them (copy, report.json, or the command for the agent).
 */
export function Handoff() {
  const { state, run, ended } = useReview();
  const [items, setItems] = useState<readonly ReportItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [handedBack, setHandedBack] = useState(false);
  useEffect(() => {
    api
      .report()
      .then(setItems)
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  const sources = (items ?? []).map((item) => sourceOf(item, state));
  const included = (items ?? []).filter((item, i) =>
    isIncluded(item, overrides, sources[i]?.id ?? null),
  );
  const toggle = async (id: string, include: boolean) => {
    setOverrides((before) => new Map(before).set(id, include));
    const ok = await run(() => api.exclude(id, !include));
    if (!ok) setOverrides((before) => new Map(before).set(id, !include));
  };
  const finish = async () => {
    if (await run(() => api.end())) setHandedBack(true);
  };

  const groups = new Map<string, number[]>();
  (items ?? []).forEach((item, i) => {
    const key = item.path ?? "";
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const ordered = [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 h-11 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1232px] items-center gap-3 px-6 text-sm">
          <strong>follow-me</strong>
          <span className="min-w-0 truncate text-muted-foreground">
            · {state.anchor.branch} → {state.anchor.baseRef} · plan v{state.version} · hand-off
          </span>
          {ended || handedBack ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => navigate("review")}
            >
              <ArrowLeftIcon />
              Back to review
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[920px] space-y-6 px-6 py-8">
        <section className="space-y-3">
          <h1 className="font-semibold text-xl">Carry the review to the merge request</h1>
          <p className="max-w-[72ch] text-muted-foreground text-sm">
            Lines are the original branch's, so they match the merge request against the same base.
            Flags and kept concerns go by default; tick a question to ask the author too.
          </p>
          {items === null ? null : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {included.length} included · {items.length - included.length} excluded
              </span>
              <span className="ml-auto" />
              <CopyButton text={markdownOf(included)} label="Copy all as markdown" />
              <Button variant="ghost" size="xs" asChild>
                <a href={`${sessionPrefix}/api/report?format=json`} download="report.json">
                  <DownloadIcon />
                  report.json
                </a>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Or ask your agent to run</span>
            <code className="font-mono">{COMMAND}</code>
            <span className="ml-auto">
              <CopyButton text={COMMAND} label="Copy" />
            </span>
          </div>
        </section>
        {failure === null ? null : (
          <p role="alert" className="text-rose-700 text-sm dark:text-rose-300">
            The report did not load: {failure}
          </p>
        )}
        {items !== null && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing to carry over: no flags, kept concerns or questions.
          </p>
        ) : null}
        {ordered.map(([path, indexes]) => (
          <section key={path} className="space-y-2" aria-label={path === "" ? "General" : path}>
            <h2 className="font-medium font-mono text-sm">{path === "" ? "General" : path}</h2>
            {indexes.map((i) => {
              const item = items?.[i];
              if (item === undefined) return null;
              const source = sources[i] ?? null;
              return (
                <ItemCard
                  key={source?.id ?? `item-${i}`}
                  item={item}
                  lines={source?.comment?.context.lines ?? []}
                  toggleable={source !== null}
                  included={isIncluded(item, overrides, source?.id ?? null)}
                  onInclude={(on) => source !== null && void toggle(source.id, on)}
                />
              );
            })}
          </section>
        ))}
        <section className="flex items-center gap-3 border-t pt-6 text-sm">
          {ended || handedBack ? (
            <p className="text-muted-foreground">
              The review is handed back. Your agent reads it with{" "}
              <code className="font-mono">{COMMAND}</code>.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                Done here? Ending the review hands it back to your agent.
              </p>
              <Button className="ml-auto" onClick={() => void finish()}>
                End review
              </Button>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
