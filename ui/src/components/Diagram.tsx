import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { renderDiagram } from "../lib/mermaid.ts";

/**
 * A Mermaid diagram at full content width, fitted to at most 480px tall (360px below 1280px).
 * Clicking opens it in a lightbox at 95vw by 90vh with Fit and Actual size.
 */
export function Diagram({ source, title }: { source: string; title: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [actual, setActual] = useState(false);
  useEffect(() => {
    let live = true;
    renderDiagram(source)
      .then((drawn) => live && setSvg(drawn))
      .catch(
        (error: unknown) =>
          live && setFailure(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      live = false;
    };
  }, [source]);
  if (failure !== null) {
    return (
      <figure className="rounded-lg border border-dashed p-3 text-sm">
        <figcaption className="mb-1 text-muted-foreground text-xs">
          The diagram did not render: {failure}
        </figcaption>
        <pre className="overflow-x-auto font-mono text-xs">{source}</pre>
      </figure>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-label={`Enlarge ${title}`}
        disabled={svg === null}
        onClick={() => setOpen(true)}
        className="block w-full cursor-zoom-in rounded-lg border bg-card p-3 transition-colors hover:border-ring"
      >
        {svg === null ? (
          <div className="h-24 animate-pulse rounded bg-muted" />
        ) : (
          <div
            className="flex justify-center [&_svg]:h-auto [&_svg]:max-h-[360px] [&_svg]:max-w-full xl:[&_svg]:max-h-[480px]"
            // Mermaid renders under securityLevel "strict", which sanitises the SVG it returns.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: see above
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-none flex-col sm:max-w-none">
          <div className="flex items-center gap-2 pr-10">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <div className="ml-auto flex gap-1">
              <Button
                size="xs"
                variant={actual ? "ghost" : "secondary"}
                onClick={() => setActual(false)}
              >
                Fit
              </Button>
              <Button
                size="xs"
                variant={actual ? "secondary" : "ghost"}
                onClick={() => setActual(true)}
              >
                Actual size
              </Button>
            </div>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto rounded-md bg-background",
              actual
                ? "[&_svg]:max-w-none!"
                : "flex items-center justify-center [&_svg]:h-full! [&_svg]:max-h-full [&_svg]:w-full [&_svg]:max-w-full!",
            )}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the same sanitised SVG as above.
            dangerouslySetInnerHTML={{ __html: svg ?? "" }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
