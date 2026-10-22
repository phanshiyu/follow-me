import { createHash } from "node:crypto";
import { formatUnitRef, isSha, isUnitId, parseUnitRef, projectFile } from "./diff.ts";
import type {
  CommentId,
  CommentResponse,
  CommitSection,
  Concern,
  ConcernId,
  ConcernKind,
  Diff,
  Entry,
  FileUnit,
  ModeUnit,
  Offer,
  OfferId,
  OfferKind,
  PlacedConcern,
  PlacedOffer,
  PlanFile,
  PlanIssue,
  PlannedCommit,
  PlanVersion,
  PlanWarning,
  ProjectedCommit,
  RepoPath,
  ResponseStatus,
  Review,
  Severity,
  Sha,
  TextFile,
  TreeChange,
  UnitId,
  UnitRef,
} from "./types.ts";

export const PLAN_SCHEMA = "follow-me/plan@1";

/** Titles past this many characters draw a warning; the prompt asks for 50 or fewer. */
export const LONG_TITLE = 72;

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

export function isConcernId(s: unknown): s is ConcernId {
  return typeof s === "string" && /^k_[0-9a-f]{8}$/.test(s);
}

export function isOfferId(s: unknown): s is OfferId {
  return typeof s === "string" && /^o_[0-9a-f]{8}$/.test(s);
}

/** At most this many offers in one commit and in the whole plan; most plans need none. */
export const OFFERS_PER_COMMIT = 1;
export const OFFERS_PER_PLAN = 3;

export function isPlanVersion(n: unknown): n is PlanVersion {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

const STATUSES: readonly ResponseStatus[] = ["addressed", "declined", "deferred", "answered"];
function isResponseStatus(s: unknown): s is ResponseStatus {
  return STATUSES.some((x) => x === s);
}

const SECTIONS: readonly CommitSection[] = ["story", "steps", "details", "wiring"];
function isCommitSection(s: unknown): s is CommitSection {
  return SECTIONS.some((x) => x === s);
}

const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];
const CONCERN_KINDS: readonly ConcernKind[] = ["bug", "missing-test", "naming", "risk"];

export function isSeverity(s: unknown): s is Severity {
  return SEVERITIES.some((x) => x === s);
}

function isConcernKind(s: unknown): s is ConcernKind {
  return CONCERN_KINDS.some((x) => x === s);
}

const OFFER_KINDS: readonly OfferKind[] = ["state-machine", "sequence", "diagram"];
function isOfferKind(s: unknown): s is OfferKind {
  return OFFER_KINDS.some((x) => x === s);
}

/** Narrows to an object whose named fields are still unknown, which holds for any object. */
export function isFields<K extends string>(v: unknown): v is { readonly [P in K]?: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

const INVALID: unique symbol = Symbol("invalid text");

/** Absent, null and blank all mean none, so a planner may always write the field. */
function parseText(v: unknown): string | null | typeof INVALID {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return INVALID;
  return v.trim() === "" ? null : v;
}

const MERMAID_KEYWORDS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "block-beta",
  "%%{init",
];

/** A diagram is Mermaid source, so its first line must name a diagram type. Else the reason. */
export function diagramProblem(diagram: string): string | null {
  const first = (diagram.split("\n").find((line) => line.trim() !== "") ?? "").trim();
  const named = MERMAID_KEYWORDS.some(
    (k) => first.startsWith(k) && !/[\w-]/.test(first.charAt(k.length)),
  );
  if (named) return null;
  return `expected Mermaid source whose first line starts with a diagram type such as flowchart, sequenceDiagram or stateDiagram-v2, got "${first.slice(0, 40)}"`;
}

type Extras = {
  readonly narration?: string;
  readonly diagram?: string;
  readonly concerns?: readonly Concern[];
  readonly offers?: readonly Offer[];
};

type ExtrasError = {
  readonly field: "narration" | "diagram" | "concerns" | "offers";
  readonly error: string;
};

/** A concern is { severity, kind, text, lines? }; lines are change indices, on a unit ref only. */
function parseConcern(v: unknown, onUnit: boolean): Concern | string {
  if (!isFields<"severity" | "kind" | "text" | "lines">(v)) return "expected an object";
  if (!isSeverity(v.severity)) return `severity: expected one of ${SEVERITIES.join(", ")}`;
  if (!isConcernKind(v.kind)) return `kind: expected one of ${CONCERN_KINDS.join(", ")}`;
  if (typeof v.text !== "string" || v.text.trim() === "") return "text: expected a sentence";
  const { severity, kind, text } = v;
  if (v.lines === undefined || v.lines === null) return { severity, kind, text };
  if (!onUnit) return "lines: only a concern on a unit ref has lines";
  const lines = v.lines;
  if (!isArray(lines) || lines.length === 0) return "lines: expected a list of change indices";
  const indices = lines.flatMap((n) => (Number.isInteger(n) && Number(n) >= 0 ? [Number(n)] : []));
  if (indices.length !== lines.length) return "lines: expected a list of change indices";
  return { severity, kind, text, lines: [...new Set(indices)].sort((a, b) => a - b) };
}

/** A concern as validation placed it, stored beside a review: with its id and its unit. */
export function parsePlacedConcern(v: unknown): PlacedConcern | string {
  if (!isFields<"id" | "unit">(v)) return "expected an object";
  if (!isConcernId(v.id)) return "id: expected a concern id";
  if (v.unit !== undefined && !(typeof v.unit === "string" && isUnitId(v.unit))) {
    return "unit: expected a unit id";
  }
  const concern = parseConcern(v, v.unit !== undefined);
  if (typeof concern === "string") return concern;
  return { ...concern, id: v.id, ...(v.unit === undefined ? {} : { unit: v.unit }) };
}

/** Absent, null and [] all mean no concerns, so a planner may always write the field. */
function parseConcerns(v: unknown, onUnit: boolean): readonly Concern[] | string {
  if (v === undefined || v === null) return [];
  if (!isArray(v)) return "expected an array";
  const out: Concern[] = [];
  for (const [i, raw] of v.entries()) {
    const concern = parseConcern(raw, onUnit);
    if (typeof concern === "string") return `[${i}]: ${concern}`;
    out.push(concern);
  }
  return out;
}

/** An offer is { kind, label }; the label names the thing to draw. */
function parseOffer(v: unknown): Offer | string {
  if (!isFields<"kind" | "label">(v)) return "expected an object";
  if (!isOfferKind(v.kind)) return `kind: expected one of ${OFFER_KINDS.join(", ")}`;
  if (typeof v.label !== "string" || v.label.trim() === "") {
    return 'label: expected what to draw, like "Draw UploadButton as a state machine"';
  }
  return { kind: v.kind, label: v.label };
}

/** A stored offer as validation placed it: with its id and its unit. */
export function parsePlacedOffer(v: unknown): PlacedOffer | string {
  if (!isFields<"id" | "unit">(v)) return "expected an object";
  if (!isOfferId(v.id)) return "id: expected an offer id";
  if (v.unit !== undefined && !(typeof v.unit === "string" && isUnitId(v.unit))) {
    return "unit: expected a unit id";
  }
  const offer = parseOffer(v);
  if (typeof offer === "string") return offer;
  return { ...offer, id: v.id, ...(v.unit === undefined ? {} : { unit: v.unit }) };
}

/** Absent, null and [] all mean no offers. */
function parseOffers(v: unknown): readonly Offer[] | string {
  if (v === undefined || v === null) return [];
  if (!isArray(v)) return "expected an array";
  const out: Offer[] = [];
  for (const [i, raw] of v.entries()) {
    const offer = parseOffer(raw);
    if (typeof offer === "string") return `[${i}]: ${offer}`;
    out.push(offer);
  }
  return out;
}

/** The optional narration, diagram, concerns and offers of a commit or unit entry, or what is wrong. */
function parseExtras(
  v: {
    readonly narration?: unknown;
    readonly diagram?: unknown;
    readonly concerns?: unknown;
    readonly offers?: unknown;
  },
  onUnit: boolean,
): Extras | ExtrasError {
  const narration = parseText(v.narration);
  if (narration === INVALID) return { field: "narration", error: "expected a string" };
  const diagram = parseText(v.diagram);
  if (diagram === INVALID) return { field: "diagram", error: "expected a string" };
  const problem = diagram === null ? null : diagramProblem(diagram);
  if (problem !== null) return { field: "diagram", error: problem };
  const concerns = parseConcerns(v.concerns, onUnit);
  if (typeof concerns === "string") return { field: "concerns", error: concerns };
  const offers = parseOffers(v.offers);
  if (typeof offers === "string") return { field: "offers", error: offers };
  return {
    ...withExtras(narration, diagram, concerns),
    ...(offers.length === 0 ? {} : { offers }),
  };
}

type Text = Pick<Extras, "narration" | "diagram">;

function withText(narration: string | null, diagram: string | null): Text {
  return {
    ...(narration === null ? {} : { narration }),
    ...(diagram === null ? {} : { diagram }),
  };
}

function withExtras(
  narration: string | null,
  diagram: string | null,
  concerns: readonly Concern[],
): Extras {
  return { ...withText(narration, diagram), ...(concerns.length === 0 ? {} : { concerns }) };
}

function serializeConcern(c: Concern): unknown {
  return {
    severity: c.severity,
    kind: c.kind,
    text: c.text,
    ...(c.lines === undefined ? {} : { lines: c.lines }),
  };
}

function serializeExtras(x: Extras): Record<string, unknown> {
  return {
    ...withText(x.narration ?? null, x.diagram ?? null),
    ...(x.concerns === undefined ? {} : { concerns: x.concerns.map(serializeConcern) }),
    ...(x.offers === undefined
      ? {}
      : { offers: x.offers.map((o) => ({ kind: o.kind, label: o.label })) }),
  };
}

/**
 * A unit entry is "h_x:0-3" or { "unit": "h_x:0-3", "narration", "diagram", "concerns", "offers" }.
 */
function parseUnitEntry(u: unknown): UnitRef | { readonly error: string } {
  if (typeof u === "string") return parseUnitRef(u);
  if (
    !isFields<"unit" | "narration" | "diagram" | "concerns" | "offers">(u) ||
    typeof u.unit !== "string"
  ) {
    return {
      error:
        'expected a unit ref string or { "unit", "narration", "diagram", "concerns", "offers" }',
    };
  }
  const ref = parseUnitRef(u.unit);
  if ("error" in ref) return ref;
  const extras = parseExtras(u, true);
  if ("error" in extras) return { error: `${extras.field}: ${extras.error}` };
  return { ...ref, ...extras };
}

/** { "commit": 3, "unit": "h_x" } with commit 1-based; absent and null mean not given. */
function parseAnswerAt(v: unknown): NonNullable<CommentResponse["at"]> | null | string {
  if (v === undefined || v === null) return null;
  if (!isFields<"commit" | "unit">(v)) return 'expected { "commit", "unit" }';
  const { commit, unit } = v;
  if (typeof commit !== "number" || !Number.isInteger(commit) || commit < 1) {
    return "commit: expected a commit number counted from 1";
  }
  if (unit === undefined || unit === null) return { commit };
  if (typeof unit !== "string" || !isUnitId(unit)) return "unit: expected a unit id";
  return { commit, unit };
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
      type Fields =
        | "message"
        | "section"
        | "narration"
        | "diagram"
        | "concerns"
        | "offers"
        | "units";
      if (!isFields<Fields>(c)) {
        bad(at, "expected an object");
        continue;
      }
      if (typeof c.message !== "string") bad(`${at}.message`, "expected a string");
      const section = c.section ?? null;
      if (section !== null && !isCommitSection(section)) {
        bad(`${at}.section`, `expected one of ${SECTIONS.join(", ")}`);
      }
      const extras = parseExtras(c, false);
      if ("error" in extras) bad(`${at}.${extras.field}`, extras.error);
      const units: UnitRef[] = [];
      if (!isArray(c.units)) bad(`${at}.units`, "expected an array of unit refs");
      else {
        for (const [j, u] of c.units.entries()) {
          const ref = parseUnitEntry(u);
          if ("error" in ref) bad(`${at}.units[${j}]`, ref.error);
          else units.push(ref);
        }
      }
      if (typeof c.message === "string" && !("error" in extras)) {
        const placed = isCommitSection(section) ? { section } : {};
        commits.push({ message: c.message, ...placed, ...extras, units });
      }
    }
  }

  const responses: CommentResponse[] = [];
  const rawResponses = draft.responses ?? [];
  if (!isArray(rawResponses)) bad("$.responses", "expected an array");
  else {
    for (const [i, r] of rawResponses.entries()) {
      const at = `$.responses[${i}]`;
      if (!isFields<"comment" | "status" | "note" | "at">(r)) bad(at, "expected an object");
      else if (typeof r.comment !== "string" || !isCommentId(r.comment)) {
        bad(`${at}.comment`, "expected a comment id");
      } else if (!isResponseStatus(r.status)) {
        bad(`${at}.status`, `expected one of ${STATUSES.join(", ")}`);
      } else if (typeof r.note !== "string") bad(`${at}.note`, "expected a string");
      else {
        const where = parseAnswerAt(r.at);
        if (typeof where === "string") bad(`${at}.at`, where);
        else {
          responses.push({
            comment: r.comment,
            status: r.status,
            note: r.note,
            ...(where === null ? {} : { at: where }),
          });
        }
      }
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
      ...(c.section === undefined ? {} : { section: c.section }),
      ...serializeExtras(c),
      units: c.units.map((ref) =>
        ref.narration === undefined &&
        ref.diagram === undefined &&
        ref.concerns === undefined &&
        ref.offers === undefined
          ? formatUnitRef(ref)
          : { unit: formatUnitRef(ref), ...serializeExtras(ref) },
      ),
    })),
    responses: file.responses.map((r) => ({
      comment: r.comment,
      status: r.status,
      note: r.note,
      ...(r.at === undefined ? {} : { at: r.at }),
    })),
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

/** "k_" + 8 hex over the unit, the lines and the text: stable while the concern is unchanged. */
function deriveConcernId(unit: UnitId | null, c: Concern): ConcernId {
  const hex = createHash("sha256")
    .update(`${unit ?? ""}\0${(c.lines ?? []).join(",")}\0${c.text}`)
    .digest("hex")
    .slice(0, 8);
  const id = `k_${hex}`;
  if (!isConcernId(id)) throw new Error(`sha256 produced ${id}`);
  return id;
}

/**
 * Gives every concern its id and checks where it sits: lines must be change lines the commit
 * takes, and a unit carries at most one concern in each commit, so each slice of a hunk split
 * across commits may carry its own.
 */
function placeConcerns(
  diff: Diff,
  file: PlanFile,
  claims: Claims,
  issues: PlanIssue[],
): PlacedConcern[][] {
  const ids = new Set<string>();
  const placedPerCommit = file.commits.map((commit, k) => {
    const held = new Map<UnitId, number>();
    const placed: PlacedConcern[] = [];
    const add = (c: Concern, unit: UnitId | null): void => {
      const id = deriveConcernId(unit, c);
      if (ids.has(id)) {
        issues.push({ kind: "bad-concern", commit: k, reason: `${id} repeats another concern` });
        return;
      }
      ids.add(id);
      placed.push({ ...c, id, ...(unit === null ? {} : { unit }) });
    };
    for (const c of commit.concerns ?? []) add(c, null);
    commit.units.forEach((ref, j) => {
      const concerns = ref.concerns ?? [];
      if (concerns.length === 0) return;
      held.set(ref.unit, (held.get(ref.unit) ?? 0) + concerns.length);
      const taken = claims.resolved[k]?.[j]?.select;
      const unit = diff.units.get(ref.unit);
      for (const c of concerns) {
        const lines = c.lines ?? [];
        if (lines.length > 0 && unit?.kind !== "hunk") {
          issues.push({
            kind: "bad-concern",
            commit: k,
            reason: `${ref.unit}: only a text hunk has change lines`,
          });
          continue;
        }
        const takes = taken?.kind === "lines" ? taken : null;
        const outside = takes === null ? [] : lines.filter((n) => !takes.changes.includes(n));
        if (takes !== null && outside.length > 0) {
          issues.push({
            kind: "bad-concern",
            commit: k,
            reason: `${ref.unit}: concern lines ${outside.join(", ")} are not change lines this commit takes; \`lines\` are the hunk's [n] as prompt.md shows them, on a slice too, and this commit takes ${formatUnitRef({ unit: ref.unit, select: takes })}`,
          });
        } else add(c, ref.unit);
      }
    });
    for (const [unit, count] of held) {
      if (count > 1) issues.push({ kind: "too-many-concerns", unit, commit: k, count });
    }
    return placed;
  });
  return placedPerCommit;
}

/** "o_" + 8 hex over the unit and the label: stable while the offer stays at its place. */
function deriveOfferId(unit: UnitId | null, o: Offer): OfferId {
  const hex = createHash("sha256")
    .update(`offer\0${unit ?? ""}\0${o.label}`)
    .digest("hex")
    .slice(0, 8);
  const id = `o_${hex}`;
  if (!isOfferId(id)) throw new Error(`sha256 produced ${id}`);
  return id;
}

/** Gives every offer its id: the commit's own first, then those of its unit refs in order. */
function placeOffers(file: PlanFile, issues: PlanIssue[]): PlacedOffer[][] {
  const ids = new Set<string>();
  return file.commits.map((commit, k) => {
    const placed: PlacedOffer[] = [];
    const add = (o: Offer, unit: UnitId | null): void => {
      const id = deriveOfferId(unit, o);
      if (ids.has(id)) {
        issues.push({ kind: "bad-offer", commit: k, reason: `${id} repeats another offer` });
        return;
      }
      ids.add(id);
      placed.push({ ...o, id, ...(unit === null ? {} : { unit }) });
    };
    for (const o of commit.offers ?? []) add(o, null);
    for (const ref of commit.units) for (const o of ref.offers ?? []) add(o, ref.unit);
    return placed;
  });
}

/** At most OFFERS_PER_COMMIT in a commit, its units' included, and OFFERS_PER_PLAN in all. */
function offerLimits(file: PlanFile): PlanIssue[] {
  const counts = file.commits.map(
    (c) => (c.offers ?? []).length + c.units.reduce((n, r) => n + (r.offers ?? []).length, 0),
  );
  const issues: PlanIssue[] = counts.flatMap((count, commit): PlanIssue[] =>
    count > OFFERS_PER_COMMIT ? [{ kind: "too-many-offers", commit, count }] : [],
  );
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > OFFERS_PER_PLAN) issues.push({ kind: "too-many-offers", commit: null, count: total });
  return issues;
}

function project(
  diff: Diff,
  file: PlanFile,
  claims: Claims,
  issues: PlanIssue[],
): ProjectedCommit[] {
  const concerns = placeConcerns(diff, file, claims, issues);
  const offers = placeOffers(file, issues);
  const { stateAt, tipOf } = projector(diff, claims.owners);
  const present = new Map<RepoPath, boolean>();
  for (const f of diff.textFiles.values()) present.set(f.path, f.base !== null);
  for (const u of diff.units.values()) {
    if (u.kind === "file") present.set(u.path, u.before !== null);
  }

  const commits = file.commits.map((commit, k): ProjectedCommit => {
    const refs = claims.resolved[k] ?? [];
    const mine = concerns[k] ?? [];
    const offered = offers[k] ?? [];
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
      ...(commit.section === undefined ? {} : { section: commit.section }),
      ...withText(commit.narration ?? null, commit.diagram ?? null),
      ...(mine.length === 0 ? {} : { concerns: mine }),
      ...(offered.length === 0 ? {} : { offers: offered }),
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
 * Why an "answered" response is not an answer, or null. It must answer a question and point at a
 * commit, or a unit of it, that carries narration or a diagram to explain it.
 */
function answerProblem(file: PlanFile, r: CommentResponse, isQuestion: boolean): string | null {
  if (!isQuestion) return "answered is only for questions; use addressed, declined or deferred";
  if (r.at === undefined) return 'an answer needs "at" naming the commit that explains it';
  const commit = file.commits[r.at.commit - 1];
  if (commit === undefined) return `at.commit ${r.at.commit} is not a commit of this plan`;
  const target = r.at.unit;
  const ref = target === undefined ? undefined : commit.units.find((u) => u.unit === target);
  if (target !== undefined && ref === undefined) {
    return `commit ${r.at.commit} does not take ${target}`;
  }
  const explains = [commit, ref].some(
    (x) => x?.narration !== undefined || x?.diagram !== undefined,
  );
  return explains ? null : `commit ${r.at.commit} has no narration or diagram to point at`;
}

/**
 * Parses and checks a draft against the diff: every change line used exactly once, every
 * commit's tree valid, and the last commit equal to the tip. Collects all issues at once.
 */
/**
 * Sections read top-down: story, steps, details, wiring. A later section never comes back, so a
 * commit whose section ranks below an earlier commit's must move ahead of the first such commit.
 */
function sectionOrder(file: PlanFile): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const placed: {
    readonly commit: number;
    readonly rank: number;
    readonly section: CommitSection;
  }[] = [];
  file.commits.forEach((c, commit) => {
    if (c.section === undefined) return;
    const rank = SECTIONS.indexOf(c.section);
    const first = placed.find((p) => p.rank > rank);
    if (first !== undefined) {
      issues.push({
        kind: "section-order",
        commit,
        section: c.section,
        before: first.commit,
        beforeSection: first.section,
      });
    } else placed.push({ commit, rank, section: c.section });
  });
  return issues;
}

/**
 * Judges a draft against the diff. `frozen` re-checks a plan that already passed when it was
 * frozen: section order is a rule for drafts, so a plan frozen before it was one still fits.
 */
export function validatePlan(
  diff: Diff,
  draft: unknown,
  opts: { readonly lastReview?: Review | null; readonly frozen?: boolean } = {},
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
  issues.push(...offerLimits(file));
  if (opts.frozen !== true) issues.push(...sectionOrder(file));

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
          .filter((c) => c.author !== "agent" && !answered.has(c.id))
          .map((c) => ({ kind: "unanswered", comment: c.id, review: review.planVersion }));
  file.commits.forEach((c, commit) => {
    const length = (c.message.split("\n")[0] ?? "").length;
    if (length > LONG_TITLE) warnings.push({ kind: "long-title", commit, length });
  });
  const asked = new Map(review?.comments.map((c) => [c.id, c.kind === "question"]));
  for (const r of file.responses) {
    const isQuestion = asked.get(r.comment);
    if (isQuestion === undefined) continue;
    if (r.status === "addressed" && isQuestion) {
      warnings.push({ kind: "question-addressed", comment: r.comment });
    }
    const problem = r.status === "answered" ? answerProblem(file, r, isQuestion) : null;
    if (problem !== null) issues.push({ kind: "bad-answer", comment: r.comment, reason: problem });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { [validated]: true, file, hash: planHash(file), commits },
    warnings,
  };
}
