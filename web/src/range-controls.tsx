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
      <span className="muted" role="status">
        {line === null
          ? "Select a line to set a range start or end."
          : pin
            ? `${pin === "start" ? "Start" : "End"} fixed at line ${anchor ?? line}. Select the ${pin === "start" ? "end" : "start"} line, then press Set ${pin === "start" ? "end" : "start"}.`
            : `Line ${line} selected. Set start or Set end to build a range.`}
      </span>
    </div>
  );
}
