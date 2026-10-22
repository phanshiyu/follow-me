/**
 * Refs: the places in the code an agent's reply points at, written as inline code spans in the
 * grammar `follow-me show` reads (`path:12`, `path:12-18`, either with `@<commit>` or `@base`).
 * Finding them in markdown, resolving them against the plan and the tip, and parsing the stored
 * form are pure; reading tip files the branch does not change is the caller's.
 */
import type {
  CodeRef,
  HunkLine,
  LineSpan,
  ProjectedCommit,
  RepoPath,
  Sha,
  TextFile,
  TextHunk,
} from "./types.ts";

/** A ref as written: the path as typed (UTF-8), 1-based inclusive lines, and the version. */
export type RefSpec = {
  readonly text: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly at: number | "base" | null;
};

/** Lines quoted per ref, as comments quote their rows. */
export const QUOTE_LINES = 8;

const GRAMMAR = /^(.+):(\d+)(?:-(\d+))?(?:@(\d+|base))?$/;

/** `path:12`, `path:12-18`, `path:12@3`, `path:12-18@base`, or null when it is none of those. */
export function parseRefText(text: string): RefSpec | null {
  const m = GRAMMAR.exec(text);
  const [, path, startRaw, endRaw, atRaw] = m ?? [];
  if (path === undefined || startRaw === undefined) return null;
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  const at = atRaw === undefined ? null : atRaw === "base" ? "base" : Number(atRaw);
  return { text, path, start, end, at };
}

/** One key per place, so `a.ts:5` and `a.ts:5-5` share a number. */
export function refKey(spec: Pick<RefSpec, "path" | "start" | "end" | "at">): string {
  return `${spec.path}:${spec.start}-${spec.end}@${spec.at ?? "tip"}`;
}

/**
 * A code span names a file when its path has a letter and a slash or a dot, so `10:30`,
 * `localhost:3000` and `127.0.0.1:80` stay code.
 */
function looksLikeFile(path: string): boolean {
  return /[A-Za-z]/.test(path) && /[/.]/.test(path) && !/\s/.test(path);
}

/**
 * The text of every inline code span outside fenced blocks, in order, read as CommonMark does: a
 * run of backticks closes only on a run of the same length, and one space padding both ends is
 * dropped.
 */
export function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  let fence: string | null = null;
  const prose: string[] = [];
  for (const line of markdown.split("\n")) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && opener !== undefined) {
      fence = opener;
      prose.push("");
      continue;
    }
    if (fence !== null) {
      const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length)
        fence = null;
      prose.push("");
      continue;
    }
    prose.push(line);
  }
  // Spans never cross a blank line, which ends the paragraph.
  for (const paragraph of prose.join("\n").split(/\n\s*\n/)) {
    let i = 0;
    while (i < paragraph.length) {
      const c = paragraph[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c !== "`") {
        i += 1;
        continue;
      }
      let run = 0;
      while (paragraph[i + run] === "`") run += 1;
      const open = i + run;
      let close = -1;
      for (let j = open; j < paragraph.length; ) {
        if (paragraph[j] !== "`") {
          j += 1;
          continue;
        }
        let k = 0;
        while (paragraph[j + k] === "`") k += 1;
        if (k === run) {
          close = j;
          break;
        }
        j += k;
      }
      if (close === -1) {
        i = open;
        continue;
      }
      let text = paragraph.slice(open, close).replace(/\n/g, " ");
      if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
        text = text.slice(1, -1);
      }
      spans.push(text);
      i = close + run;
    }
  }
  return spans;
}

/** The refs a reply's markdown writes, each place once, in order of first appearance. */
export function refsIn(markdown: string): RefSpec[] {
  const seen = new Set<string>();
  const specs: RefSpec[] = [];
  for (const span of codeSpans(markdown)) {
    const spec = parseRefText(span);
    if (spec === null || !looksLikeFile(spec.path)) continue;
    const key = refKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
  }
  return specs;
}

/** One line of a file in some version, and where it sits at the tip or, once removed, the base. */
export type PlacedLine = {
  readonly text: string;
  readonly tip: number | null;
  readonly base: number | null;
};

/**
 * Every line of a changed text file as it reads with the given change lines applied: none for
 * the base, all for the tip, the plan's first n commits for commit n. Null when the file does
 * not exist then.
 */
export function linesWith(
  file: TextFile,
  applied: (hunk: TextHunk, line: HunkLine & { readonly op: "+" | "-" }) => boolean,
): PlacedLine[] | null {
  const changes = file.hunks.flatMap((h) =>
    h.body.flatMap((l) => (l.op === " " ? [] : [applied(h, l)])),
  );
  const any = changes.some((c) => c);
  const all = changes.every((c) => c);
  if (file.base === null ? !any : file.tip === null && all) return null;
  const base = file.base?.lines ?? [];
  const out: PlacedLine[] = [];
  let b = 0;
  let t = 0;
  const keep = (text: string) => {
    b += 1;
    t += 1;
    out.push({ text, tip: t, base: b });
  };
  for (const hunk of file.hunks) {
    while (b < hunk.oldStart) keep(base[b] ?? "");
    for (const line of hunk.body) {
      if (line.op === " ") keep(line.text);
      else if (line.op === "-") {
        b += 1;
        if (!applied(hunk, line)) out.push({ text: line.text, tip: null, base: b });
      } else {
        t += 1;
        if (applied(hunk, line)) out.push({ text: line.text, tip: t, base: null });
      }
    }
  }
  while (b < base.length) keep(base[b] ?? "");
  return out;
}

/** Whether the plan's first n commits take this change line. */
export function takenBy(
  commits: readonly Pick<ProjectedCommit, "refs">[],
): (hunk: TextHunk, line: HunkLine & { readonly op: "+" | "-" }) => boolean {
  return (hunk, line) =>
    commits.some((c) =>
      c.refs.some(
        (r) =>
          r.unit === hunk.id &&
          (r.select.kind === "rest" || r.select.changes.includes(line.change)),
      ),
    );
}

/** Where to read a ref's file: changed text files from the diff, others from the tip. */
export type RefSource = {
  readonly tip: Sha;
  readonly textFiles: ReadonlyMap<RepoPath, TextFile>;
  /** Paths the branch changes that are not text: binary, symlink, gitlink, mode-only kinds. */
  readonly otherChanged: ReadonlySet<string>;
  /** Lines of tip files the branch leaves alone, for every such path the refs name. */
  readonly unchanged: ReadonlyMap<RepoPath, readonly string[]>;
  readonly commits: readonly Pick<ProjectedCommit, "refs">[];
  /** The open plan version, to name in a refusal. */
  readonly version: number;
};

/** The repo path a typed path names: its UTF-8 as the latin1 bytes git prints. */
export function repoPathOfTyped(typed: string): string {
  return Buffer.from(typed, "utf8").toString("latin1");
}

function utf8(latin1: string): string {
  return Buffer.from(latin1, "latin1").toString("utf8");
}

function spanOf(ns: readonly number[]): LineSpan | null {
  if (ns.length === 0) return null;
  return { start: Math.min(...ns), end: Math.max(...ns) };
}

function versionLabel(at: RefSpec["at"]): string {
  return at === null ? "at the tip" : at === "base" ? "in the base" : `in commit ${at}`;
}

/** A written ref resolved to its lines and quote, numbered n, or the reason it does not resolve. */
export function resolveRef(spec: RefSpec, n: number, source: RefSource): CodeRef | string {
  const { text, start, end, at } = spec;
  if (start < 1) return `${text}: lines count from 1`;
  if (end < start) return `${text} ends before it starts`;
  if (typeof at === "number" && (at < 1 || at > source.commits.length)) {
    const count = source.commits.length;
    return `${text}: plan v${source.version} has ${count} commit${count === 1 ? "" : "s"}`;
  }
  const path = repoPathOfTyped(spec.path);
  const where = versionLabel(at);
  let lines: readonly PlacedLine[];
  let repoPath: RepoPath;
  const file = [...source.textFiles.values()].find((f) => f.path === path);
  const plain = [...source.unchanged].find(([p]) => p === path);
  if (file !== undefined) {
    const applied =
      at === null ? () => true : at === "base" ? () => false : takenBy(source.commits.slice(0, at));
    const found = linesWith(file, applied);
    if (found === null) return `${text}: the file does not exist ${where}`;
    lines = found;
    repoPath = file.path;
  } else if (source.otherChanged.has(path)) {
    return `${text}: not a text file`;
  } else if (plain !== undefined) {
    lines = plain[1].map((t, i) => ({ text: t, tip: i + 1, base: i + 1 }));
    repoPath = plain[0];
  } else return `${text}: no such file at the tip`;
  if (end > lines.length) {
    return `${text} is past the end of the file ${where} (${lines.length} lines)`;
  }
  const picked = lines.slice(start - 1, end);
  const kept = picked.flatMap((l) => (l.tip === null ? [] : [l.tip]));
  const removed = picked.flatMap((l) => (l.tip === null && l.base !== null ? [l.base] : []));
  return {
    n,
    path: repoPath,
    start,
    end,
    at,
    quote: picked.slice(0, QUOTE_LINES).map((l) => utf8(l.text).replace(/\r?\n$/, "")),
    tip: source.tip,
    lines: spanOf(kept),
    old: spanOf(removed),
  };
}

/** Every ref of a body resolved, or every reason one does not, so one fix round is enough. */
export function resolveRefs(
  specs: readonly RefSpec[],
  source: RefSource,
): { refs: CodeRef[]; problems: string[] } {
  const refs: CodeRef[] = [];
  const problems: string[] = [];
  specs.forEach((spec, i) => {
    const ref = resolveRef(spec, i + 1, source);
    if (typeof ref === "string") problems.push(ref);
    else refs.push(ref);
  });
  return { refs, problems };
}
