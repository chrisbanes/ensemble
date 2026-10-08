import type * as React from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils.js";

type TextareaProps = React.ComponentProps<"textarea"> & {
  autoGrow?: boolean;
  minAutoGrowHeight?: number;
  maxAutoGrowHeight?: number;
};

function Textarea({
  autoGrow = false,
  minAutoGrowHeight = 96,
  maxAutoGrowHeight = 320,
  className,
  ...props
}: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!autoGrow || !element) return;
    let width = element.clientWidth;
    const measure = () => {
      const start = element.selectionStart,
        end = element.selectionEnd,
        direction = element.selectionDirection;
      element.style.height = "auto";
      const contentHeight = element.scrollHeight;
      element.style.height = `${Math.min(
        maxAutoGrowHeight,
        Math.max(minAutoGrowHeight, contentHeight),
      )}px`;
      element.style.overflowY =
        contentHeight > maxAutoGrowHeight ? "auto" : "hidden";
      if (document.activeElement === element)
        element.setSelectionRange(start, end, direction);
      width = element.clientWidth;
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [autoGrow, maxAutoGrowHeight, minAutoGrowHeight, props.value]);
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      data-auto-grow={autoGrow ? "true" : undefined}
      className={cn(
        "flex min-h-24 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
