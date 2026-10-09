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
          "flex h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-(--nova-input-bg) px-2.5 py-1 pr-8 text-sm aria-invalid:border-destructive aria-invalid:ring-destructive/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground"
      />
    </span>
  );
}

export { NativeSelect };
