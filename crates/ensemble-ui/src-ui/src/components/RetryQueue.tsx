import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import type { RetryRow } from "@/generated/models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface RetryQueueProps {
  entries: RetryRow[];
  onRetry: (identifier: string) => void;
}

function formatCountdown(dueAtMs: number): string {
  const diff = Math.max(0, dueAtMs - Date.now());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export default function RetryQueue({ entries, onRetry }: RetryQueueProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (entries.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [entries.length]);

  if (entries.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">No issues in retry queue.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead>Attempt</TableHead>
          <TableHead>Retry In</TableHead>
          <TableHead>Error</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.issue_id}>
            <TableCell>
              <Link to={`/issue/${encodeURIComponent(e.issue_identifier)}`} className="text-primary hover:underline font-medium">
                {e.issue_identifier}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{e.attempt}</TableCell>
            <TableCell className="text-muted-foreground">{formatCountdown(e.due_at_ms)}</TableCell>
            <TableCell className="text-muted-foreground max-w-xs truncate">{e.error ?? "\u2014"}</TableCell>
            <TableCell>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onRetry(e.issue_identifier)}>
                Retry Now
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
