/**
 * How a plan follows its branch when the tip moves. A unit id hashes its path and hunk body, so
 * an id that survives names the same change and keeps its place in the plan; everything else is
 * either gone or new, and the agent decides where the new units go.
 */
import type { Diff, PlanFile, PlannedCommit, Unit, UnitId } from "./types.ts";

/** A unit of the old plan whose hunk no longer exists, with the commits that took it. */
export type VanishedUnit = {
  readonly unit: Unit;
  /** 0-based index into the old plan's commits, and that commit's message. */
  readonly commits: readonly { readonly index: number; readonly message: string }[];
};

export type Evolution = {
  /** The old plan on the new tip: surviving refs in place, emptied commits dropped. */
  readonly draft: PlanFile;
  readonly vanished: readonly VanishedUnit[];
  /** Units of the new diff no old commit took, in diff order. */
  readonly added: readonly Unit[];
};

/** Pure. Responses start empty: they answer the review of the old version, not this one. */
export function evolvePlan(oldPlan: PlanFile, oldDiff: Diff, newDiff: Diff): Evolution {
  const gone = new Map<UnitId, VanishedUnit>();
  const commits: PlannedCommit[] = [];
  oldPlan.commits.forEach((commit, index) => {
    const units = commit.units.filter((ref) => newDiff.units.has(ref.unit));
    for (const ref of commit.units) {
      const unit = oldDiff.units.get(ref.unit);
      if (newDiff.units.has(ref.unit) || unit === undefined) continue;
      const seen = gone.get(ref.unit)?.commits ?? [];
      gone.set(ref.unit, { unit, commits: [...seen, { index, message: commit.message }] });
    }
    if (units.length > 0) commits.push({ ...commit, units });
  });
  const taken = new Set(oldPlan.commits.flatMap((c) => c.units.map((ref) => ref.unit)));
  return {
    draft: {
      schema: oldPlan.schema,
      base: newDiff.base,
      tip: newDiff.tip,
      commits,
      responses: [],
    },
    vanished: [...gone.values()],
    added: [...newDiff.units.values()].filter((unit) => !taken.has(unit.id)),
  };
}
