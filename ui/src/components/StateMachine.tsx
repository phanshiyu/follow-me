import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Loc } from "../lib/coverage.ts";
import {
  BADGE,
  candidatesOf,
  describeStateMark,
  type MachineRow,
  markOfPlaces,
  placeLabel,
  rowsOfMap,
  type StateMark,
  type StateMarkKind,
  stateNodes,
} from "../lib/stateMachine.ts";
import type { StateMap } from "../lib/wire.ts";
import { usePage } from "../page.tsx";
import { useDerived, useReview } from "../store.tsx";
import { type Subject, useGoToPlaces } from "./Definition.tsx";
import { Diagram } from "./Diagram.tsx";

const SVG = "http://www.w3.org/2000/svg";
const STATE: Subject = {
  title: "State",
  kind: "state",
  empty: "This branch does not change these lines, so the page has none to show.",
};
/** How far the outlines sit outside Mermaid's own box, and the badge's radius. */
const PAD = 4;
const BADGE_R = 7;

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const made = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  made.classList.add("sm-added");
  return made;
}

const HUE: Readonly<Record<Exclude<StateMarkKind, "unknown">, string>> = {
  covered: "var(--cov-covered)",
  partly: "var(--cov-partly)",
  uncovered: "var(--cov-uncovered)",
};

/**
 * The focus ring and the mark's outline around Mermaid's box: solid when covered, dashed when
 * partly, double when not covered, so the shape says it as well as the hue.
 */
function outlines(box: DOMRect, kind: StateMarkKind): SVGRectElement[] {
  const rect = (grow: number, className: string, style: string) =>
    element("rect", {
      class: className,
      x: box.x - grow,
      y: box.y - grow,
      width: box.width + 2 * grow,
      height: box.height + 2 * grow,
      rx: 6 + grow,
      style: `fill: none; pointer-events: none; ${style}`,
    });
  const ring = rect(PAD + 4, "sm-ring", "stroke: var(--ring); stroke-width: 2px");
  if (kind === "unknown") return [ring];
  const line = (width: number, dash = "none") =>
    `stroke: ${HUE[kind]}; stroke-width: ${width}px; stroke-dasharray: ${dash}`;
  if (kind === "uncovered")
    return [ring, rect(PAD - 1, "sm-outline", line(1.5)), rect(PAD + 2, "sm-outline", line(1.5))];
  return [ring, rect(PAD, "sm-outline", kind === "partly" ? line(2, "5 3") : line(2))];
}

/** ✓, a half-filled circle, or ✕ at the box's top right corner. */
function badge(box: DOMRect, kind: StateMarkKind): SVGGElement | null {
  if (kind === "unknown") return null;
  const hue = HUE[kind];
  const cx = box.x + box.width + PAD;
  const cy = box.y - PAD;
  const group = element("g", { "aria-hidden": "true", style: "pointer-events: none" });
  const fill = kind === "partly" ? "var(--background)" : hue;
  group.append(
    element("circle", {
      cx,
      cy,
      r: BADGE_R,
      style: `fill: ${fill}; stroke: ${hue}; stroke-width: 1.5px`,
    }),
  );
  if (kind === "partly") {
    const half = `M ${cx} ${cy - BADGE_R} A ${BADGE_R} ${BADGE_R} 0 0 0 ${cx} ${cy + BADGE_R} Z`;
    group.append(element("path", { d: half, style: `fill: ${hue}; stroke: none` }));
    return group;
  }
  const mark = element("text", {
    x: cx,
    y: cy,
    "text-anchor": "middle",
    "dominant-baseline": "central",
    style: "fill: #fff; font-size: 9px; font-weight: 700; stroke: none",
  });
  mark.textContent = BADGE[kind];
  group.append(mark);
  return group;
}

/** "Uploading: partly covered, 3 of 5 lines. Reached by: a, b" for the native tooltip. */
function tooltip(name: string, mark: StateMark): string {
  const reached = mark.tests.length === 0 ? "" : `\nReached by: ${mark.tests.join(", ")}`;
  return `${name}: ${describeStateMark(mark)}${reached}`;
}

/**
 * Makes each mapped state Mermaid drew a button with its coverage outline and badge. Mermaid's
 * strict mode drops click callbacks, so this works on the SVG after it renders, and is safe to run
 * again on the same SVG when the marks change.
 */
function decorateStates(root: HTMLElement, marks: ReadonlyMap<string, StateMark>): void {
  const svg = root.querySelector("svg");
  if (svg === null) return;
  for (const added of svg.querySelectorAll(".sm-added")) added.remove();
  const nodes = [...svg.querySelectorAll("g.node[id]")].map((g) => ({
    id: g.id,
    text: g.textContent ?? "",
  }));
  const done = new Set<string>();
  for (const [name, id] of stateNodes(svg.id, nodes, [...marks.keys()])) {
    const node = svg.querySelector(`#${CSS.escape(id)}`);
    const mark = marks.get(name);
    if (!(node instanceof SVGGElement) || mark === undefined || done.has(id)) continue;
    done.add(id);
    node.setAttribute("data-pick", name);
    node.setAttribute("data-mark", mark.kind);
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-label", `${name}, ${describeStateMark(mark)}`);
    const box = node.getBBox();
    const title = element("title", {});
    title.textContent = tooltip(name, mark);
    node.prepend(title);
    node.append(...outlines(box, mark.kind));
    const shape = badge(box, mark.kind);
    if (shape !== null) node.append(shape);
  }
}

/** The mark's shape in the table and the legend, the same as on the diagram. */
function MarkBadge({ kind }: { kind: StateMarkKind }) {
  if (kind === "unknown") return null;
  return (
    <span aria-hidden data-mark={kind} className="sm-chip">
      {kind === "partly" ? null : BADGE[kind]}
    </span>
  );
}

const MARK_WORDS: Readonly<Record<StateMarkKind, string>> = {
  covered: "covered",
  partly: "partly",
  uncovered: "not covered",
  unknown: "unknown",
};

/**
 * A state machine the agent drew in reply to an offer: the diagram with each mapped state a button
 * into the code and marked with what the tests ran there, and a table of every state and move
 * under it. The table is the way to every place when the diagram cannot be matched.
 */
export function StateMachine({
  source,
  map,
  from,
  title,
}: {
  source: string;
  map: StateMap;
  /** The commit the diagram sits in, which Back names. */
  from: number;
  title: string;
}) {
  const { state, coverage: run } = useReview();
  const { coverageOn } = usePage();
  const { units, owners, numbers } = useDerived();
  const goToPlaces = useGoToPlaces();
  const coverage = coverageOn ? run : null;
  const rows = useMemo(() => rowsOfMap(map), [map]);
  const marks = useMemo(
    () => new Map(rows.map((row) => [row.key, markOfPlaces(coverage, row.at)])),
    [rows, coverage],
  );
  const stateMarks = useMemo(
    () => new Map(Object.keys(map.states).map((name) => [name, marks.get(`s:${name}`)])),
    [map, marks],
  );
  const go = useCallback(
    (name: string, at: readonly Loc[], near: Element) =>
      goToPlaces(candidatesOf(at, state.commits, units, owners, numbers), name, from, near, STATE),
    [goToPlaces, state.commits, units, owners, numbers, from],
  );
  const decorate = useCallback(
    (root: HTMLElement) => {
      const known = new Map<string, StateMark>();
      for (const [name, mark] of stateMarks) if (mark !== undefined) known.set(name, mark);
      decorateStates(root, known);
    },
    [stateMarks],
  );
  const picks = useMemo(
    () => ({
      decorate,
      onPick: (name: string, near: Element) => go(name, map.states[name] ?? [], near),
    }),
    [decorate, go, map],
  );
  const where = (loc: Loc) => {
    const [candidate] = candidatesOf([loc], state.commits, units, owners, numbers);
    return candidate?.commit === null || candidate === undefined
      ? "outside this branch"
      : `in commit ${candidate.commit + 1}`;
  };
  const places = (row: MachineRow) =>
    row.at.length === 0 ? (
      <span className="text-muted-foreground text-xs">not mapped</span>
    ) : (
      <span className="flex flex-col items-start">
        {row.at.map((loc) => (
          <button
            key={placeLabel(loc)}
            type="button"
            className="rounded text-left font-mono text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => go(row.name, [loc], event.currentTarget)}
          >
            {placeLabel(loc)} <span className="font-sans text-muted-foreground">{where(loc)}</span>
          </button>
        ))}
      </span>
    );
  const stale =
    coverage !== null && rows.some((r) => r.at.some((loc) => coverage.stale.includes(loc.path)));
  return (
    <div>
      <Diagram source={source} title={title} picks={picks} />
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
        <MarkBadge kind="covered" /> covered · <MarkBadge kind="partly" /> partly ·{" "}
        <MarkBadge kind="uncovered" /> not covered · plain unknown ·{" "}
        {coverage === null ? (
          "no test run yet"
        ) : (
          <span>
            from tests at <code className="font-mono">{coverage.tip.slice(0, 7)}</code>
            {stale ? "; files changed since read unknown" : ""}
          </span>
        )}
      </p>
      <table className="mt-3 w-full border-collapse text-sm">
        <caption className="sr-only">States and moves of {title}</caption>
        <thead className="text-left text-muted-foreground text-xs">
          <tr>
            <th className="py-1 pr-3 font-medium">State or move</th>
            <th className="hidden py-1 pr-3 font-medium xl:table-cell">Code</th>
            <th className="py-1 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mark = marks.get(row.key) ?? markOfPlaces(null, []);
            return (
              <tr key={row.key} className="border-t align-top">
                <td className="py-1.5 pr-3">
                  {row.at.length === 0 ? (
                    <span>{row.name}</span>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        "rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
                        row.kind === "state" && "font-medium",
                      )}
                      onClick={(event) => go(row.name, row.at, event.currentTarget)}
                    >
                      {row.name}
                    </button>
                  )}
                  {row.event === null ? null : (
                    <span className="ml-1.5 text-muted-foreground text-xs">on {row.event}</span>
                  )}
                  <div className="mt-0.5 xl:hidden">{places(row)}</div>
                </td>
                <td className="hidden py-1.5 pr-3 xl:table-cell">{places(row)}</td>
                <td
                  className="whitespace-nowrap py-1.5 text-xs"
                  title={
                    mark.tests.length === 0 ? undefined : `Reached by: ${mark.tests.join(", ")}`
                  }
                >
                  <span className="inline-flex items-center gap-1.5">
                    <MarkBadge kind={mark.kind} />
                    {MARK_WORDS[mark.kind]}
                    {mark.kind === "unknown" ? null : (
                      <span className="text-muted-foreground tabular-nums">
                        {mark.run}/{mark.total}
                      </span>
                    )}
                  </span>
                  {mark.tests.length === 0 ? null : (
                    <span className="block text-muted-foreground">
                      {mark.tests.length === 1 ? "1 test" : `${mark.tests.length} tests`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
