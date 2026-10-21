// Mermaid is a large bundle, so it loads the first time a diagram is on the page.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let count = 0;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    });
    return mermaid;
  });
  return loading;
}

/** The diagram as SVG markup, which mermaid sanitises under its strict security level. */
export async function renderDiagram(source: string): Promise<string> {
  const mermaid = await load();
  count += 1;
  const { svg } = await mermaid.render(`follow-me-diagram-${count}`, source);
  return svg;
}
