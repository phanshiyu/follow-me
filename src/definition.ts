import { posix } from "node:path";
import { splitLines, tipStartOf } from "./diff.ts";
import { blobsAt, type GrepMatch, grepTip } from "./git.ts";
import type {
  Candidate,
  DefinitionKind,
  ProjectedCommit,
  RepoPath,
  Sha,
  TextHunk,
  Unit,
  UnitId,
} from "./types.ts";

export const MAX_CANDIDATES = 10;
const PREVIEW_LINES = 8;

/** An ASCII identifier as JS, Python, Go, Rust, JVM languages, Ruby and C spell one. */
export function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(s);
}

/**
 * One way a language defines a name. source is written in the subset JS regexes and POSIX ERE
 * read alike, with \s for whitespace outside brackets; NAME stands for the identifier and END for
 * the end of it. reject drops lines the pattern cannot exclude without lookahead.
 */
type Pattern = {
  readonly kind: DefinitionKind;
  readonly source: string;
  readonly reject?: RegExp;
};

type Language = { readonly extensions: readonly string[]; readonly patterns: readonly Pattern[] };

const JS_MODS = "((static|async|public|private|protected|readonly|override|get|set)\\s+)*";
const RUST_VIS = "(pub([(][^)]*[)])?\\s+)?";
const JAVA_MODS =
  "((public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\\s+)*";
const JVM_CLASS_MODS =
  "((public|private|protected|static|final|abstract|sealed|data|open|internal|inner|enum|annotation)\\s+)*";
const KOTLIN_MODS =
  "((public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|tailrec|external|actual|expect)\\s+)*";
const STATEMENT = /^\s*(return|new|throw|else|case|yield|await|typedef|delete|goto)\b/;

const LANGUAGES: readonly Language[] = [
  {
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
    patterns: [
      {
        kind: "function",
        source: "^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s*[*]?\\s*NAME\\s*[(<]",
      },
      {
        kind: "const",
        source: "^\\s*(export\\s+)?(declare\\s+)?(const|let|var)\\s+NAME\\s*(:[^=]*)?=",
      },
      {
        kind: "class",
        source: "^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?class\\s+NAMEEND",
      },
      {
        kind: "type",
        source: "^\\s*(export\\s+)?(declare\\s+)?(interface|type|(const\\s+)?enum)\\s+NAMEEND",
      },
      {
        kind: "method",
        source: `^\\s+${JS_MODS}[*]?NAME\\s*(<[^>]*>)?[(].*[)]\\s*(:[^={;]+)?[{]\\s*$`,
        reject: /^\s*(if|for|while|switch|catch|return)\b/,
      },
    ],
  },
  {
    extensions: [".py", ".pyi"],
    patterns: [
      { kind: "function", source: "^(async\\s+)?def\\s+NAME\\s*[(]" },
      { kind: "method", source: "^\\s+(async\\s+)?def\\s+NAME\\s*[(]" },
      { kind: "class", source: "^\\s*class\\s+NAME\\s*[(:]" },
    ],
  },
  {
    extensions: [".go"],
    patterns: [
      { kind: "function", source: "^func\\s+NAME\\s*[[(]" },
      { kind: "method", source: "^func\\s*[(][^)]*[)]\\s*NAME\\s*[[(]" },
      { kind: "type", source: "^\\s*type\\s+NAMEEND" },
    ],
  },
  {
    extensions: [".rs"],
    patterns: [
      {
        kind: "function",
        source: `^${RUST_VIS}((const|async|unsafe|extern)\\s+("[^"]*"\\s+)?)*fn\\s+NAME\\s*[<(]`,
      },
      {
        kind: "method",
        source: `^\\s+${RUST_VIS}((const|async|unsafe|extern)\\s+("[^"]*"\\s+)?)*fn\\s+NAME\\s*[<(]`,
      },
      { kind: "class", source: `^\\s*${RUST_VIS}struct\\s+NAMEEND` },
      { kind: "type", source: `^\\s*${RUST_VIS}(enum|trait|type)\\s+NAMEEND` },
      { kind: "other", source: "^\\s*impl(<[^>]*>)?\\s+([A-Za-z0-9_:<>, ]+\\s+for\\s+)?NAMEEND" },
    ],
  },
  {
    extensions: [".java", ".kt", ".kts"],
    patterns: [
      { kind: "class", source: `^\\s*${JVM_CLASS_MODS}(class|object|record)\\s+NAMEEND` },
      { kind: "type", source: `^\\s*${JVM_CLASS_MODS}(interface|enum|@interface)\\s+NAMEEND` },
      {
        kind: "function",
        source: `^\\s*${KOTLIN_MODS}fun\\s+(<[^>]*>\\s*)?([A-Za-z0-9_.<>]+[.])?NAME\\s*[(]`,
      },
      {
        kind: "method",
        source: `^\\s*${JAVA_MODS}(<[^>]*>\\s+)?[A-Za-z_][A-Za-z0-9_<>,.?]*(\\[\\])*\\s+NAME\\s*[(][^;]*$`,
        reject: STATEMENT,
      },
    ],
  },
  {
    extensions: [".rb"],
    patterns: [
      { kind: "method", source: "^\\s*def\\s+(self[.])?NAMEEND" },
      { kind: "class", source: "^\\s*class\\s+NAMEEND" },
      { kind: "other", source: "^\\s*module\\s+NAMEEND" },
    ],
  },
  {
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    patterns: [
      {
        kind: "function",
        source: "^[A-Za-z_][A-Za-z0-9_ *&<>,:~]*[ *&]([A-Za-z_][A-Za-z0-9_]*::)*NAME\\s*[(][^;]*$",
        reject: STATEMENT,
      },
      { kind: "function", source: "^NAME\\s*[(][^;]*$" },
      { kind: "class", source: "^\\s*(typedef\\s+)?(struct|class|union)\\s+NAME\\s*([{:]|$)" },
      { kind: "type", source: "^\\s*(typedef\\s+)?enum\\s+(class\\s+)?NAME\\s*([{:]|$)" },
    ],
  },
];

const END = "([^A-Za-z0-9_$]|$)";

function spell(source: string, name: string): string {
  return source
    .replaceAll("NAMEEND", `${name.replaceAll("$", "[$]")}${END}`)
    .replaceAll("NAME", name.replaceAll("$", "[$]"));
}

function toEre(source: string): string {
  return source.replaceAll("\\s", "[[:space:]]");
}

function languageOf(path: RepoPath): Language | null {
  const ext = posix.extname(path).toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}

/** What the match defines by the patterns of its file's language, or null when it is no definition. */
function kindOf(match: GrepMatch, name: string): DefinitionKind | null {
  const language = languageOf(match.path);
  if (language === null) return null;
  const hit = language.patterns.find(
    (p) => new RegExp(spell(p.source, name)).test(match.text) && !p.reject?.test(match.text),
  );
  return hit?.kind ?? null;
}

type Found = { readonly path: RepoPath; readonly newLine: number; readonly kind: DefinitionKind };

/** Same file as `from` first, then the same directory, then the rest, each in path and line order. */
export function rank<T extends { readonly path: RepoPath }>(
  found: readonly T[],
  from: RepoPath | null,
): T[] {
  const tier = (path: RepoPath): number => {
    if (from === null) return 2;
    if (path === from) return 0;
    return posix.dirname(path) === posix.dirname(from) ? 1 : 2;
  };
  return found
    .map((f, i) => ({ f, i, t: tier(f.path) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ f }) => f);
}

type Placement = Pick<Candidate, "unit" | "row" | "commit">;

const NOWHERE: Placement = { unit: null, row: null, commit: null };

/**
 * The hunk row that holds tip line `line` of `path`, and the commit that writes it: the owner of a
 * change row, or the first commit taking the unit for a context row.
 */
export function place(
  units: ReadonlyMap<UnitId, Unit>,
  commits: readonly Pick<ProjectedCommit, "refs">[],
  path: RepoPath,
  line: number,
): Placement {
  for (const unit of units.values()) {
    if (unit.kind !== "hunk" || unit.path !== path) continue;
    const row = rowAt(unit, tipStartOf(unit, units), line);
    if (row === null) continue;
    const body = unit.body[row];
    const change = body !== undefined && body.op !== " " ? body.change : null;
    const takes = (c: Pick<ProjectedCommit, "refs">) =>
      c.refs.some(
        (r) =>
          r.unit === unit.id &&
          (change === null || r.select.kind === "rest" || r.select.changes.includes(change)),
      );
    const k = commits.findIndex(takes);
    return { unit: unit.id, row, commit: k === -1 ? null : k };
  }
  return NOWHERE;
}

function rowAt(hunk: TextHunk, tipStart: number, line: number): number | null {
  let tipLine = tipStart;
  for (const [row, body] of hunk.body.entries()) {
    if (body.op === "-") continue;
    if (tipLine === line) return row;
    tipLine += 1;
  }
  return null;
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

export type DefinitionIndex = {
  /** The ranked places `name` is defined, at most MAX_CANDIDATES. name must be an identifier. */
  lookup(name: string, from: RepoPath | null): Promise<Candidate[]>;
};

/**
 * Where names are defined at one branch tip and where each lands in the plan. Built per hosted
 * version, so a swap starts a fresh one; matches are cached per name and file lines per path.
 */
export function definitionIndex(
  repo: string,
  tip: Sha,
  units: ReadonlyMap<UnitId, Unit>,
  commits: readonly Pick<ProjectedCommit, "refs">[],
): DefinitionIndex {
  const foundByName = new Map<string, Promise<readonly Found[]>>();
  const linesByPath = new Map<RepoPath, readonly string[]>();

  const find = (name: string): Promise<readonly Found[]> => {
    const cached = foundByName.get(name);
    if (cached !== undefined) return cached;
    const patterns = [
      ...new Set(LANGUAGES.flatMap((l) => l.patterns.map((p) => toEre(spell(p.source, name))))),
    ];
    const pathspecs = LANGUAGES.flatMap((l) => l.extensions.map((e) => `*${e}`));
    const found = grepTip(repo, tip, patterns, pathspecs).then((matches) =>
      matches.flatMap((m) => {
        const kind = kindOf(m, name);
        return kind === null ? [] : [{ path: m.path, newLine: m.line, kind }];
      }),
    );
    foundByName.set(name, found);
    // A failed grep is not an answer; the next request tries again.
    found.catch(() => foundByName.delete(name));
    return found;
  };

  const load = async (paths: readonly RepoPath[]): Promise<void> => {
    const missing = [...new Set(paths)].filter((p) => !linesByPath.has(p));
    if (missing.length === 0) return;
    for (const [path, bytes] of await blobsAt(repo, tip, missing)) {
      linesByPath.set(path, splitLines(bytes).map(stripEol));
    }
  };

  return {
    lookup: async (name, from) => {
      const ranked = rank(await find(name), from).slice(0, MAX_CANDIDATES);
      await load(ranked.map((f) => f.path));
      return ranked.map((f) => ({
        ...f,
        ...place(units, commits, f.path, f.newLine),
        preview: (linesByPath.get(f.path) ?? []).slice(
          f.newLine - 1,
          f.newLine - 1 + PREVIEW_LINES,
        ),
      }));
    },
  };
}
