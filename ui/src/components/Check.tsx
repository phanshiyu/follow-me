import { type ReactNode, useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/** A checkbox with its visible label; name is what a screen reader hears. */
export function Check({
  checked,
  onChange,
  name,
  children,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  name: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <span
      className={cn("flex shrink-0 items-center gap-2 text-muted-foreground text-xs", className)}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(on) => onChange(on === true)}
        aria-label={name}
      />
      <label htmlFor={id} className="cursor-pointer">
        {children}
      </label>
    </span>
  );
}
