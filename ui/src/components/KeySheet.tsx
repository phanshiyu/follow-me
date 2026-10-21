import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const KEYS: readonly (readonly [string, string])[] = [
  ["j or c", "Next commit"],
  ["k or x", "Previous commit"],
  ["n", "Next unviewed commit"],
  ["v", "Toggle Viewed on the commit at the top"],
  ["s", "Open the stack"],
  ["↑ ↓", "Move between rows of a hunk"],
  ["Shift+↑ ↓", "Extend the picked rows"],
  ["Space", "Pick or unpick a row"],
  ["f", "Flag the picked rows"],
  ["a", "Ask about the picked rows"],
  ["Escape", "Clear the pick or close a box"],
  ["u", "Next unresolved thread"],
  ["⌘ Enter", "Save the box"],
  ["⌘ Shift Enter", "Submit review"],
  ["?", "This sheet"],
];

export function KeySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {KEYS.map(([key, what]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="rounded border bg-muted px-1.5 py-px font-mono text-xs">{key}</kbd>
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
