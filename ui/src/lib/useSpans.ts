import { useEffect, useState } from "react";
import { highlightBody, languageFor, type Span } from "./highlight.ts";
import { prismFor } from "./prism.ts";
import type { TextHunk } from "./wire.ts";

/** Coloured spans per row of a hunk once its grammar has loaded; null keeps the rows plain. */
export function useSpans(hunk: TextHunk): Span[][] | null {
  const [spans, setSpans] = useState<Span[][] | null>(null);
  useEffect(() => {
    const language = languageFor(hunk.path);
    if (language === null) return;
    let live = true;
    void prismFor(language).then((prism) => {
      const grammar = prism?.languages[language];
      if (!live || prism === null || grammar === undefined) return;
      setSpans(highlightBody(hunk.body, (text) => prism.tokenize(text, grammar)));
    });
    return () => {
      live = false;
    };
  }, [hunk]);
  return spans;
}
