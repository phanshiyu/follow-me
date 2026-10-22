import { Maximize2Icon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { renderDiagram } from "../lib/mermaid.ts";

/**
 * What makes a diagram's parts clickable. `decorate` runs on every copy of the SVG, inline and in
 * the lightbox, and marks parts with `data-pick`; `onPick` gets the part's value and the inline
 * element to hang a popover from.
 */
export type Picks = {
  readonly decorate: (root: HTMLElement) => void;
  readonly onPick: (value: string, near: Element) => void;
};

const FIT =
  "flex justify-center [&_svg]:h-auto [&_svg]:max-h-[360px] [&_svg]:max-w-full xl:[&_svg]:max-h-[480px]";

function picked(event: MouseEvent | KeyboardEvent): Element | null {
  if ("key" in event && event.key !== "Enter" && event.key !== " ") return null;
  return event.target instanceof Element ? event.target.closest("[data-pick]") : null;
}

/**
 * A Mermaid diagram at full content width, fitted to at most 480px tall (360px below 1280px).
 * Clicking opens it in a lightbox at 95vw by 90vh with Fit and Actual size. With `picks`, its
 * parts are buttons in both places, and Enlarge has its own button.
 */
export function Diagram({
  source,
  title,
  picks,
}: {
  source: string;
  title: string;
  picks?: Picks;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [actual, setActual] = useState(false);
  const inline = useRef<HTMLDivElement>(null);
  /** A pick in the lightbox closes it; focus must not go back and scroll the page to the diagram. */
  const leaving = useRef(false);
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
  const decorate = picks?.decorate;
  useLayoutEffect(() => {
    if (svg !== null && inline.current !== null) decorate?.(inline.current);
  }, [svg, decorate]);
  const lightbox = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null && svg !== null) decorate?.(node);
    },
    [svg, decorate],
  );
  const pickInline = (event: MouseEvent | KeyboardEvent) => {
    const part = picked(event);
    if (part === null) {
      if (event.type === "click") setOpen(true);
      return;
    }
    event.preventDefault();
    picks?.onPick(part.getAttribute("data-pick") ?? "", part);
  };
  const pickInLightbox = (event: MouseEvent | KeyboardEvent) => {
    const part = picked(event);
    if (part === null) return;
    event.preventDefault();
    const value = part.getAttribute("data-pick") ?? "";
    leaving.current = true;
    setOpen(false);
    requestAnimationFrame(() => {
      const near =
        inline.current?.querySelector(`[data-pick="${CSS.escape(value)}"]`) ?? inline.current;
      if (near !== null) picks?.onPick(value, near);
    });
  };

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
  const drawn =
    svg === null ? (
      <div className="h-24 animate-pulse rounded bg-muted" />
    ) : (
      <div
        ref={inline}
        className={FIT}
        // Mermaid renders under securityLevel "strict", which sanitises the SVG it returns.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: see above
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  return (
    <>
      {picks === undefined ? (
        <button
          type="button"
          aria-label={`Enlarge ${title}`}
          disabled={svg === null}
          onClick={() => setOpen(true)}
          className="block w-full cursor-zoom-in rounded-lg border bg-card p-3 transition-colors hover:border-ring"
        >
          {drawn}
        </button>
      ) : (
        // The parts are the buttons; a click between them enlarges, as a plain diagram does.
        // biome-ignore lint/a11y/noStaticElementInteractions: Enlarge is its own button too
        <div
          className="relative cursor-zoom-in rounded-lg border bg-card p-3"
          onClick={pickInline}
          onKeyDown={pickInline}
        >
          {drawn}
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-2 right-2"
            aria-label={`Enlarge ${title}`}
            disabled={svg === null}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
          >
            <Maximize2Icon />
          </Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex h-[90vh] w-[95vw] max-w-none flex-col sm:max-w-none"
          onCloseAutoFocus={(event) => {
            if (!leaving.current) return;
            leaving.current = false;
            event.preventDefault();
          }}
        >
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
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the parts inside are buttons */}
          <div
            ref={lightbox}
            onClick={picks === undefined ? undefined : pickInLightbox}
            onKeyDown={picks === undefined ? undefined : pickInLightbox}
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
