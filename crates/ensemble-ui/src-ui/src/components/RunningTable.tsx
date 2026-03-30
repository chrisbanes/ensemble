import { Link } from "react-router-dom";
import type { RunningSessionRow } from "@/generated/models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import StatusBadge from "./StatusBadge";

interface RunningTableProps {
  sessions: RunningSessionRow[];
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function RunningTable({ sessions }: RunningTableProps) {
  if (sessions.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">No agents currently running.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Turns</TableHead>
          <TableHead>Last Event</TableHead>
          <TableHead>Tokens</TableHead>
          <TableHead>Runtime</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((s) => (
          <TableRow key={s.issue_id}>
            <TableCell>
              <Link to={`/issue/${encodeURIComponent(s.issue_identifier)}`} className="text-primary hover:underline font-medium">
                {s.issue_identifier}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{s.step_name ?? "\u2014"}</TableCell>
            <TableCell className="text-muted-foreground">{s.turn_count}</TableCell>
            <TableCell className="text-muted-foreground max-w-xs truncate">{s.last_event ?? "\u2014"}</TableCell>
            <TableCell className="text-muted-foreground">{formatTokens(s.tokens.total_tokens)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDuration(s.started_at)}</TableCell>
            <TableCell><StatusBadge status={s.state} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
