export type KeyboardShortcutId =
  | "focus-search"
  | "next-issue"
  | "previous-issue"
  | "close-panel"
  | "focus-reply"
  | "board"
  | "list"
  | "toggle-attention"
  | "refresh"
  | "show-shortcuts";

type ShortcutAvailability = "always" | "selected-issue" | "reply-surface";

export interface KeyboardShortcut {
  id: KeyboardShortcutId;
  key: string;
  keys: string;
  description: string;
  availability: ShortcutAvailability;
  requiresShift?: boolean;
}

export interface ShortcutAvailabilityContext {
  hasSelectedIssue: boolean;
  hasReplySurface: boolean;
}

export const keyboardShortcuts: KeyboardShortcut[] = [
  {
    id: "focus-search",
    key: "/",
    keys: "/",
    description: "Focus issue search",
    availability: "always",
  },
  {
    id: "next-issue",
    key: "j",
    keys: "J",
    description: "Select next issue",
    availability: "always",
  },
  {
    id: "previous-issue",
    key: "k",
    keys: "K",
    description: "Select previous issue",
    availability: "always",
  },
  {
    id: "close-panel",
    key: "Escape",
    keys: "Esc",
    description: "Close selected issue",
    availability: "selected-issue",
  },
  {
    id: "focus-reply",
    key: "r",
    keys: "R",
    description: "Focus reply",
    availability: "reply-surface",
  },
  {
    id: "board",
    key: "b",
    keys: "B",
    description: "Show board",
    availability: "always",
  },
  {
    id: "list",
    key: "l",
    keys: "L",
    description: "Show list",
    availability: "always",
  },
  {
    id: "toggle-attention",
    key: "a",
    keys: "A",
    description: "Toggle Attention only",
    availability: "always",
  },
  {
    id: "refresh",
    key: "R",
    keys: "Shift + R",
    description: "Refresh Mission Control",
    availability: "always",
    requiresShift: true,
  },
  {
    id: "show-shortcuts",
    key: "?",
    keys: "?",
    description: "Show keyboard shortcuts",
    availability: "always",
    requiresShift: true,
  },
];

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (Boolean(shortcut.requiresShift) !== event.shiftKey) return false;

  return event.key === shortcut.key;
}

export function isShortcutAvailable(
  shortcut: KeyboardShortcut,
  { hasSelectedIssue, hasReplySurface }: ShortcutAvailabilityContext,
): boolean {
  switch (shortcut.availability) {
    case "always":
      return true;
    case "selected-issue":
      return hasSelectedIssue;
    case "reply-surface":
      return hasReplySurface;
  }
}

export function shortcutAvailabilityLabel(shortcut: KeyboardShortcut): string {
  switch (shortcut.availability) {
    case "always":
      return "Always available";
    case "selected-issue":
      return "Selected issue required";
    case "reply-surface":
      return "Reply field required";
  }
}
