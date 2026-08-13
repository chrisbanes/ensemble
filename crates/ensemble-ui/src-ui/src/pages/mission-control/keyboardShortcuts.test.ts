import { describe, expect, it } from "vitest";

import {
  keyboardShortcuts,
  isEditableTarget,
  isShortcutAvailable,
  matchesShortcut,
  shortcutAvailabilityLabel,
} from "./keyboardShortcuts";

describe("Mission Control keyboard shortcuts", () => {
  it("defines the approved shortcuts in their rendered order", () => {
    expect(keyboardShortcuts.map((shortcut) => [shortcut.id, shortcut.keys])).toEqual([
      ["focus-search", "/"],
      ["next-issue", "J"],
      ["previous-issue", "K"],
      ["close-panel", "Esc"],
      ["focus-reply", "R"],
      ["board", "B"],
      ["list", "L"],
      ["toggle-attention", "A"],
      ["refresh", "Shift + R"],
      ["show-shortcuts", "?"],
    ]);
    expect(shortcutAvailabilityLabel(keyboardShortcuts.find((shortcut) => shortcut.id === "focus-reply")!)).toBe(
      "Reply field required",
    );
  });

  it("matches only the exact unmodified key binding", () => {
    const refresh = keyboardShortcuts.find((shortcut) => shortcut.id === "refresh")!;
    const search = keyboardShortcuts.find((shortcut) => shortcut.id === "focus-search")!;

    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "R", shiftKey: true }), refresh)).toBe(true);
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "r" }), refresh)).toBe(false);
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "/" }), search)).toBe(true);
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "/", ctrlKey: true }), search)).toBe(false);
  });

  it("suppresses global shortcuts from every editable surface", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const nonEditable = document.createElement("div");
    nonEditable.setAttribute("contenteditable", "false");
    const child = document.createElement("span");
    editable.append(child);
    document.body.append(input, textarea, select, editable, nonEditable);

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
    expect(isEditableTarget(nonEditable)).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);

    editable.remove();
    input.remove();
    textarea.remove();
    select.remove();
    nonEditable.remove();
  });

  it("advertises selected-panel and rendered-reply availability", () => {
    const closePanel = keyboardShortcuts.find((shortcut) => shortcut.id === "close-panel")!;
    const focusReply = keyboardShortcuts.find((shortcut) => shortcut.id === "focus-reply")!;

    expect(isShortcutAvailable(closePanel, { hasSelectedIssue: false, hasReplySurface: false })).toBe(false);
    expect(isShortcutAvailable(closePanel, { hasSelectedIssue: true, hasReplySurface: false })).toBe(true);
    expect(isShortcutAvailable(focusReply, { hasSelectedIssue: true, hasReplySurface: false })).toBe(false);
    expect(isShortcutAvailable(focusReply, { hasSelectedIssue: true, hasReplySurface: true })).toBe(true);
  });
});
