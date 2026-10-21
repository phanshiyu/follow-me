import Prism from "prismjs";
import { expect, test } from "vitest";
import { highlightBody, languageFor, spansByLine, toneOf } from "./highlight.ts";
import { prismFor } from "./prism.ts";

const PATHS: Record<string, string | null> = {
  "src/app.js": "javascript",
  "a/b.mjs": "javascript",
  "ui/View.JSX": "jsx",
  "src/a.ts": "typescript",
  "src/a.tsx": "tsx",
  "package.json": "json",
  "README.md": "markdown",
  "x.css": "css",
  "index.html": "markup",
  "run.sh": "bash",
  "x.py": "python",
  "main.go": "go",
  "lib.rs": "rust",
  "x.rb": "ruby",
  "A.java": "java",
  "A.kt": "kotlin",
  "x.c": "c",
  "x.cpp": "cpp",
  "ci.yml": "yaml",
  "Cargo.toml": "toml",
  "q.sql": "sql",
  "A.swift": "swift",
  "x.php": "php",
  Makefile: null,
  ".gitignore": null,
  "notes.txt": null,
  "dir.js/readme": null,
};

test("languageFor reads the extension, case-insensitively, and leaves the rest plain", () => {
  for (const [path, language] of Object.entries(PATHS))
    expect(languageFor(path), path).toBe(language);
});

test("every language languageFor names loads a working grammar", async () => {
  const languages = new Set(Object.values(PATHS).filter((l) => l !== null));
  for (const language of languages) {
    const prism = await prismFor(language);
    expect(prism?.languages[language], language).toBeDefined();
  }
  expect(await prismFor("cobol")).toBeNull();
});

test("toneOf takes the innermost known type and ignores punctuation", () => {
  expect(toneOf(["template-string", "string"])).toBe("string");
  expect(toneOf(["punctuation", "string"])).toBe("string");
  expect(toneOf(["punctuation"])).toBeNull();
});

test("spansByLine cuts multi-line tokens at each newline and merges equal neighbours", () => {
  const stream = [
    "let ",
    { type: "comment", content: "/* a\n b */" },
    " x",
    "\n",
    { type: "string", content: ["'", { type: "interpolation", content: "z" }, "'"] },
    { type: "foo", alias: ["keyword"], content: "if" },
  ];
  expect(spansByLine(stream)).toEqual([
    [
      { text: "let ", tone: null },
      { text: "/* a", tone: "comment" },
    ],
    [
      { text: " b */", tone: "comment" },
      { text: " x", tone: null },
    ],
    [
      { text: "'z'", tone: "string" },
      { text: "if", tone: "keyword" },
    ],
  ]);
});

test("highlightBody colours context from the new side and removals from the old", () => {
  const javascript = Prism.languages["javascript"];
  if (javascript === undefined) throw new Error("prismjs ships javascript");
  const body = [
    { op: " " as const, text: "/* note\n" },
    { op: " " as const, text: "   still note */\n" },
    { op: "-" as const, text: "const a = 1;\n" },
    { op: "+" as const, text: "const a = 'x';\n" },
  ];
  const lines = highlightBody(body, (text) => Prism.tokenize(text, javascript));
  expect(lines?.[1]).toEqual([{ text: "   still note */", tone: "comment" }]);
  expect(lines?.[2]?.find((s) => s.text === "1")?.tone).toBe("number");
  expect(lines?.[3]?.find((s) => s.text === "'x'")?.tone).toBe("string");
  expect(lines?.map((spans) => spans.map((s) => s.text).join(""))).toEqual(
    body.map((l) => l.text.replace(/\n$/, "")),
  );
});

test("highlightBody gives up when the tokens do not add up to the text", () => {
  expect(highlightBody([{ op: "+", text: "abc\n" }], () => ["xyz"])).toBeNull();
});
