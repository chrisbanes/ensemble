import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

const alertVariants = cva(
  "relative grid w-full gap-y-1 rounded-lg border border-border bg-card p-4 text-sm text-card-foreground [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "",
        destructive: "border-destructive/60",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role="status"
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, alertVariants };
