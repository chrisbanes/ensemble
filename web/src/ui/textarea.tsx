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
  // biome-ignore lint/correctness/useExhaustiveDependencies: a controlled value change must re-measure the content height.
  useLayoutEffect(() => {
    if (autoGrow && ref.current)
      fit(ref.current, minAutoGrowHeight, maxAutoGrowHeight);
  }, [autoGrow, maxAutoGrowHeight, minAutoGrowHeight, props.value]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!autoGrow || !element) return;
    let width = element.clientWidth;
    // Rewrapping at a new width changes the content height; height changes alone do not.
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit(element, minAutoGrowHeight, maxAutoGrowHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [autoGrow, maxAutoGrowHeight, minAutoGrowHeight]);
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

// Height changes never move the selection, so IME composition is left untouched.
function fit(element: HTMLTextAreaElement, min: number, max: number) {
  element.style.height = "auto";
  const border = element.offsetHeight - element.clientHeight,
    content = element.scrollHeight + border;
  element.style.height = `${Math.min(max, Math.max(min, content))}px`;
  element.style.overflowY = content > max ? "auto" : "hidden";
}

export { Textarea };
