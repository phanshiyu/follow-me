import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { blocksOf, type RefNumber } from "../lib/markdown.ts";
import { Diagram } from "./Diagram.tsx";

/**
 * The agent's markdown: prose capped at 72ch, fenced mermaid drawn full width. With `numberOf`,
 * each code span that writes a ref is replaced by `chip(n)`.
 */
export function Markdown({
  text,
  title = "Diagram",
  numberOf,
  chip,
}: {
  text: string;
  title?: string;
  numberOf?: RefNumber;
  chip?: (n: number) => ReactNode;
}) {
  const blocks = useMemo(() => blocksOf(text, numberOf), [text, numberOf]);
  const root = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<readonly { at: HTMLElement; n: number }[]>([]);
  // The placeholders exist once the HTML is in the page; chips render into them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new blocks are new placeholders
  useLayoutEffect(() => {
    const found = [...(root.current?.querySelectorAll<HTMLElement>("[data-ref]") ?? [])];
    setSlots(found.map((at) => ({ at, n: Number(at.dataset["ref"]) })));
  }, [blocks]);
  return (
    <div ref={root} className="space-y-2">
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
      {chip === undefined ? null : slots.map(({ at, n }, i) => createPortal(chip(n), at, `${i}`))}
    </div>
  );
}
