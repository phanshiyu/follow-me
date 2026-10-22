// The agent writes markdown. It renders as sanitised HTML, with fenced mermaid blocks split out so
// the page draws them as diagrams. Images and raw HTML never render; they show as their text.

import DOMPurify from "dompurify";
import { Marked, type Token, type TokensList } from "marked";

export type Block =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "mermaid"; readonly source: string };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const RENDERER = {
  html: ({ text }: { text: string }) => escapeHtml(text),
  image: ({ text }: { text: string }) => escapeHtml(text),
};

const marked = new Marked({ gfm: true, renderer: RENDERER });

/** Which ref an inline code span writes, by its number, or null for plain code. */
export type RefNumber = (code: string) => number | null;

/**
 * A code span that writes a ref renders as an empty placeholder the page fills with its chip, so
 * the chip is a live element rather than markup.
 */
function markedWith(numberOf: RefNumber): Marked {
  return new Marked({
    gfm: true,
    renderer: {
      ...RENDERER,
      codespan: ({ text }) => {
        const n = numberOf(text);
        return n === null ? false : `<span data-ref="${n}"></span>`;
      },
    },
  });
}

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "a",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
];

function render(parser: Marked, tokens: Token[], links: TokensList["links"]): string {
  const list: TokensList = Object.assign([...tokens], { links });
  const html = parser.parser(list);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "align", "data-ref"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  });
}

/** The markdown as blocks; with numberOf, code spans that write a ref become chip placeholders. */
export function blocksOf(text: string, numberOf?: RefNumber): Block[] {
  const parser = numberOf === undefined ? marked : markedWith(numberOf);
  const tokens = parser.lexer(text);
  const blocks: Block[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length > 0) blocks.push({ kind: "html", html: render(parser, run, tokens.links) });
    run = [];
  };
  for (const token of tokens) {
    if (
      token.type === "code" &&
      "lang" in token &&
      token.lang?.trim() === "mermaid" &&
      "text" in token
    ) {
      flush();
      blocks.push({ kind: "mermaid", source: String(token.text) });
    } else run.push(token);
  }
  flush();
  return blocks;
}

function childrenOf(token: Token): readonly Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

/** A list item's first paragraph as one line of plain text, with its refs left out. */
function captionOf(item: Token, numberOf: RefNumber): string {
  const first = childrenOf(item).find((t) => t.type === "text" || t.type === "paragraph");
  const words = (tokens: readonly Token[]): string =>
    tokens
      .map((t) => {
        if (t.type === "codespan" && "text" in t) {
          return numberOf(String(t.text)) === null ? String(t.text) : "";
        }
        const inner = childrenOf(t);
        if (inner.length > 0) return words(inner);
        return "text" in t ? String(t.text) : "";
      })
      .join("");
  return words(first === undefined ? [] : childrenOf(first))
    .replace(/\s+/g, " ")
    .replace(/^[\s,:;.–—-]+/, "")
    .trim();
}

/**
 * Each ref's caption in a walkthrough: the words of the list item that first holds it. A ref
 * first written outside a list has none.
 */
export function captionsOf(text: string, numberOf: RefNumber): Map<number, string> {
  const captions = new Map<number, string>();
  const seen = new Set<number>();
  const visit = (tokens: readonly Token[], item: Token | null) => {
    for (const token of tokens) {
      if (token.type === "codespan" && "text" in token) {
        const n = numberOf(String(token.text));
        if (n === null || seen.has(n)) continue;
        seen.add(n);
        const caption = item === null ? "" : captionOf(item, numberOf);
        if (caption !== "") captions.set(n, caption);
      } else if (token.type === "list" && "items" in token && Array.isArray(token.items)) {
        for (const listItem of token.items) visit(childrenOf(listItem), listItem);
      } else visit(childrenOf(token), item);
    }
  };
  visit(marked.lexer(text), null);
  return captions;
}
