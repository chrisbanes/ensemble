import { Link } from "react-router-dom";
import type { RunningSessionRow } from "@/generated/models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import StatusBadge from "./StatusBadge";
import { formatDuration, formatTokens } from "@/lib/formatters";

interface RunningTableProps {
  sessions: RunningSessionRow[];
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
