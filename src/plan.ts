import { createHash } from "node:crypto";
import { formatUnitRef, isSha, parseUnitRef, projectFile } from "./diff.ts";
import type {
  CommentId,
  CommentResponse,
  Diff,
  Entry,
  FileUnit,
  ModeUnit,
  PlanFile,
  PlanIssue,
  PlannedCommit,
  PlanVersion,
  PlanWarning,
  ProjectedCommit,
  RepoPath,
  ResponseStatus,
  Review,
  Sha,
  TextFile,
  TreeChange,
  UnitId,
  UnitRef,
} from "./types.ts";

export const PLAN_SCHEMA = "follow-me/plan@1";

const validated: unique symbol = Symbol("follow-me/validated");

/** A plan that passed every check and whose last commit reproduces the tip. Only plan.ts mints it. */
export type ValidPlan = {
  readonly [validated]: true;
  readonly file: PlanFile;
  /** sha256 of the canonical plan JSON. */
  readonly hash: string;
  readonly commits: readonly ProjectedCommit[];
};

export type Verdict =
  | { readonly ok: true; readonly plan: ValidPlan; readonly warnings: readonly PlanWarning[] }
  | { readonly ok: false; readonly issues: readonly PlanIssue[] };

export function isCommentId(s: string): s is CommentId {
  return s.length > 0;
}

export function isPlanVersion(n: unknown): n is PlanVersion {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

const STATUSES: readonly ResponseStatus[] = ["addressed", "declined", "deferred"];
function isResponseStatus(s: unknown): s is ResponseStatus {
  return STATUSES.some((x) => x === s);
}

/** Narrows to an object whose named fields are still unknown, which holds for any object. */
export function isFields<K extends string>(v: unknown): v is { readonly [P in K]?: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

const INVALID: unique symbol = Symbol("invalid narration");

/** Absent, null and blank all mean no narration, so a planner may always write the field. */
function parseNarration(v: unknown): string | null | typeof INVALID {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return INVALID;
  return v.trim() === "" ? null : v;
}

function withNarration(narration: string | null): { readonly narration?: string } {
  return narration === null ? {} : { narration };
}

/** A unit entry is "h_x:0-3" or { "unit": "h_x:0-3", "narration": "..." }. */
function parseUnitEntry(u: unknown): UnitRef | { readonly error: string } {
  if (typeof u === "string") return parseUnitRef(u);
  if (!isFields<"unit" | "narration">(u) || typeof u.unit !== "string") {
    return { error: 'expected a unit ref string or { "unit", "narration" }' };
  }
  const ref = parseUnitRef(u.unit);
  if ("error" in ref) return ref;
  const narration = parseNarration(u.narration);
  if (narration === INVALID) return { error: "narration must be a string" };
  return { ...ref, ...withNarration(narration) };
}

/** Boundary parse of draft.json or plans/vN.json. Reports every malformed field. */
export function parsePlanFile(draft: unknown): PlanFile | PlanIssue[] {
  const issues: PlanIssue[] = [];
  const bad = (at: string, reason: string): void => {
    issues.push({ kind: "malformed", at, reason });
  };
  if (!isFields<"schema" | "base" | "tip" | "commits" | "responses">(draft)) {
    return [{ kind: "malformed", at: "$", reason: "expected an object" }];
  }
  if (draft.schema !== PLAN_SCHEMA) bad("$.schema", `expected "${PLAN_SCHEMA}"`);
  const sha = (key: "base" | "tip"): Sha | null => {
    const v = draft[key];
    if (typeof v === "string" && isSha(v)) return v;
    bad(`$.${key}`, "expected a full commit sha");
    return null;
  };
  const base = sha("base");
  const tip = sha("tip");

  const commits: PlannedCommit[] = [];
  if (!isArray(draft.commits)) bad("$.commits", "expected an array");
  else {
    for (const [i, c] of draft.commits.entries()) {
      const at = `$.commits[${i}]`;
      if (!isFields<"message" | "narration" | "units">(c)) {
        bad(at, "expected an object");
        continue;
      }
      if (typeof c.message !== "string") bad(`${at}.message`, "expected a string");
      const narration = parseNarration(c.narration);
      if (narration === INVALID) bad(`${at}.narration`, "expected a string");
      const units: UnitRef[] = [];
      if (!isArray(c.units)) bad(`${at}.units`, "expected an array of unit refs");
      else {
        for (const [j, u] of c.units.entries()) {
          const ref = parseUnitEntry(u);
          if ("error" in ref) bad(`${at}.units[${j}]`, ref.error);
          else units.push(ref);
        }
      }
      if (typeof c.message === "string" && narration !== INVALID) {
        commits.push({ message: c.message, ...withNarration(narration), units });
      }
    }
  }

  const responses: CommentResponse[] = [];
  const rawResponses = draft.responses ?? [];
  if (!isArray(rawResponses)) bad("$.responses", "expected an array");
  else {
    for (const [i, r] of rawResponses.entries()) {
      const at = `$.responses[${i}]`;
      if (!isFields<"comment" | "status" | "note">(r)) bad(at, "expected an object");
      else if (typeof r.comment !== "string" || !isCommentId(r.comment)) {
        bad(`${at}.comment`, "expected a comment id");
      } else if (!isResponseStatus(r.status)) {
        bad(`${at}.status`, `expected one of ${STATUSES.join(", ")}`);
      } else if (typeof r.note !== "string") bad(`${at}.note`, "expected a string");
      else responses.push({ comment: r.comment, status: r.status, note: r.note });
    }
  }

  if (issues.length > 0 || base === null || tip === null) return issues;
  return { schema: PLAN_SCHEMA, base, tip, commits, responses };
}

/** The wire object with a fixed key order, so its JSON is canonical. */
export function serializePlanFile(file: PlanFile): unknown {
  return {
    schema: file.schema,
    base: file.base,
    tip: file.tip,
    commits: file.commits.map((c) => ({
      message: c.message,
      ...withNarration(c.narration ?? null),
      units: c.units.map((ref) =>
        ref.narration === undefined
          ? formatUnitRef(ref)
          : { unit: formatUnitRef(ref), narration: ref.narration },
      ),
    })),
    responses: file.responses.map((r) => ({ comment: r.comment, status: r.status, note: r.note })),
  };
}

export function planHash(file: PlanFile): string {
  return createHash("sha256")
    .update(JSON.stringify(serializePlanFile(file)))
    .digest("hex");
}

const UNOWNED = -1;

type Claims = {
  /** Owning commit per change line; whole-file and mode units have a single slot. */
  readonly owners: Map<UnitId, number[]>;
  /** Selections per commit in plan order, "rest" resolved to explicit lines for hunks. */
  readonly resolved: UnitRef[][];
};

function claim(diff: Diff, file: PlanFile, issues: PlanIssue[]): Claims {
  const owners = new Map<UnitId, number[]>();
  for (const [id, unit] of diff.units) {
    owners.set(id, new Array<number>(unit.kind === "hunk" ? unit.changeCount : 1).fill(UNOWNED));
  }
  const slotsOf = file.commits.map((c) => new Array<UnitRef | null>(c.units.length).fill(null));

  file.commits.forEach((commit, k) => {
    for (const [j, ref] of commit.units.entries()) {
      const unit = diff.units.get(ref.unit);
      const slots = owners.get(ref.unit);
      if (unit === undefined || slots === undefined) {
        issues.push({ kind: "unknown-unit", commit: k, ref: formatUnitRef(ref) });
        continue;
      }
      if (ref.select.kind === "rest") continue;
      const bad = (reason: string) =>
        issues.push({ kind: "bad-selection", commit: k, unit: ref.unit, reason });
      if (unit.kind !== "hunk") {
        bad("whole-file and mode units are taken whole");
        continue;
      }
      const changes = ref.select.changes;
      const outside = changes.filter((c) => c >= unit.changeCount);
      if (outside.length > 0) {
        bad(`changes ${outside.join(", ")} are outside [0, ${unit.changeCount})`);
        continue;
      }
      const repeated = changes.filter((c, i) => changes.indexOf(c) !== i);
      if (repeated.length > 0) {
        bad(`changes ${repeated.join(", ")} are listed twice`);
        continue;
      }
      const taken = new Map<number, number[]>();
      for (const c of changes) {
        const owner = slots[c] ?? UNOWNED;
        if (owner === UNOWNED) slots[c] = k;
        else taken.set(owner, [...(taken.get(owner) ?? []), c]);
      }
      for (const [owner, lines] of taken) {
        issues.push({ kind: "duplicate", unit: ref.unit, changes: lines, commits: [owner, k] });
      }
      const sorted = [...changes].sort((a, b) => a - b);
      slotsOf[k]?.splice(j, 1, { ...ref, select: { kind: "lines", changes: sorted } });
    }
  });

  const restOwner = new Map<UnitId, number>();
  file.commits.forEach((commit, k) => {
    for (const [j, ref] of commit.units.entries()) {
      const slots = owners.get(ref.unit);
      const unit = diff.units.get(ref.unit);
      if (ref.select.kind !== "rest" || slots === undefined || unit === undefined) continue;
      const free = slots.flatMap((owner, c) => (owner === UNOWNED ? [c] : []));
      const previous = restOwner.get(ref.unit);
      if (free.length === 0) {
        if (previous === undefined) {
          issues.push({
            kind: "bad-selection",
            commit: k,
            unit: ref.unit,
            reason: "every change line is already claimed by explicit selections",
          });
        } else {
          const theirs =
            unit.kind === "hunk" ? slots.flatMap((o, c) => (o === previous ? [c] : [])) : [];
          issues.push({
            kind: "duplicate",
            unit: ref.unit,
            changes: theirs,
            commits: [previous, k],
          });
        }
        continue;
      }
      for (const c of free) slots[c] = k;
      restOwner.set(ref.unit, k);
      slotsOf[k]?.splice(
        j,
        1,
        unit.kind === "hunk" ? { ...ref, select: { kind: "lines", changes: free } } : ref,
      );
    }
  });

  for (const [id, unit] of diff.units) {
    const slots = owners.get(id) ?? [];
    const free = slots.flatMap((owner, c) => (owner === UNOWNED ? [c] : []));
    if (free.length === 0) continue;
    issues.push({
      kind: "unassigned",
      unit: id,
      path: unit.path,
      changes: unit.kind === "hunk" ? free : [],
    });
  }
  const resolved = slotsOf.map((refs) => refs.flatMap((r) => (r === null ? [] : [r])));
  return { owners, resolved };
}

type PathState = { readonly change: TreeChange; readonly present: boolean };

function projector(diff: Diff, owners: ReadonlyMap<UnitId, readonly number[]>) {
  const modeUnits = new Map<RepoPath, ModeUnit>();
  const fileUnits = new Map<RepoPath, FileUnit>();
  for (const unit of diff.units.values()) {
    if (unit.kind === "mode") modeUnits.set(unit.path, unit);
    if (unit.kind === "file") fileUnits.set(unit.path, unit);
  }
  const appliedBy = (id: UnitId, change: number, k: number): boolean => {
    const owner = owners.get(id)?.[change] ?? UNOWNED;
    return owner !== UNOWNED && owner <= k;
  };
  const textState = (file: TextFile, k: number): PathState => {
    const bytes = projectFile(file, (h, c) => appliedBy(h.id, c, k));
    if (bytes === null) return { change: { path: file.path, op: "delete" }, present: false };
    const entry = file.base?.entry ?? file.tip?.entry;
    if (entry === undefined) throw new Error(`${file.path} has neither side`);
    const flip = modeUnits.get(file.path);
    const mode = flip !== undefined && appliedBy(flip.id, 0, k) ? flip.to : entry.mode;
    return { change: { path: file.path, op: "write", mode, bytes }, present: true };
  };
  const wholeState = (unit: FileUnit, k: number): PathState => {
    const entry = appliedBy(unit.id, 0, k) ? unit.after : unit.before;
    return entry === null
      ? { change: { path: unit.path, op: "delete" }, present: false }
      : { change: { path: unit.path, op: "link", entry }, present: true };
  };
  const stateAt = (path: RepoPath, k: number): PathState => {
    const text = diff.textFiles.get(path);
    if (text !== undefined) return textState(text, k);
    const whole = fileUnits.get(path);
    if (whole !== undefined) return wholeState(whole, k);
    throw new Error(`no unit touches ${path}`);
  };
  const tipOf = (path: RepoPath): Tip | null => {
    const text = diff.textFiles.get(path);
    if (text !== undefined) return text.tip;
    const after = fileUnits.get(path)?.after ?? null;
    return after && { entry: after, bytes: null };
  };
  return { stateAt, tipOf };
}

/** bytes is null for whole-file units, which compare by blob. */
type Tip = { readonly entry: Entry; readonly bytes: string | null };

function describe(change: TreeChange): string {
  if (change.op === "delete") return "absent";
  if (change.op === "link") return `${change.entry.mode} ${change.entry.blob}`;
  return `${change.mode} with ${change.bytes.length} bytes`;
}

function matchesTip(change: TreeChange, tip: Tip | null): boolean {
  if (tip === null) return change.op === "delete";
  if (change.op === "write") return change.mode === tip.entry.mode && change.bytes === tip.bytes;
  if (change.op === "link") {
    return change.entry.mode === tip.entry.mode && change.entry.blob === tip.entry.blob;
  }
  return false;
}

function project(
  diff: Diff,
  file: PlanFile,
  claims: Claims,
  issues: PlanIssue[],
): ProjectedCommit[] {
  const { stateAt, tipOf } = projector(diff, claims.owners);
  const present = new Map<RepoPath, boolean>();
  for (const f of diff.textFiles.values()) present.set(f.path, f.base !== null);
  for (const u of diff.units.values()) {
    if (u.kind === "file") present.set(u.path, u.before !== null);
  }

  const commits = file.commits.map((commit, k): ProjectedCommit => {
    const refs = claims.resolved[k] ?? [];
    const touched = [...new Set(refs.flatMap((r) => diff.units.get(r.unit)?.path ?? []))].sort();
    const changes = touched.map((path) => {
      const state = stateAt(path, k);
      present.set(path, state.present);
      return state.change;
    });
    const seen = new Set<string>();
    const conflict = (fileAt: RepoPath, under: RepoPath) => {
      if (seen.has(`${fileAt}\0${under}`)) return;
      seen.add(`${fileAt}\0${under}`);
      issues.push({ kind: "path-conflict", commit: k, file: fileAt, under });
    };
    for (const path of touched) {
      if (!present.get(path)) continue;
      for (const [other, here] of present) {
        if (!here || other === path) continue;
        if (path.startsWith(`${other}/`)) conflict(other, path);
        if (other.startsWith(`${path}/`)) conflict(path, other);
      }
    }
    return {
      index: k,
      message: commit.message,
      ...withNarration(commit.narration ?? null),
      refs,
      changes,
    };
  });

  const last = file.commits.length - 1;
  for (const path of present.keys()) {
    const got = stateAt(path, last).change;
    const tip = tipOf(path);
    if (!matchesTip(got, tip)) {
      issues.push({
        kind: "final-mismatch",
        path,
        expected: tip?.entry ?? null,
        got: describe(got),
      });
    }
  }
  return commits;
}

/**
 * Parses and checks a draft against the diff: every change line used exactly once, every
 * commit's tree valid, and the last commit equal to the tip. Collects all issues at once.
 */
export function validatePlan(
  diff: Diff,
  draft: unknown,
  opts: { readonly lastReview?: Review | null } = {},
): Verdict {
  const parsed = parsePlanFile(draft);
  if (Array.isArray(parsed)) return { ok: false, issues: parsed };
  const file = parsed;
  const issues: PlanIssue[] = [];

  if (file.tip !== diff.tip)
    issues.push({ kind: "stale", planTip: file.tip, sessionTip: diff.tip });
  if (file.base !== diff.base) {
    issues.push({
      kind: "malformed",
      at: "$.base",
      reason: `expected the merge-base ${diff.base}`,
    });
  }
  file.commits.forEach((c, k) => {
    if (c.message.trim() === "") issues.push({ kind: "empty-message", commit: k });
    if (c.units.length === 0) issues.push({ kind: "empty-commit", commit: k });
  });

  const assignment: PlanIssue[] = [];
  const claims = claim(diff, file, assignment);
  issues.push(...assignment);
  // Tree checks on an incomplete assignment would only repeat the assignment issues.
  const commits = assignment.length === 0 ? project(diff, file, claims, issues) : [];

  const review = opts.lastReview ?? null;
  const commentIds = new Set(review?.comments.map((c) => c.id));
  const answered = new Set(file.responses.map((r) => r.comment));
  for (const r of file.responses) {
    if (!commentIds.has(r.comment)) issues.push({ kind: "unknown-response", comment: r.comment });
  }
  const warnings: PlanWarning[] =
    review === null
      ? []
      : review.comments
          .filter((c) => !answered.has(c.id))
          .map((c) => ({ kind: "unanswered", comment: c.id, review: review.planVersion }));

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { [validated]: true, file, hash: planHash(file), commits },
    warnings,
  };
}
