import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  componentsFor,
  componentsForAll,
  highlightBody,
  languageFor,
  spansByLine,
  toneOf,
} from "../ui/highlight.js";

const require = createRequire(import.meta.url);

test("languageFor reads the extension, case-insensitively, and leaves the rest plain", () => {
  const expected: Record<string, string | null> = {
    "src/app.js": "javascript",
    "a/b.mjs": "javascript",
    "a/b.cjs": "javascript",
    "ui/View.JSX": "jsx",
    "src/a.ts": "typescript",
    "src/a.tsx": "tsx",
    "package.json": "json",
    "README.md": "markdown",
    "x.css": "css",
    "index.html": "markup",
    "run.sh": "bash",
    "run.bash": "bash",
    "x.py": "python",
    "main.go": "go",
    "lib.rs": "rust",
    "x.rb": "ruby",
    "A.java": "java",
    "A.kt": "kotlin",
    "x.c": "c",
    "x.cpp": "cpp",
    "x.h": "c",
    "ci.yaml": "yaml",
    "ci.yml": "yaml",
    "Cargo.toml": "toml",
    "q.sql": "sql",
    "A.swift": "swift",
    "x.php": "php",
    Makefile: null,
    ".gitignore": null,
    "notes.txt": null,
    "archive.tar.gz": null,
    "dir.js/readme": null,
    "": null,
  };
  for (const [path, language] of Object.entries(expected)) {
    assert.equal(languageFor(path), language, path);
  }
});

test("componentsFor lists dependencies before the language, as Prism declares them", () => {
  const catalog = JSON.parse(
    readFileSync(require.resolve("prismjs/components.json"), "utf8"),
  ).languages;
  const languages = new Set<string>();
  for (const path of ["a.js", "a.jsx", "a.ts", "a.tsx", "a.json", "a.md", "a.css", "a.html"]) {
    languages.add(languageFor(path) ?? "");
  }
  for (const path of ["a.sh", "a.py", "a.go", "a.rs", "a.rb", "A.java", "A.kt", "a.c", "a.cpp"]) {
    languages.add(languageFor(path) ?? "");
  }
  for (const path of ["a.yml", "a.toml", "a.sql", "a.swift", "a.php"]) {
    languages.add(languageFor(path) ?? "");
  }
  for (const language of languages) {
    const parts = componentsFor(language);
    assert.ok(parts.includes(language), language);
    parts.forEach((name, at) => {
      const needs: string[] = [catalog[name].require ?? []].flat();
      for (const need of needs) {
        assert.ok(parts.indexOf(need) !== -1 && parts.indexOf(need) < at, `${need} before ${name}`);
      }
    });
  }
  assert.deepEqual(componentsFor("cobol"), []);
});

test("componentsForAll loads each component once", () => {
  assert.deepEqual(componentsForAll(["typescript", "tsx"]), [
    "clike",
    "javascript",
    "typescript",
    "markup",
    "jsx",
    "tsx",
  ]);
  assert.deepEqual(componentsForAll([]), []);
});

test("toneOf takes the innermost known type and ignores punctuation", () => {
  assert.equal(toneOf(["keyword"]), "keyword");
  assert.equal(toneOf(["template-string", "string"]), "string");
  assert.equal(toneOf(["punctuation", "string"]), "string");
  assert.equal(toneOf(["punctuation"]), null);
  assert.equal(toneOf([]), null);
});

test("spansByLine cuts multi-line tokens at each newline and merges equal neighbours", () => {
  const stream = [
    "let ",
    { type: "comment", content: "/* a\n b */" },
    " x",
    "\n",
    { type: "string", content: ["'", { type: "interpolation", content: "z" }, "'"] },
  ];
  assert.deepEqual(spansByLine(stream), [
    [
      { text: "let ", tone: null },
      { text: "/* a", tone: "comment" },
    ],
    [
      { text: " b */", tone: "comment" },
      { text: " x", tone: null },
    ],
    [{ text: "'z'", tone: "string" }],
  ]);
});

test("spansByLine reads aliases", () => {
  const stream = [{ type: "foo", alias: ["keyword"], content: "if" }];
  assert.deepEqual(spansByLine(stream), [[{ text: "if", tone: "keyword" }]]);
});

test("highlightBody gives context the new side's colours and removed lines their own", () => {
  const Prism = require("prismjs");
  const tokenize = (text: string) => Prism.tokenize(text, Prism.languages.javascript);
  const body = [
    { op: " " as const, text: "/* note\n" },
    { op: " " as const, text: "   still note */\n" },
    { op: "-" as const, text: "const a = 1;\n" },
    { op: "+" as const, text: "const a = 'x';\n" },
  ];
  const lines = highlightBody(body, tokenize);
  assert.ok(lines);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[1], [{ text: "   still note */", tone: "comment" }]);
  assert.equal(lines[2]?.find((s) => s.text === "1")?.tone, "number");
  assert.equal(lines[3]?.find((s) => s.text === "'x'")?.tone, "string");
  for (const [i, line] of body.entries()) {
    assert.equal(lines[i]?.map((s) => s.text).join(""), line.text.replace(/\n$/, ""));
  }
});

test("highlightBody copes with a side that has no lines", () => {
  const tokenize = (text: string) => [text];
  const lines = highlightBody([{ op: "+", text: "one\n" }], tokenize);
  assert.deepEqual(lines, [[{ text: "one", tone: null }]]);
});

test("highlightBody gives up when the tokens do not add up to the text", () => {
  const lossy = (text: string) => [text.slice(1)];
  assert.equal(highlightBody([{ op: "+", text: "abc\n" }], lossy), null);
});
