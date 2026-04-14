import { useMemo } from "react";
import KanbanColumn from "./KanbanColumn";
import type { RuntimeSnapshot } from "@/generated/models";
import type { RunningSessionRow, RetryRow, WaitingInteractionRow, CompletedRow } from "@/generated/models";

type IssueItem = RunningSessionRow | RetryRow | WaitingInteractionRow | CompletedRow;

interface KanbanBoardProps {
  data: RuntimeSnapshot;
}

interface Column {
  title: string;
  status: string;
  issues: IssueItem[];
}

export default function KanbanBoard({ data }: KanbanBoardProps) {
  const columns = useMemo((): Column[] => {
    const completed: CompletedRow[] = data.completed ?? [];
    return [
      { title: "Running", status: "running", issues: data.running },
      { title: "Retrying", status: "retrying", issues: data.retrying },
      { title: "Waiting on Human", status: "waiting_on_human", issues: data.waiting_on_human },
      { title: "Completed", status: "completed_succeeded", issues: completed },
    ];
  }, [data]);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((column) => (
        <KanbanColumn
          key={column.status}
          title={column.title}
          status={column.status}
          issues={column.issues}
        />
      ))}
    </div>
  );
}
