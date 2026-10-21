// The agent writes markdown. It renders as sanitised HTML, with fenced mermaid blocks split out so
// the page draws them as diagrams. Images and raw HTML never render; they show as their text.

import DOMPurify from "dompurify";
import { Marked, type Token, type TokensList } from "marked";

export type Block =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "mermaid"; readonly source: string };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
  },
});

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
];

function render(tokens: Token[], links: TokensList["links"]): string {
  const list: TokensList = Object.assign([...tokens], { links });
  const html = marked.parser(list);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "align"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  });
}

export function blocksOf(text: string): Block[] {
  const tokens = marked.lexer(text);
  const blocks: Block[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length > 0) blocks.push({ kind: "html", html: render(run, tokens.links) });
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
