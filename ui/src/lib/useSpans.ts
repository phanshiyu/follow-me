import { useEffect, useState } from "react";
import { highlightBody, languageFor, type Span } from "./highlight.ts";
import { prismFor } from "./prism.ts";
import type { HunkLine, TextHunk } from "./wire.ts";

type BodyLine = Pick<HunkLine, "op" | "text">;

/** Coloured spans per line of a file's code once its grammar has loaded; null keeps it plain. */
export function useCodeSpans(path: string, body: readonly BodyLine[]): Span[][] | null {
  const [spans, setSpans] = useState<Span[][] | null>(null);
  useEffect(() => {
    const language = languageFor(path);
    if (language === null) return;
    let live = true;
    void prismFor(language).then((prism) => {
      const grammar = prism?.languages[language];
      if (!live || prism === null || grammar === undefined) return;
      setSpans(highlightBody(body, (text) => prism.tokenize(text, grammar)));
    });
    return () => {
      live = false;
    };
  }, [path, body]);
  return spans;
}

/** Coloured spans per row of a hunk once its grammar has loaded; null keeps the rows plain. */
export function useSpans(hunk: TextHunk): Span[][] | null {
  return useCodeSpans(hunk.path, hunk.body);
}
