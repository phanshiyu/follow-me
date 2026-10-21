import { PLAN_SCHEMA } from "./plan.ts";
import type { Diff, RepoPath, Unit, UnitId } from "./types.ts";

/**
 * The plan that needs no planner: one commit per touched file in diff order, holding every unit
 * of that file. It tells no story, but it runs the whole pipeline on a real branch. Returns the
 * draft as the wire format, for validatePlan to judge like any other draft.
 */
export function naiveDraft(diff: Diff): unknown {
  const byPath = new Map<RepoPath, Unit[]>();
  for (const unit of diff.units.values()) {
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit]);
  }
  const commits = [...byPath].map(([path, units]) => ({
    message: `wip: ${path}${suffix(units)}`,
    units: units.map((u): UnitId => u.id),
  }));
  return { schema: PLAN_SCHEMA, base: diff.base, tip: diff.tip, commits, responses: [] };
}

/** Names what a file with no text hunk is, so `wip: logo.bin (binary)` says why it has no lines. */
function suffix(units: readonly Unit[]): string {
  if (units.some((u) => u.kind === "hunk")) return "";
  const first = units[0];
  if (first === undefined) return "";
  return first.kind === "mode" ? " (mode)" : first.kind === "file" ? ` (${first.reason})` : "";
}
