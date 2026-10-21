// Syntax highlighting: which Prism grammar a path takes, and a hunk body cut into coloured spans per
// row. The tokenizer is passed in, so this module stays pure; prism.ts loads Prism itself.

export type Span = { text: string; readonly tone: string | null };
type Token = { readonly type: string; readonly content: unknown; readonly alias?: unknown };
type BodyLine = { readonly op: " " | "+" | "-"; readonly text: string };

/** Prism language per file extension. Anything else is shown plain. */
const BY_EXTENSION = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["json", "json"],
  ["md", "markdown"],
  ["css", "css"],
  ["html", "markup"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["py", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["rb", "ruby"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["c", "c"],
  ["cpp", "cpp"],
  ["h", "c"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "toml"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["php", "php"],
]);

/** The Prism language for a repo path, or null when it stays plain. */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** Prism token types, and aliases, grouped under the few tones the page colours. */
const TONES = new Map([
  ["comment", "comment"],
  ["prolog", "comment"],
  ["doctype", "comment"],
  ["cdata", "comment"],
  ["keyword", "keyword"],
  ["atrule", "keyword"],
  ["important", "keyword"],
  ["string", "string"],
  ["char", "string"],
  ["attr-value", "string"],
  ["template-string", "string"],
  ["url", "string"],
  ["regex", "string"],
  ["number", "number"],
  ["boolean", "number"],
  ["constant", "number"],
  ["symbol", "number"],
  ["unit", "number"],
  ["function", "function"],
  ["class-name", "type"],
  ["builtin", "type"],
  ["namespace", "type"],
  ["property", "property"],
  ["attr-name", "property"],
  ["variable", "property"],
  ["parameter", "property"],
  ["tag", "tag"],
  ["selector", "tag"],
  ["entity", "tag"],
]);

/** The tone a run takes from its token types, innermost first. null leaves it plain. */
export function toneOf(types: readonly string[]): string | null {
  for (const type of types) {
    const tone = TONES.get(type);
    if (tone !== undefined) return tone;
  }
  return null;
}

function isToken(value: unknown): value is Token {
  return typeof value === "object" && value !== null && "type" in value && "content" in value;
}

function walk(
  stream: readonly unknown[],
  inherited: readonly string[],
  out: { text: string; types: readonly string[] }[],
): void {
  for (const item of stream) {
    if (typeof item === "string") out.push({ text: item, types: inherited });
    else if (isToken(item)) {
      const alias = [item.alias].flat().filter((a): a is string => typeof a === "string");
      const types = [item.type, ...alias, ...inherited];
      walk(Array.isArray(item.content) ? item.content : [item.content], types, out);
    }
  }
}

/** A Prism token stream as lines of spans. Multi-line tokens are cut at each newline. */
export function spansByLine(stream: readonly unknown[]): Span[][] {
  const pieces: { text: string; types: readonly string[] }[] = [];
  walk(stream, [], pieces);
  const lines: Span[][] = [[]];
  for (const piece of pieces) {
    const tone = toneOf(piece.types);
    piece.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      const line = lines.at(-1);
      if (line === undefined || part === "") return;
      const last = line.at(-1);
      if (last?.tone === tone) last.text += part;
      else line.push({ text: part, tone });
    });
  }
  return lines;
}

/**
 * Spans for every row of a hunk, or null when the tokens do not add up to the text and the caller
 * shows plain rows. The old side (context and removals) and the new side (context and additions)
 * are tokenized apart, so a removed line never changes how an added one reads.
 */
export function highlightBody(
  body: readonly BodyLine[],
  tokenize: (text: string) => readonly unknown[],
): Span[][] | null {
  const side = (keep: (line: BodyLine) => boolean): Map<number, Span[]> | null => {
    const indexes = body.flatMap((line, i) => (keep(line) ? [i] : []));
    const texts = indexes.map((i) => (body[i]?.text ?? "").replace(/\n$/, ""));
    if (texts.length === 0) return new Map();
    const lines = spansByLine(tokenize(texts.join("\n")));
    if (lines.length !== texts.length) return null;
    const ok = lines.every((spans, k) => spans.map((s) => s.text).join("") === texts[k]);
    return ok ? new Map(indexes.map((i, k) => [i, lines[k] ?? []])) : null;
  };
  const before = side((line) => line.op !== "+");
  const after = side((line) => line.op !== "-");
  if (before === null || after === null) return null;
  return body.map((line, i) => (line.op === "-" ? before.get(i) : after.get(i)) ?? []);
}
