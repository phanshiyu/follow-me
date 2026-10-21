import { useMemo } from "react";
import { blocksOf } from "../lib/markdown.ts";
import { Diagram } from "./Diagram.tsx";

/** The agent's markdown: prose capped at 72ch, fenced mermaid drawn full width. */
export function Markdown({ text, title = "Diagram" }: { text: string; title?: string }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) =>
        block.kind === "mermaid" ? (
          // Blocks are derived from the text and have no identity beyond their order.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Diagram key={i} source={block.source} title={title} />
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={i}
            className="prose-fm max-w-[72ch]"
            // DOMPurify sanitised this HTML in blocksOf, with images and raw HTML already escaped.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: see above
            dangerouslySetInnerHTML={{ __html: block.html }}
          />
        ),
      )}
    </div>
  );
}
