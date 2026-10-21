// @ts-check
// Pure syntax highlighting logic. The browser imports it from /highlight.js and the tests import
// it directly, so nothing here may touch the DOM. Prism itself is injected as a tokenize function.

/**
 * @typedef {{ text: string, tone: string | null }} Span
 * @typedef {{ type: string, content: unknown, alias?: string | string[] }} PrismToken
 * @typedef {{ op: " " | "+" | "-", text: string }} BodyLine
 */

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

/**
 * Prism components to load for a language, dependencies first. html also takes the script and
 * style grammars so inline code in a page is coloured.
 */
const COMPONENTS = new Map([
  ["javascript", ["clike", "javascript"]],
  ["jsx", ["markup", "clike", "javascript", "jsx"]],
  ["typescript", ["clike", "javascript", "typescript"]],
  ["tsx", ["markup", "clike", "javascript", "jsx", "typescript", "tsx"]],
  ["json", ["json"]],
  ["markdown", ["markup", "markdown"]],
  ["css", ["css"]],
  ["markup", ["markup", "clike", "javascript", "css"]],
  ["bash", ["bash"]],
  ["python", ["python"]],
  ["go", ["clike", "go"]],
  ["rust", ["rust"]],
  ["ruby", ["clike", "ruby"]],
  ["java", ["clike", "java"]],
  ["kotlin", ["clike", "kotlin"]],
  ["c", ["clike", "c"]],
  ["cpp", ["clike", "c", "cpp"]],
  ["yaml", ["yaml"]],
  ["toml", ["toml"]],
  ["sql", ["sql"]],
  ["swift", ["swift"]],
  ["php", ["markup", "markup-templating", "php"]],
]);

/**
 * The Prism language for a repo path, or null when it should stay plain.
 * @param {string} path
 * @returns {string | null}
 */
export function languageFor(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * Prism component names to load, in order, to highlight a language. Empty for an unknown one.
 * @param {string} language
 * @returns {readonly string[]}
 */
export function componentsFor(language) {
  return COMPONENTS.get(language) ?? [];
}

/**
 * Every component needed for a set of languages, each once, in an order that keeps dependencies
 * first.
 * @param {Iterable<string>} languages
 */
export function componentsForAll(languages) {
  const seen = new Set();
  for (const language of languages) for (const name of componentsFor(language)) seen.add(name);
  // Each list is dependency ordered, and a Set keeps first insertion, so dependencies stay first.
  return [...seen];
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

/**
 * The tone a run of text takes from its token types, innermost first. null leaves it plain.
 * @param {readonly string[]} types
 * @returns {string | null}
 */
export function toneOf(types) {
  for (const type of types) {
    const tone = TONES.get(type);
    if (tone !== undefined) return tone;
  }
  return null;
}

/** @param {unknown} value @returns {value is PrismToken} */
function isToken(value) {
  return typeof value === "object" && value !== null && "type" in value && "content" in value;
}

/**
 * @param {readonly unknown[]} stream
 * @param {readonly string[]} inherited
 * @param {{ text: string, types: readonly string[] }[]} out
 */
function walk(stream, inherited, out) {
  for (const item of stream) {
    if (typeof item === "string") out.push({ text: item, types: inherited });
    else if (isToken(item)) {
      const alias = item.alias === undefined ? [] : [item.alias].flat();
      const types = [item.type, ...alias, ...inherited];
      walk(Array.isArray(item.content) ? item.content : [item.content], types, out);
    }
  }
}

/**
 * Splits a Prism token stream into lines of spans. Multi-line tokens, such as block comments,
 * are cut at each newline so every line carries its own spans. Line ends are dropped.
 * @param {readonly unknown[]} stream
 * @returns {Span[][]}
 */
export function spansByLine(stream) {
  /** @type {{ text: string, types: readonly string[] }[]} */
  const pieces = [];
  walk(stream, [], pieces);
  /** @type {Span[][]} */
  const lines = [[]];
  for (const piece of pieces) {
    const tone = toneOf(piece.types);
    piece.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      const line = lines[lines.length - 1];
      if (line === undefined || part === "") return;
      const last = line.at(-1);
      if (last?.tone === tone) last.text += part;
      else line.push({ text: part, tone });
    });
  }
  return lines;
}

/**
 * Highlights every line of a hunk body, or returns null when the tokens do not add up to the
 * text, in which case the caller shows plain lines. The old side (context and removed lines) and
 * the new side (context and added lines) are tokenized apart, so a removed line never changes
 * how an added one reads. Context takes its colours from the new side.
 * @param {readonly BodyLine[]} body
 * @param {(text: string) => readonly unknown[]} tokenize
 * @returns {Span[][] | null}
 */
export function highlightBody(body, tokenize) {
  /** @param {(line: BodyLine) => boolean} keep */
  const side = (keep) => {
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
