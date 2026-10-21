/**
 * How a plan follows its branch when the tip moves. A unit id hashes its path and hunk body, so
 * an id that survives names the same change and keeps its place in the plan; everything else is
 * either gone or new, and the agent decides where the new units go.
 */
import { tipStartOf } from "./diff.ts";
import type {
  CarriedComment,
  Comment,
  Diff,
  PlanFile,
  PlannedCommit,
  TextHunk,
  Unit,
  UnitId,
} from "./types.ts";

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

type Units = ReadonlyMap<UnitId, Unit>;

/** The tip line of each body row; a removed row gets the line that follows it. */
function tipLines(hunk: TextHunk, units: Units): number[] {
  let line = tipStartOf(hunk, units);
  return hunk.body.map((row) => {
    const at = line;
    if (row.op !== "-") line += 1;
    return at;
  });
}

/** The body row a hunk comment points at first: its first picked row, else its first change. */
function firstRow(comment: Comment, hunk: TextHunk): number {
  const { anchor } = comment;
  if (anchor.kind !== "hunk") return 0;
  const picked = anchor.offsets?.[0];
  if (picked !== undefined) return picked;
  const change = anchor.changes?.[0];
  const row = hunk.body.findIndex((r) => r.op !== " " && r.change === change);
  return change === undefined || row === -1 ? 0 : row;
}

/**
 * Where an old line lands in a replacement hunk: the nearest row with the same text the tip
 * keeps, else the old line clamped into the hunk's tip lines.
 */
function landing(hunk: TextHunk, units: Units, oldLine: number, text: string | undefined): number {
  const lines = tipLines(hunk, units);
  const same = hunk.body.flatMap((row, i) =>
    row.op !== "-" && row.text === text ? [lines[i] ?? oldLine] : [],
  );
  if (same.length > 0) {
    return same.reduce((a, b) => (Math.abs(b - oldLine) < Math.abs(a - oldLine) ? b : a));
  }
  const [from, to] = span(hunk, units);
  return Math.min(Math.max(oldLine, from), to);
}

/** First and last tip line of a hunk; a pure removal spans the one line after it. */
function span(hunk: TextHunk, units: Units): readonly [number, number] {
  const from = tipStartOf(hunk, units);
  const kept = hunk.body.filter((row) => row.op !== "-").length;
  return [from, from + Math.max(kept, 1) - 1];
}

function distance(hunk: TextHunk, units: Units, line: number): number {
  const [from, to] = span(hunk, units);
  return line < from ? from - line : line > to ? line - to : 0;
}

/**
 * Pure. Places each comment of the previous version on the new diff: on its own unit when that
 * hunk is unchanged, else on the hunk of the same path nearest its old tip line.
 */
export function carryComments(
  comments: readonly Comment[],
  oldUnits: Units,
  newUnits: Units,
): CarriedComment[] {
  return comments.map((comment) => carry(comment, oldUnits, newUnits));
}

function carry(comment: Comment, oldUnits: Units, newUnits: Units): CarriedComment {
  const { anchor } = comment;
  const nowhere = { comment, unit: null, offsets: null, newLine: null };
  if (anchor.kind !== "hunk") return { ...nowhere, changed: false, path: comment.context.path };
  // A comment on a whole hunk has no line; inventing one moves its card off the hunk's end.
  const whole = anchor.changes === null && anchor.offsets === undefined;
  const kept = newUnits.get(anchor.unit);
  if (kept !== undefined) {
    const newLine =
      kept.kind === "hunk" && !whole
        ? (tipLines(kept, newUnits)[firstRow(comment, kept)] ?? null)
        : null;
    return {
      comment,
      unit: kept.id,
      offsets: anchor.offsets ?? null,
      changed: false,
      path: kept.path,
      newLine,
    };
  }
  const old = oldUnits.get(anchor.unit);
  const path = old?.path ?? comment.context.path;
  const onPath = [...newUnits.values()].filter((u) => u.path === path);
  const first = onPath[0];
  if (first === undefined) return { ...nowhere, changed: true, path };
  const moved = { comment, offsets: null, changed: true, path };
  const hunks = onPath.filter((u) => u.kind === "hunk");
  if (old?.kind !== "hunk" || hunks.length === 0)
    return { ...moved, unit: first.id, newLine: null };
  const row = firstRow(comment, old);
  const oldLine = tipLines(old, oldUnits)[row] ?? tipStartOf(old, oldUnits);
  const nearest = hunks.reduce((a, b) =>
    distance(b, newUnits, oldLine) < distance(a, newUnits, oldLine) ? b : a,
  );
  return {
    ...moved,
    unit: nearest.id,
    newLine: whole ? null : landing(nearest, newUnits, oldLine, old.body[row]?.text),
  };
}
