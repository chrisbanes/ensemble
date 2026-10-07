import type * as React from "react";
import { cn } from "../lib/utils.js";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card py-4 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Card };
