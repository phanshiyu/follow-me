// Loads Prism and only the grammars a branch needs. Each grammar is a separate chunk, fetched the
// first time a file of that language shows up. A grammar that fails to load leaves the code plain.

type Prism = typeof import("prismjs");

/** Grammar chunks per language, dependencies first; Prism components extend the global Prism. */
const COMPONENTS: Record<string, readonly (() => Promise<unknown>)[]> = {
  javascript: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-javascript"),
  ],
  jsx: [
    () => import("prismjs/components/prism-markup"),
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-javascript"),
    () => import("prismjs/components/prism-jsx"),
  ],
  typescript: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-javascript"),
    () => import("prismjs/components/prism-typescript"),
  ],
  tsx: [
    () => import("prismjs/components/prism-markup"),
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-javascript"),
    () => import("prismjs/components/prism-jsx"),
    () => import("prismjs/components/prism-typescript"),
    () => import("prismjs/components/prism-tsx"),
  ],
  json: [() => import("prismjs/components/prism-json")],
  markdown: [
    () => import("prismjs/components/prism-markup"),
    () => import("prismjs/components/prism-markdown"),
  ],
  css: [() => import("prismjs/components/prism-css")],
  markup: [
    () => import("prismjs/components/prism-markup"),
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-javascript"),
    () => import("prismjs/components/prism-css"),
  ],
  bash: [() => import("prismjs/components/prism-bash")],
  python: [() => import("prismjs/components/prism-python")],
  go: [() => import("prismjs/components/prism-clike"), () => import("prismjs/components/prism-go")],
  rust: [() => import("prismjs/components/prism-rust")],
  ruby: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-ruby"),
  ],
  java: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-java"),
  ],
  kotlin: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-kotlin"),
  ],
  c: [() => import("prismjs/components/prism-clike"), () => import("prismjs/components/prism-c")],
  cpp: [
    () => import("prismjs/components/prism-clike"),
    () => import("prismjs/components/prism-c"),
    () => import("prismjs/components/prism-cpp"),
  ],
  yaml: [() => import("prismjs/components/prism-yaml")],
  toml: [() => import("prismjs/components/prism-toml")],
  sql: [() => import("prismjs/components/prism-sql")],
  swift: [() => import("prismjs/components/prism-swift")],
  php: [
    () => import("prismjs/components/prism-markup"),
    () => import("prismjs/components/prism-markup-templating"),
    () => import("prismjs/components/prism-php"),
  ],
};

let core: Promise<Prism> | null = null;
const loading = new Map<string, Promise<Prism | null>>();

function loadCore(): Promise<Prism> {
  core ??= import("prismjs/components/prism-core").then((m) => m.default);
  return core;
}

/** Prism with the grammar for a language, or null when it is unknown or failed to load. */
export function prismFor(language: string): Promise<Prism | null> {
  const parts = COMPONENTS[language];
  if (parts === undefined) return Promise.resolve(null);
  let pending = loading.get(language);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const prism = await loadCore();
        for (const part of parts) await part();
        return prism;
      } catch {
        return null;
      }
    })();
    loading.set(language, pending);
  }
  return pending;
}
