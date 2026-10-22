import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Loc } from "../lib/coverage.ts";
import {
  BADGE,
  candidatesOf,
  type DrawnEdge,
  describeEdgeMark,
  describeStateMark,
  type EdgeMark,
  type EdgeMarkKind,
  edgesOfMap,
  hasPerTest,
  type MachineRow,
  markOfEdge,
  markOfPlaces,
  notDriven,
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
import { NotDriven } from "./NotDriven.tsx";

const SVG = "http://www.w3.org/2000/svg";
const STATE: Subject = {
  title: "State",
  kind: "state",
  empty: "This branch does not change these lines, so the page has none to show.",
};
const MOVE: Subject = { ...STATE, title: "Transition", kind: "transition" };
/** How far the outlines sit outside Mermaid's own box, and the badge's radius. */
const PAD = 4;
const BADGE_R = 7;
/** The data-pick value of transition i, beside the state names states use. */
const EDGE_PICK = /^edge:(\d+)$/;

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

/** A filled circle with white text in it: ✓, ✕ or a test count. */
function textBadge(cx: number, cy: number, hue: string, text: string): SVGGElement {
  const group = element("g", { "aria-hidden": "true", style: "pointer-events: none" });
  group.append(
    element("circle", {
      cx,
      cy,
      r: BADGE_R,
      style: `fill: ${hue}; stroke: ${hue}; stroke-width: 1.5px`,
    }),
  );
  const mark = element("text", {
    x: cx,
    y: cy,
    "text-anchor": "middle",
    "dominant-baseline": "central",
    style: "fill: #fff; font-size: 9px; font-weight: 700; stroke: none",
  });
  mark.textContent = text;
  group.append(mark);
  return group;
}

/** ✓, a half-filled circle, or ✕ at the box's top right corner. */
function badge(box: DOMRect, kind: StateMarkKind): SVGGElement | null {
  if (kind === "unknown") return null;
  const hue = HUE[kind];
  const cx = box.x + box.width + PAD;
  const cy = box.y - PAD;
  if (kind !== "partly") return textBadge(cx, cy, hue, BADGE[kind]);
  const group = element("g", { "aria-hidden": "true", style: "pointer-events: none" });
  group.append(
    element("circle", {
      cx,
      cy,
      r: BADGE_R,
      style: `fill: var(--background); stroke: ${hue}; stroke-width: 1.5px`,
    }),
  );
  const half = `M ${cx} ${cy - BADGE_R} A ${BADGE_R} ${BADGE_R} 0 0 0 ${cx} ${cy + BADGE_R} Z`;
  group.append(element("path", { d: half, style: `fill: ${hue}; stroke: none` }));
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
function decorateStates(svg: SVGSVGElement, marks: ReadonlyMap<string, StateMark>): void {
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

/** How far a point is from a box, 0 inside it. */
function distance(x: number, y: number, box: DOMRect): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Every edge Mermaid drew, with the mapped states nearest its two ends on screen and its label.
 * Mermaid's stateDiagram-v2 (12.x) ids an edge's path `<svg id>-edge<n>` and gives its label
 * `data-id="edge<n>"`; its ends lie on the boxes of the states it joins.
 */
function drawnEdges(svg: SVGSVGElement, names: readonly string[]): DrawnEdge[] {
  const nodes = [...svg.querySelectorAll("g.node[id]")].map((g) => ({
    id: g.id,
    text: g.textContent ?? "",
    box: g.getBoundingClientRect(),
  }));
  const nameOf = new Map([...stateNodes(svg.id, nodes, names)].map(([name, id]) => [id, name]));
  const nearest = (x: number, y: number): string | null => {
    let best: { id: string; d: number } | null = null;
    for (const node of nodes) {
      const d = distance(x, y, node.box);
      if (best === null || d < best.d) best = { id: node.id, d };
    }
    return best === null ? null : (nameOf.get(best.id) ?? null);
  };
  const prefix = `${svg.id}-`;
  return [...svg.querySelectorAll("path[id]")].flatMap((path): DrawnEdge[] => {
    if (!(path instanceof SVGPathElement) || !/^edge\d+$/.test(path.id.slice(prefix.length))) {
      return [];
    }
    const ctm = path.getScreenCTM();
    const length = path.getTotalLength();
    if (ctm === null || length === 0) return [];
    const at = (l: number) => new DOMPoint(path.getPointAtLength(l).x, path.getPointAtLength(l).y);
    const start = at(0).matrixTransform(ctm);
    const end = at(length).matrixTransform(ctm);
    const key = path.id.slice(prefix.length);
    const label = svg.querySelector(`.edgeLabel [data-id="${CSS.escape(key)}"]`);
    return [
      {
        id: path.id,
        from: nearest(start.x, start.y),
        to: nearest(end.x, end.y),
        label: label?.textContent?.trim() ?? "",
      },
    ];
  });
}

/**
 * Where an edge's badge goes, in the path's own coordinates: just right of its label when Mermaid
 * drew one, else on the middle of the line.
 */
function badgePlace(path: SVGPathElement, label: Element | null): { x: number; y: number } {
  const box = label?.getBoundingClientRect();
  const ctm = path.getScreenCTM();
  if (box === undefined || box.width === 0 || ctm === null) {
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    return { x: middle.x, y: middle.y };
  }
  const right = new DOMPoint(box.right, box.top + box.height / 2).matrixTransform(ctm.inverse());
  return { x: right.x + BADGE_R + 2, y: right.y };
}

/** The edge's own look, kept so a later pass can put it back before marking it again. */
function restyle(path: SVGPathElement, style: string): void {
  const original = path.getAttribute("data-sm-style") ?? path.getAttribute("style") ?? "";
  path.setAttribute("data-sm-style", original);
  path.setAttribute("style", `${original}; ${style}`);
}

const EDGE_LINE: Readonly<Record<EdgeMarkKind, string>> = {
  covered: "stroke: var(--cov-covered); stroke-width: 2px; stroke-dasharray: none",
  uncovered: "stroke: var(--cov-uncovered); stroke-width: 2px; stroke-dasharray: 6 4",
  unknown: "",
};

/** One transition as the diagram marks it. */
export type EdgeDecoration = {
  readonly index: number;
  readonly name: string;
  readonly mark: EdgeMark;
};

/**
 * Colours each matched edge by its mark, solid green with its test count, red and dashed with ✕,
 * or plain when unknown, and lays a wide transparent copy over it that is the button: it jumps to
 * the transition's code, and its tooltip lists the tests that take it.
 */
function decorateEdges(
  svg: SVGSVGElement,
  map: StateMap,
  edges: readonly EdgeDecoration[],
  perTest: boolean,
  /** Transitions of the sequence the reader asked to see, outlined under their edges. */
  outlined: ReadonlySet<number>,
): void {
  const transitions = map.transitions ?? [];
  const ids = edgesOfMap(transitions, drawnEdges(svg, Object.keys(map.states)));
  for (const { index, name, mark } of edges) {
    const id = ids.get(index);
    const path = id === undefined ? null : svg.querySelector(`#${CSS.escape(id)}`);
    if (id === undefined || !(path instanceof SVGPathElement)) continue;
    const label = svg.querySelector(
      `.edgeLabel [data-id="${CSS.escape(id.slice(svg.id.length + 1))}"]`,
    );
    restyle(path, EDGE_LINE[mark.kind]);
    if (outlined.has(index)) {
      path.before(
        element("path", {
          class: "sm-sequence",
          d: path.getAttribute("d") ?? "",
          style:
            "fill: none; pointer-events: none; stroke: var(--cov-uncovered); stroke-opacity: 0.35; stroke-width: 9px; stroke-linecap: round; stroke-dasharray: 10 6",
        }),
      );
    }
    path.setAttribute("data-mark", mark.kind);
    const d = path.getAttribute("d") ?? "";
    const said = describeEdgeMark(mark, perTest);
    const button = element("g", {
      "data-pick": `edge:${index}`,
      "data-edge-mark": mark.kind,
      role: "button",
      tabindex: 0,
      "aria-label": `${name}, ${said}`,
    });
    const title = element("title", {});
    const taken = mark.tests.length === 0 ? "" : `\nTaken by: ${mark.tests.join(", ")}`;
    title.textContent = `${name}: ${said}${taken}`;
    button.append(
      title,
      element("path", {
        class: "sm-ring",
        d,
        style: "fill: none; stroke: var(--ring); stroke-width: 6px; stroke-opacity: 0.5",
      }),
      element("path", {
        d,
        style: "fill: none; stroke: transparent; stroke-width: 14px; pointer-events: stroke",
      }),
    );
    if (mark.kind !== "unknown") {
      const { x, y } = badgePlace(path, label);
      const text =
        mark.kind === "uncovered" ? BADGE.uncovered : perTest ? String(mark.tests.length) : "✓";
      const shape = textBadge(x, y, HUE[mark.kind], text);
      // On an edge the badge is a bigger target than the line, so it takes the click too.
      shape.setAttribute("style", "pointer-events: all");
      shape.setAttribute("data-edge-badge", "");
      button.append(shape);
    }
    // The label Mermaid drew is part of the same button for a pointer.
    label?.setAttribute("data-pick", `edge:${index}`);
    path.after(button);
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

/** A short line in the legend drawn as the edges are: solid, dashed or plain. */
function EdgeSwatch({ kind }: { kind: EdgeMarkKind }) {
  const hue = kind === "unknown" ? "var(--muted-foreground)" : HUE[kind];
  return (
    <svg aria-hidden width="18" height="6" className="inline-block">
      <line
        x1="0"
        y1="3"
        x2="18"
        y2="3"
        style={{
          stroke: hue,
          strokeWidth: kind === "unknown" ? 1.3 : 2,
          strokeDasharray: kind === "uncovered" ? "4 3" : "none",
        }}
      />
    </svg>
  );
}

const MARK_WORDS: Readonly<Record<StateMarkKind, string>> = {
  covered: "covered",
  partly: "partly",
  uncovered: "not covered",
  unknown: "unknown",
};

/** Up to two test names as chips, then "+N" with every name in its tooltip. */
function TestChips({ tests }: { tests: readonly string[] }) {
  const more = tests.length - 2;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tests.slice(0, 2).map((id) => (
        <span key={id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {id}
        </span>
      ))}
      {more > 0 ? (
        <span className="text-muted-foreground" title={tests.join("\n")}>
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A state machine the agent drew in reply to an offer: the diagram with each mapped state and
 * transition a button into the code, marked with what the tests ran there, and a table of every
 * state and move under it. The table is the way to every place when the diagram cannot be matched.
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
  const perTest = hasPerTest(coverage);
  const edgeMarks = useMemo(
    () => (map.transitions ?? []).map((t) => markOfEdge(coverage, t.at)),
    [map, coverage],
  );
  const rows = useMemo(() => rowsOfMap(map, edgeMarks), [map, edgeMarks]);
  const marks = useMemo(
    () => new Map(rows.map((row) => [row.key, markOfPlaces(coverage, row.at)])),
    [rows, coverage],
  );
  const stateMarks = useMemo(() => {
    const known = new Map<string, StateMark>();
    for (const name of Object.keys(map.states)) {
      const mark = marks.get(`s:${name}`);
      if (mark !== undefined) known.set(name, mark);
    }
    return known;
  }, [map, marks]);
  const go = useCallback(
    (name: string, at: readonly Loc[], near: Element, subject: Subject = STATE) =>
      goToPlaces(
        candidatesOf(at, state.commits, units, owners, numbers),
        name,
        from,
        near,
        subject,
      ),
    [goToPlaces, state.commits, units, owners, numbers, from],
  );
  const edges = useMemo(
    () =>
      (map.transitions ?? []).map(
        (t, index): EdgeDecoration => ({
          index,
          name: `${t.from} → ${t.to}`,
          mark: edgeMarks[index] ?? markOfEdge(null, []),
        }),
      ),
    [map, edgeMarks],
  );
  const sequences = useMemo(
    () => (perTest ? notDriven(map, source, edgeMarks) : []),
    [perTest, map, source, edgeMarks],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const shown = hovered ?? pinned;
  const outlined = useMemo(
    () => new Set(shown === null ? [] : (sequences[shown]?.moves ?? [])),
    [shown, sequences],
  );
  const decorate = useCallback(
    (root: HTMLElement) => {
      const svg = root.querySelector("svg");
      if (svg === null) return;
      for (const added of svg.querySelectorAll(".sm-added")) added.remove();
      decorateStates(svg, stateMarks);
      decorateEdges(svg, map, edges, perTest, outlined);
    },
    [stateMarks, map, edges, perTest, outlined],
  );
  const picks = useMemo(
    () => ({
      decorate,
      onPick: (value: string, near: Element) => {
        const edge = EDGE_PICK.exec(value);
        const move = edge === null ? undefined : map.transitions?.[Number(edge[1])];
        if (move === undefined) go(value, map.states[value] ?? [], near);
        else go(`${move.from} → ${move.to}`, move.at, near, MOVE);
      },
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
            onClick={(event) =>
              go(row.name, [loc], event.currentTarget, row.kind === "move" ? MOVE : STATE)
            }
          >
            {placeLabel(loc)} <span className="font-sans text-muted-foreground">{where(loc)}</span>
          </button>
        ))}
      </span>
    );
  const stale =
    coverage !== null && rows.some((r) => r.at.some((loc) => coverage.stale.includes(loc.path)));
  const edgeOf = (row: MachineRow): EdgeMark | null =>
    row.kind === "move" ? (edgeMarks[Number(row.key.slice(2))] ?? null) : null;
  return (
    <div>
      <Diagram source={source} title={title} picks={picks} />
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
        <MarkBadge kind="covered" /> covered · <MarkBadge kind="partly" /> partly ·{" "}
        <MarkBadge kind="uncovered" /> not covered · plain unknown ·{" "}
        {map.transitions === undefined || map.transitions.length === 0 ? null : (
          <>
            <EdgeSwatch kind="covered" /> {perTest ? "taken, badge = tests" : "taken"} ·{" "}
            <EdgeSwatch kind="uncovered" /> {perTest ? "no test takes it" : "not run"} ·{" "}
          </>
        )}
        {coverage === null ? (
          "no test run yet"
        ) : (
          <span>
            from tests at <code className="font-mono">{coverage.tip.slice(0, 7)}</code>
            {stale ? "; files changed since read unknown" : ""}
          </span>
        )}
      </p>
      <NotDriven
        sequences={sequences}
        shown={shown}
        pinned={pinned}
        onHover={setHovered}
        onPin={setPinned}
        commit={from}
      />
      <table className="mt-3 w-full border-collapse text-sm">
        <caption className="sr-only">States and moves of {title}</caption>
        <thead className="text-left text-muted-foreground text-xs">
          <tr>
            <th className="py-1 pr-3 font-medium">State or move</th>
            <th className="hidden py-1 pr-3 font-medium xl:table-cell">Code</th>
            <th className="py-1 pr-3 font-medium">Coverage</th>
            <th className="py-1 font-medium">Tests</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mark = marks.get(row.key) ?? markOfPlaces(null, []);
            const edge = edgeOf(row);
            const kind: StateMarkKind = edge?.kind ?? mark.kind;
            const tests = edge?.tests ?? mark.tests;
            return (
              <tr key={row.key} className="border-t align-top" data-row-mark={kind}>
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
                      onClick={(event) =>
                        go(row.name, row.at, event.currentTarget, edge === null ? STATE : MOVE)
                      }
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
                <td className="whitespace-nowrap py-1.5 pr-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <MarkBadge kind={kind} />
                    {MARK_WORDS[kind]}
                    {kind === "unknown" ? null : (
                      <span className="text-muted-foreground tabular-nums">
                        {(edge ?? mark).run}/{(edge ?? mark).total}
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1.5 text-xs">
                  {edge?.kind === "uncovered" && perTest ? (
                    <span className="text-muted-foreground">no test</span>
                  ) : (
                    <TestChips tests={tests} />
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
