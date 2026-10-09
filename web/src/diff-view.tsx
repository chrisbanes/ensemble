import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
import { Button } from "./components.js";
import type { TaskChangeSelection } from "./task-workspace-state.js";

type Snapshot = Extract<
  WorkspaceComparisonRead["data"],
  { state: "available" }
>["comparison"];
export type Hunk = Snapshot["entries"][number]["hunks"][number];
export type Anchor = NonNullable<Hunk["leftAnchor"]>;
/** A hunk without anchors renders as read-only Before/After. */
export type DiffHunkData = Pick<
  Hunk,
  "oldStart" | "oldLines" | "newStart" | "newLines" | "patch"
> &
  Partial<Pick<Hunk, "leftAnchor" | "rightAnchor">>;

type Side = "left" | "right";
type Layout = "split" | "unified";
type PatchLine = {
  kind: "context" | "deleted" | "added" | "note";
  oldLine?: number;
  newLine?: number;
  text: string;
};
type PairedLine = { oldLine?: PatchLine; newLine?: PatchLine };
type Slot = {
  panel: Side | "unified";
  row: number;
  side: Side;
  line: PatchLine | undefined;
};

/** Lines in patch order, each carrying its own old and new line number. */
function patchLines(hunk: DiffHunkData): PatchLine[] {
  const result: PatchLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const source of hunk.patch.split("\n")) {
    if (source.startsWith("@@") || source.startsWith("\\ No newline")) continue;
    const marker = source[0];
    const text = source.slice(1);
    if (marker === " ") {
      result.push({ kind: "context", oldLine, newLine, text });
      oldLine++;
      newLine++;
    } else if (marker === "-") {
      result.push({ kind: "deleted", oldLine, text });
      oldLine++;
    } else if (marker === "+") {
      result.push({ kind: "added", newLine, text });
      newLine++;
    } else if (source) result.push({ kind: "note", text: source });
  }
  return result;
}

/** Aligns each run of deletions with the additions that replace it. */
function pairLines(lines: PatchLine[]): PairedLine[] {
  const result: PairedLine[] = [];
  let removed: PatchLine[] = [];
  let added: PatchLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++)
      result.push({
        ...(removed[index] ? { oldLine: removed[index] } : {}),
        ...(added[index] ? { newLine: added[index] } : {}),
      });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "deleted") removed.push(line);
    else if (line.kind === "added") added.push(line);
    else {
      flush();
      result.push(
        line.kind === "context"
          ? { oldLine: line, newLine: line }
          : { oldLine: line },
      );
    }
  }
  flush();
  return result;
}

const narrowQuery = "(max-width: 700px)";

/** Phones show the unified diff only; mirrors the stylesheet breakpoint. */
function useNarrowViewport() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(narrowQuery).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function DiffLayoutControls({
  layout,
  onChange,
}: {
  layout: Layout;
  onChange: (layout: Layout) => void;
}) {
  return (
    <div
      className="task-actions changes-layout-controls"
      role="toolbar"
      aria-label="Diff layout"
    >
      {(["split", "unified"] as const).map((value) => (
        <Button
          key={value}
          variant={layout === value ? "primary" : "secondary"}
          aria-pressed={layout === value}
          onClick={() => onChange(value)}
        >
          {value === "split" ? "Split" : "Unified"}
        </Button>
      ))}
    </div>
  );
}

export type DiffSelect = {
  comparisonId: string;
  selection: TaskChangeSelection | null;
  /** `data-review-return` target for the composer's focus return. */
  originKey: string;
  onSelect: (
    anchor: Anchor,
    line: number,
    minLine: number,
    maxLine: number,
    extend: boolean,
  ) => void;
};

export function DiffHunk({
  hunk,
  hunkIndex,
  layout,
  select,
}: {
  hunk: DiffHunkData;
  hunkIndex: number;
  layout: Layout;
  /** Omitted when the diff is read-only. */
  select?: DiffSelect;
}) {
  const lines = useMemo(() => patchLines(hunk), [hunk]);
  const effective: Layout = useNarrowViewport() ? "unified" : layout;
  const root = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState<Record<string, string>>({});
  const selection = select?.selection;

  const slots: Slot[] =
    effective === "split"
      ? pairLines(lines).flatMap((pair, row) => [
          { panel: "left", row, side: "left", line: pair.oldLine },
          { panel: "right", row, side: "right", line: pair.newLine },
        ])
      : lines.map((line, row) => ({
          panel: "unified",
          row,
          side: line.kind === "deleted" ? "left" : "right",
          line,
        }));

  const describe = (slot: Slot) => {
    const { line, side } = slot;
    const anchor = side === "left" ? hunk.leftAnchor : hunk.rightAnchor;
    const number = line && (side === "left" ? line.oldLine : line.newLine);
    const minLine = side === "left" ? hunk.oldStart : hunk.newStart;
    const maxLine =
      minLine + (side === "left" ? hunk.oldLines : hunk.newLines) - 1;
    const active =
      select?.selection &&
      select.selection.comparisonId === select.comparisonId &&
      select.selection.side === side &&
      select.selection.path === anchor?.path &&
      select.selection.contentSha256 === anchor?.contentSha256
        ? select.selection
        : null;
    return {
      anchor,
      number,
      minLine,
      maxLine,
      selectable:
        Boolean(select && anchor) &&
        number !== undefined &&
        (line?.kind === "context" ||
          (side === "left" && line?.kind === "deleted") ||
          (side === "right" && line?.kind === "added")),
      selected:
        active !== null &&
        number !== undefined &&
        active.startLine <= number &&
        number <= active.endLine,
      current: active !== null && active.currentLine === number,
    };
  };

  // One tab stop per panel: the focused line, else the current selection, else the first line.
  const panelCells = (panel: Slot["panel"]) =>
    slots
      .filter((slot) => slot.panel === panel)
      .map((slot) => ({ slot, cell: describe(slot) }))
      .filter(({ cell }) => cell.selectable);
  const cellKey = (slot: Slot, number: number | undefined) =>
    `${slot.side}:${number}`;
  const stops = new Map<string, string>();
  for (const panel of ["left", "right", "unified"] as const) {
    const cells = panelCells(panel);
    const stop =
      cells.find(
        ({ slot, cell }) => cellKey(slot, cell.number) === focused[panel],
      ) ??
      cells.find(({ cell }) => cell.current) ??
      cells[0];
    if (stop) stops.set(panel, cellKey(stop.slot, stop.cell.number));
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    slot: Slot,
    cell: ReturnType<typeof describe>,
  ) => {
    if (!select || !cell.anchor || cell.number === undefined) return;
    const focusCell = (target: Slot) =>
      root.current
        ?.querySelector<HTMLButtonElement>(
          `button[data-panel="${target.panel}"][data-row="${target.row}"][data-side="${target.side}"]`,
        )
        ?.focus();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const target = slots.find(
        (item) =>
          item.row === slot.row &&
          item.panel !== slot.panel &&
          item.side === (event.key === "ArrowLeft" ? "left" : "right"),
      );
      if (target && describe(target).selectable) {
        event.preventDefault();
        focusCell(target);
      }
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const peers = panelCells(slot.panel);
    const next =
      peers[
        peers.findIndex((item) => item.slot === slot) +
          (event.key === "ArrowDown" ? 1 : -1)
      ];
    if (!next?.cell.anchor || next.cell.number === undefined) return;
    event.preventDefault();
    focusCell(next.slot);
    // Shift extends from the focused line even when it was not yet selected.
    if (event.shiftKey)
      select.onSelect(
        cell.anchor,
        cell.number,
        cell.minLine,
        cell.maxLine,
        true,
      );
    select.onSelect(
      next.cell.anchor,
      next.cell.number,
      next.cell.minLine,
      next.cell.maxLine,
      event.shiftKey,
    );
  };

  const renderSlot = (slot: Slot) => {
    const { line } = slot;
    const key = `${slot.panel}:${slot.row}`;
    if (!line)
      return (
        <div key={key} className="changes-line changes-line-empty">
          <span aria-hidden="true"> </span>
        </div>
      );
    const cell = describe(slot);
    const unified = slot.panel === "unified";
    const marker =
      line.kind === "deleted" ? "-" : line.kind === "added" ? "+" : " ";
    const numbers = unified ? (
      <>
        <span className="changes-line-number changes-line-old">
          {line.oldLine ?? ""}
        </span>
        <span className="changes-line-number changes-line-new">
          {line.newLine ?? ""}
        </span>
        <span className="changes-line-marker" aria-hidden="true">
          {marker}
        </span>
      </>
    ) : (
      <span className="changes-line-number">{cell.number ?? ""}</span>
    );
    const className = `changes-line${unified ? " changes-line-unified" : ""}`;
    if (select && cell.selectable && cell.anchor && cell.number !== undefined) {
      const { anchor, number } = cell;
      const label = slot.side === "left" ? "Before" : "After";
      return (
        <button
          type="button"
          key={key}
          className={`${className} changes-line-${line.kind} changes-selectable-line ${cell.selected ? "is-selected" : ""}`}
          aria-pressed={cell.selected}
          aria-current={cell.current ? "true" : undefined}
          aria-label={`${label} line ${number}, ${anchor.path}; hunk lines ${cell.minLine}–${cell.maxLine}`}
          tabIndex={stops.get(slot.panel) === cellKey(slot, number) ? 0 : -1}
          data-review-return={cell.current ? select.originKey : undefined}
          data-row={slot.row}
          data-side={slot.side}
          data-panel={slot.panel}
          data-line={number}
          onFocus={() =>
            setFocused((previous) => ({
              ...previous,
              [slot.panel]: cellKey(slot, number),
            }))
          }
          onKeyDown={(event) => handleKeyDown(event, slot, cell)}
          onClick={(event) =>
            select.onSelect(
              anchor,
              number,
              cell.minLine,
              cell.maxLine,
              event.shiftKey,
            )
          }
        >
          {numbers}
          <code>{line.text}</code>
        </button>
      );
    }
    return (
      <div key={key} className={`${className} changes-line-${line.kind}`}>
        {numbers}
        <code>{line.text || " "}</code>
      </div>
    );
  };

  return (
    <section
      ref={root}
      className="changes-hunk"
      aria-label={`Diff hunk ${hunkIndex + 1}`}
    >
      <h6 className="changes-hunk-heading">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </h6>
      {effective === "split" ? (
        <div className="changes-diff-split is-active">
          {(["left", "right"] as const).map((side) => (
            <div className="changes-diff-side" key={side}>
              <h6>{side === "left" ? "Before" : "After"}</h6>
              {slots.filter((slot) => slot.panel === side).map(renderSlot)}
            </div>
          ))}
        </div>
      ) : (
        <div className="changes-diff-unified is-active">
          <p className="changes-unified-head" aria-hidden="true">
            <span>Old</span>
            <span>New</span>
          </p>
          {slots.map(renderSlot)}
        </div>
      )}
    </section>
  );
}
