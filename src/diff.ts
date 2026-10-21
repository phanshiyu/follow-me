import { createHash } from "node:crypto";
import type {
  Diff,
  Entry,
  FileMode,
  FileUnit,
  FileUnitId,
  HunkId,
  HunkLine,
  Line,
  ModeUnitId,
  RepoPath,
  Sha,
  TextFile,
  TextHunk,
  Unit,
  UnitId,
  UnitRef,
} from "./types.ts";

export class DiffParseError extends Error {
  override readonly name = "DiffParseError";
  readonly path: string;
  readonly hunk: string | null;
  constructor(path: string, hunk: string | null, reason: string) {
    super(`${path}${hunk === null ? "" : ` ${hunk}`}: ${reason}`);
    this.path = path;
    this.hunk = hunk;
  }
}

export function isSha(s: string): s is Sha {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

export function isRepoPath(s: string): s is RepoPath {
  return s.length > 0 && !s.includes("\0");
}

export function isFileMode(s: string): s is FileMode {
  return s === "100644" || s === "100755" || s === "120000" || s === "160000";
}

const ID_SUFFIX = "_[0-9a-f]{12}(?:~[1-9][0-9]*)?$";
export function isHunkId(s: string): s is HunkId {
  return new RegExp(`^h${ID_SUFFIX}`).test(s);
}
export function isFileUnitId(s: string): s is FileUnitId {
  return new RegExp(`^f${ID_SUFFIX}`).test(s);
}
export function isModeUnitId(s: string): s is ModeUnitId {
  return new RegExp(`^m${ID_SUFFIX}`).test(s);
}
export function isUnitId(s: string): s is UnitId {
  return isHunkId(s) || isFileUnitId(s) || isModeUnitId(s);
}

type RawRecord = {
  readonly path: RepoPath;
  readonly status: string;
  readonly before: Entry | null;
  readonly after: Entry | null;
};

type RawHunk = {
  readonly header: string;
  readonly oldStart: number;
  /** Patch lines with their op character, including "\" markers. */
  readonly lines: readonly string[];
};

type Section = { readonly binary: boolean; readonly hunks: readonly RawHunk[] };

type Classified =
  | { readonly kind: "text"; readonly record: RawRecord; readonly hunks: readonly RawHunk[] }
  | { readonly kind: "file"; readonly record: RawRecord; readonly reason: FileUnit["reason"] };

function parseEntry(mode: string, sha: string, path: string): Entry | null {
  if (/^0+$/.test(mode)) return null;
  if (!isFileMode(mode)) throw new DiffParseError(path, null, `unsupported mode ${mode}`);
  if (!isSha(sha)) throw new DiffParseError(path, null, `expected a full object id, got ${sha}`);
  return { mode, blob: sha };
}

function parseRaw(rawZ: string): RawRecord[] {
  const tokens = rawZ.split("\0");
  const records: RawRecord[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const header = tokens[i] ?? "";
    const path = tokens[i + 1] ?? "";
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(header);
    if (m === null || !isRepoPath(path)) {
      throw new DiffParseError(path || "(raw)", null, `unreadable raw record ${header}`);
    }
    const [, oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = m;
    records.push({
      path,
      status,
      before: parseEntry(oldMode, oldSha, path),
      after: parseEntry(newMode, newSha, path),
    });
  }
  return records;
}

function parsePatch(patch: string): Section[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i] ?? "";
    if (!start.startsWith("diff --git ")) {
      throw new DiffParseError("(patch)", null, `expected "diff --git", got ${start}`);
    }
    i++;
    let binary = false;
    const hunks: RawHunk[] = [];
    for (let line = lines[i]; line !== undefined && !line.startsWith("diff --git "); ) {
      if (!line.startsWith("@@ ")) {
        if (line.startsWith("Binary files ")) binary = true;
        line = lines[++i];
        continue;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new DiffParseError(start, line, "unreadable hunk header");
      const header = line;
      const a = Number(m[1]);
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[3] === undefined ? 1 : Number(m[3]);
      const oldStart = oldLeft === 0 ? a : a - 1;
      const body: string[] = [];
      i++;
      while (oldLeft > 0 || newLeft > 0 || lines[i]?.startsWith("\\")) {
        const raw = lines[i];
        if (raw === undefined) throw new DiffParseError(start, header, "hunk ends early");
        // diff.suppressBlankEmpty prints an empty context line without its leading space.
        const text = raw === "" ? " " : raw;
        const op = text[0];
        if (op === " ") {
          oldLeft--;
          newLeft--;
        } else if (op === "-") oldLeft--;
        else if (op === "+") newLeft--;
        else if (op !== "\\") throw new DiffParseError(start, header, `unexpected line ${raw}`);
        if (oldLeft < 0 || newLeft < 0) {
          throw new DiffParseError(start, header, "hunk is longer than its header says");
        }
        body.push(text);
        i++;
      }
      hunks.push({ header, oldStart, lines: body });
      line = lines[i];
    }
    sections.push({ binary, hunks });
  }
  return sections;
}

function classify(record: RawRecord, sections: readonly Section[]): Classified {
  const { before, after, status } = record;
  const modes = [before?.mode, after?.mode];
  const hunks = sections.flatMap((s) => s.hunks);
  if (status === "T") return { kind: "file", record, reason: "typechange" };
  if (modes.includes("160000")) return { kind: "file", record, reason: "gitlink" };
  if (modes.includes("120000")) return { kind: "file", record, reason: "symlink" };
  if (sections.some((s) => s.binary)) return { kind: "file", record, reason: "binary" };
  if ((before === null || after === null) && hunks.length === 0) {
    return { kind: "file", record, reason: "empty" };
  }
  return { kind: "text", record, hunks };
}

/** Walks raw records and patch sections in lockstep; git prints both in the same order. */
function classifyAll(rawZ: string, patch: string): Classified[] {
  const records = parseRaw(rawZ);
  const sections = parsePatch(patch);
  let next = 0;
  const out = records.map((record) => {
    // A type change prints as a deletion section followed by a creation section.
    const take = record.status === "T" ? 2 : 1;
    const mine = sections.slice(next, next + take);
    next += take;
    if (mine.length !== take) {
      throw new DiffParseError(record.path, null, "patch has fewer sections than raw records");
    }
    return classify(record, mine);
  });
  if (next !== sections.length) {
    throw new DiffParseError("(patch)", null, "patch has more sections than raw records");
  }
  return out;
}

/** Blobs parseDiff will read: both sides of every text file. */
export function neededBlobs(rawZ: string, patch: string): Sha[] {
  const shas = new Set<Sha>();
  for (const c of classifyAll(rawZ, patch)) {
    if (c.kind !== "text") continue;
    if (c.record.before) shas.add(c.record.before.blob);
    if (c.record.after) shas.add(c.record.after.blob);
  }
  return [...shas];
}

export function splitLines(s: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let nl = s.indexOf("\n"); nl !== -1; nl = s.indexOf("\n", start)) {
    lines.push(s.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "latin1").digest("hex").slice(0, 12);
}

function mint<T extends string>(guard: (s: string) => s is T, s: string): T {
  if (guard(s)) return s;
  throw new Error(`minted an invalid id ${s}`);
}

function buildHunk(
  path: RepoPath,
  raw: RawHunk,
  base: readonly Line[],
  idFor: (body: readonly HunkLine[]) => HunkId,
): TextHunk {
  const body: HunkLine[] = [];
  let change = 0;
  for (const text of raw.lines) {
    const op = text[0];
    const line = `${text.slice(1)}\n`;
    if (op === "\\") {
      const prev = body.pop();
      if (prev === undefined) throw new DiffParseError(path, raw.header, "marker without a line");
      body.push({ ...prev, text: prev.text.slice(0, -1) });
    } else if (op === " ") body.push({ op, text: line });
    else if (op === "-" || op === "+") body.push({ op, text: line, change: change++ });
  }
  let at = raw.oldStart;
  for (const line of body) {
    if (line.op === "+") continue;
    if (base[at] !== line.text) {
      throw new DiffParseError(path, raw.header, `line ${at + 1} does not match the base blob`);
    }
    at++;
  }
  return {
    kind: "hunk",
    id: idFor(body),
    path,
    oldStart: raw.oldStart,
    body,
    changeCount: change,
  };
}

export function parseDiff(input: {
  readonly base: Sha;
  readonly tip: Sha;
  readonly baseTree: Sha;
  readonly tipTree: Sha;
  readonly rawZ: string;
  readonly patch: string;
  readonly blobs: ReadonlyMap<Sha, string>;
}): Diff {
  const units = new Map<UnitId, Unit>();
  const textFiles = new Map<RepoPath, TextFile>();
  const seen = new Map<string, number>();
  const unique = (id: string): string => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  };
  const blob = (path: RepoPath, entry: Entry): string => {
    const bytes = input.blobs.get(entry.blob);
    if (bytes === undefined) throw new DiffParseError(path, null, `blob ${entry.blob} not loaded`);
    return bytes;
  };

  for (const c of classifyAll(input.rawZ, input.patch)) {
    const { path, before, after } = c.record;
    if (c.kind === "file") {
      const id = mint(isFileUnitId, unique(`f_${digest([path, before, after])}`));
      units.set(id, { kind: "file", id, path, before, after, reason: c.reason });
      continue;
    }
    const baseLines = before ? splitLines(blob(path, before)) : [];
    const hunks = c.hunks.map((raw) =>
      buildHunk(path, raw, baseLines, (body) =>
        mint(isHunkId, unique(`h_${digest([path, body.map((l) => [l.op, l.text])])}`)),
      ),
    );
    const file: TextFile = {
      path,
      base: before ? { entry: before, lines: baseLines } : null,
      tip: after ? { entry: after, bytes: blob(path, after) } : null,
      hunks,
    };
    if (projectFile(file, () => true) !== (file.tip?.bytes ?? null)) {
      throw new DiffParseError(path, null, "hunks do not reproduce the tip blob");
    }
    textFiles.set(path, file);
    for (const h of hunks) units.set(h.id, h);
    if (before && after && before.mode !== after.mode) {
      const id = mint(isModeUnitId, unique(`m_${digest([path, before.mode, after.mode])}`));
      units.set(id, { kind: "mode", id, path, from: before.mode, to: after.mode });
    }
  }
  return {
    base: input.base,
    tip: input.tip,
    baseTree: input.baseTree,
    tipTree: input.tipTree,
    units,
    textFiles,
  };
}

/**
 * The file's bytes once the given change lines are applied to base, or null when the file
 * does not exist in that state. Hunks are disjoint in base coordinates, so any subset is valid.
 */
export function projectFile(
  file: TextFile,
  applied: (hunk: TextHunk, change: number) => boolean,
): string | null {
  let any = false;
  let all = true;
  for (const h of file.hunks) {
    for (let c = 0; c < h.changeCount; c++) {
      if (applied(h, c)) any = true;
      else all = false;
    }
  }
  if (file.base === null && !any) return null;
  if (file.tip === null && all) return null;
  const base = file.base?.lines ?? [];
  const out: string[] = [];
  let at = 0;
  for (const h of file.hunks) {
    out.push(...base.slice(at, h.oldStart));
    at = h.oldStart;
    for (const line of h.body) {
      if (line.op === " ") {
        out.push(line.text);
        at++;
      } else if (line.op === "-") {
        if (!applied(h, line.change)) out.push(line.text);
        at++;
      } else if (applied(h, line.change)) out.push(line.text);
    }
  }
  out.push(...base.slice(at));
  return out.join("");
}

export function formatUnitRef(ref: UnitRef): string {
  if (ref.select.kind === "rest") return ref.unit;
  const sorted = [...ref.select.changes].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i] ?? end;
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    i++;
  }
  return `${ref.unit}:${ranges.join(",")}`;
}

const MAX_RANGE = 1_000_000;

export function parseUnitRef(s: string): UnitRef | { readonly error: string } {
  const [unit = "", select, ...extra] = s.split(":");
  if (!isUnitId(unit)) return { error: `"${unit}" is not a unit id` };
  if (extra.length > 0) return { error: "expected at most one ':'" };
  if (select === undefined) return { unit, select: { kind: "rest" } };
  const changes: number[] = [];
  for (const part of select.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) return { error: `"${part}" is not a change index or range` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) return { error: `range ${part} runs backwards` };
    if (to - from > MAX_RANGE) return { error: `range ${part} is too large` };
    for (let c = from; c <= to; c++) changes.push(c);
  }
  return { unit, select: { kind: "lines", changes } };
}

/** Where the hunk starts in the tip: its base position shifted by earlier hunks of the file. */
export function tipStartOf(hunk: TextHunk, units: ReadonlyMap<UnitId, Unit>): number {
  let shift = 0;
  for (const u of units.values()) {
    if (u.kind !== "hunk" || u.path !== hunk.path || u.oldStart >= hunk.oldStart) continue;
    for (const line of u.body) shift += line.op === "+" ? 1 : line.op === "-" ? -1 : 0;
  }
  return hunk.oldStart + shift + 1;
}
