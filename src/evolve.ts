/**
 * How a plan follows its branch when the tip moves. A unit id hashes its path and hunk body, so
 * an id that survives names the same change and keeps its place in the plan; everything else is
 * either gone or new, and the agent decides where the new units go.
 */
import { tipStartOf } from "./diff.ts";
import type {
  Anchor,
  CarriedComment,
  CarriedConcern,
  Comment,
  ConcernDecision,
  ConcernId,
  Diff,
  PlacedConcern,
  Placement,
  PlanFile,
  PlannedCommit,
  PlanVersion,
  SessionComment,
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

/** The body row whose tip line is `line`; a kept row before a removal at the same line. */
function rowAt(hunk: TextHunk, units: Units, line: number | null): number {
  if (line === null) return 0;
  const lines = tipLines(hunk, units);
  const row = hunk.body.findIndex((r, i) => r.op !== "-" && lines[i] === line);
  return row === -1 ? 0 : row;
}

/** What a placement needs from the thing placed: whether it names no line, and its first row. */
type Pinned = { readonly whole: boolean; readonly row: (hunk: TextHunk) => number };

function pinnedComment(comment: Comment): Pinned {
  const { anchor } = comment;
  // A comment on a whole hunk has no line; inventing one moves its card off the hunk's end.
  const whole = anchor.kind === "hunk" && anchor.changes === null && anchor.offsets === undefined;
  return { whole, row: (hunk) => firstRow(comment, hunk) };
}

function pinnedConcern(concern: PlacedConcern): Pinned {
  const { lines } = concern;
  if (lines === undefined) return { whole: true, row: () => 0 };
  return {
    whole: false,
    row: (hunk) => {
      const row = hunk.body.findIndex((r) => r.op !== " " && lines.includes(r.change));
      return row === -1 ? 0 : row;
    },
  };
}

/** Where a comment points on the version it was made on. */
function placedOwn(comment: Comment): Placement {
  const { anchor } = comment;
  return {
    unit: anchor.kind === "hunk" ? anchor.unit : null,
    offsets: anchor.kind === "hunk" ? (anchor.offsets ?? null) : null,
    changed: false,
    path: comment.context.path,
    newLine: null,
  };
}

/**
 * Pure. Moves a placement on the old diff to the new one: a unit the new diff still has keeps its
 * place, else the hunk of the same path nearest its old tip line takes it, marked changed. A
 * placement on no unit stays as it is.
 */
function move(at: Placement, pinned: Pinned, oldUnits: Units, newUnits: Units): Placement {
  if (at.unit === null) return at;
  const kept = newUnits.get(at.unit);
  const old = oldUnits.get(at.unit);
  if (kept !== undefined) {
    let newLine: number | null = null;
    if (kept.kind === "hunk" && !pinned.whole) {
      if (!at.changed) newLine = tipLines(kept, newUnits)[pinned.row(kept)] ?? null;
      else if (at.newLine !== null && old?.kind === "hunk") {
        newLine = at.newLine - tipStartOf(old, oldUnits) + tipStartOf(kept, newUnits);
      } else newLine = at.newLine;
    }
    return { ...at, path: kept.path, newLine };
  }
  const path = old?.path ?? at.path;
  const onPath = [...newUnits.values()].filter((u) => u.path === path);
  const first = onPath[0];
  const moved = { offsets: null, changed: true, path };
  if (first === undefined) return { ...moved, unit: null, newLine: null };
  const hunks = onPath.filter((u) => u.kind === "hunk");
  if (old?.kind !== "hunk" || hunks.length === 0)
    return { ...moved, unit: first.id, newLine: null };
  const row = at.changed ? rowAt(old, oldUnits, at.newLine) : pinned.row(old);
  const oldLine = tipLines(old, oldUnits)[row] ?? tipStartOf(old, oldUnits);
  const nearest = hunks.reduce((a, b) =>
    distance(b, newUnits, oldLine) < distance(a, newUnits, oldLine) ? b : a,
  );
  return {
    ...moved,
    unit: nearest.id,
    newLine: pinned.whole ? null : landing(nearest, newUnits, oldLine, old.body[row]?.text),
  };
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
  return comments.map((comment) => ({
    comment,
    ...move(placedOwn(comment), pinnedComment(comment), oldUnits, newUnits),
  }));
}

/** since stays once set; a first change records the version the code still matched. */
function sinceOf(before: Placement, after: Placement, since: PlanVersion | null, at: PlanVersion) {
  return since ?? (after.changed && !before.changed ? at : null);
}

/**
 * Pure. What an open review carries from version `at` into the next: what it carried already,
 * moved again, then the comments said on `at`. Nothing is dropped, so a comment of v1 is still
 * there after the second swap.
 */
export function carrySession(
  carried: readonly SessionComment[],
  said: readonly Comment[],
  at: PlanVersion,
  oldUnits: Units,
  newUnits: Units,
): SessionComment[] {
  const again = carried.map((c) => {
    const moved = move(c, pinnedComment(c.comment), oldUnits, newUnits);
    return { ...c, ...moved, since: sinceOf(c, moved, c.since, at) };
  });
  const fresh = said.map((comment) => {
    const own = placedOwn(comment);
    const moved = move(own, pinnedComment(comment), oldUnits, newUnits);
    return { comment, version: at, ...moved, since: sinceOf(own, moved, null, at) };
  });
  return [...again, ...fresh];
}

/**
 * Pure. Kept concerns of version `at` that the next plan no longer has, plus those carried before,
 * placed on the new diff. A concern the next plan has again keeps its decision there instead, so
 * it is left out here.
 */
export function carryConcerns(
  carried: readonly CarriedConcern[],
  kept: readonly {
    readonly concern: PlacedConcern;
    readonly commit: number;
    readonly decision: ConcernDecision;
  }[],
  inNext: ReadonlySet<ConcernId>,
  at: PlanVersion,
  oldUnits: Units,
  newUnits: Units,
): CarriedConcern[] {
  const fresh = kept.map((k): CarriedConcern => {
    const unit = k.concern.unit ?? null;
    const path = unit === null ? null : (oldUnits.get(unit)?.path ?? null);
    return { ...k, unit, offsets: null, changed: false, path, newLine: null, since: null };
  });
  return [...carried, ...fresh]
    .filter((c) => !inNext.has(c.concern.id))
    .map((c) => {
      const moved = move(c, pinnedConcern(c.concern), oldUnits, newUnits);
      return { ...c, ...moved, since: sinceOf(c, moved, c.since, at) };
    });
}

/**
 * Pure. Where a carried hunk comment points on the diff it was carried to, as an anchor of that
 * diff: its own rows when the hunk is unchanged, the row at its new line when it changed, the
 * whole hunk when it has no line. Null when the code is gone or the comment is not on a hunk.
 */
export function anchorOn(carried: CarriedComment, units: Units, commit: number): Anchor | null {
  const { anchor } = carried.comment;
  if (anchor.kind !== "hunk" || carried.unit === null) return null;
  if (!carried.changed) return { ...anchor, commit };
  const hunk = units.get(carried.unit);
  if (hunk?.kind !== "hunk" || carried.newLine === null) {
    return { kind: "hunk", unit: carried.unit, commit, changes: null };
  }
  const row = rowAt(hunk, units, carried.newLine);
  const at = hunk.body[row];
  const changes = at === undefined || at.op === " " ? [] : [at.change];
  return { kind: "hunk", unit: carried.unit, commit, changes, offsets: [row] };
}

/** Pure. A carried concern as a concern of the diff it was carried to; see anchorOn. */
export function concernOn(carried: CarriedConcern, units: Units): PlacedConcern {
  const { concern } = carried;
  if (carried.unit === null) return concern;
  if (!carried.changed) return { ...concern, unit: carried.unit };
  const { lines: _old, ...rest } = concern;
  const hunk = units.get(carried.unit);
  if (hunk?.kind !== "hunk" || carried.newLine === null) return { ...rest, unit: carried.unit };
  const at = hunk.body[rowAt(hunk, units, carried.newLine)];
  return at === undefined || at.op === " "
    ? { ...rest, unit: carried.unit }
    : { ...rest, unit: carried.unit, lines: [at.change] };
}
