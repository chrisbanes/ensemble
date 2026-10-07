import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils.js";

function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        data-slot="native-select"
        className={cn(
          "flex h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-xs aria-invalid:border-destructive aria-invalid:ring-destructive/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 size-4 text-muted-foreground"
      />
    </span>
  );
}

export { NativeSelect };
