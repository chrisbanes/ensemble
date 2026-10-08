import { Button } from "./components.js";
import type { RangePin } from "./task-workspace-state.js";

/**
 * Labelled 44px alternative to Shift+click: the first press fixes one edge at
 * the selected line, later selections extend from it, the other press ends it.
 */
export function RangeControls({
  line,
  anchor,
  pin,
  onSet,
}: {
  line: number | null;
  /** Line where the pinned edge was fixed. */
  anchor: number | null;
  pin: RangePin;
  onSet: (edge: "start" | "end") => void;
}) {
  return (
    <div
      className="task-actions range-controls"
      role="toolbar"
      aria-label="Selection range"
    >
      <Button
        variant="secondary"
        aria-pressed={pin === "start"}
        disabled={line === null}
        onClick={() => onSet("start")}
      >
        Set start
      </Button>
      <Button
        variant="secondary"
        aria-pressed={pin === "end"}
        disabled={line === null}
        onClick={() => onSet("end")}
      >
        Set end
      </Button>
      {/* Not a live region: the origin already announces the selected range. */}
      <span className="muted">
        {line === null
          ? "Select a line to set a range start or end."
          : pin
            ? anchor === null || anchor === line
              ? `Edge fixed at line ${anchor ?? line}. Select the other end, then press Set ${pin === "start" ? "end" : "start"}.`
              : `Edge fixed at line ${anchor}; range ${Math.min(anchor, line)}–${Math.max(anchor, line)}. Press Set start or Set end to finish.`
            : `Line ${line} selected. Set start or Set end to build a range.`}
      </span>
    </div>
  );
}
