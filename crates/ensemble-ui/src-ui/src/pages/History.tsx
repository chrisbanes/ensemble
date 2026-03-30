import { useState } from "react";
import { Link } from "react-router-dom";
import { useHistoryQuery } from "@/hooks";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import StatusBadge from "@/components/StatusBadge";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function History() {
  const [outcome, setOutcome] = useState("");
  const [step, setStep] = useState("");
  const [cursor, setCursor] = useState<number | undefined>();

  const { data, isLoading, isError } = useHistoryQuery({
    outcome: outcome || undefined,
    step: step || undefined,
    cursor,
    limit: 20,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">History</h1>

      <div className="flex flex-wrap gap-3">
        <Select
          value={outcome || "all"}
          onValueChange={(v) => { setOutcome(v === "all" ? "" : (v ?? "")); setCursor(undefined); }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All outcomes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="succeeded">Succeeded</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter by step..."
          value={step}
          onChange={(e) => { setStep(e.target.value); setCursor(undefined); }}
          className="w-40"
        />
      </div>

      {isLoading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {isError && <div className="text-center py-8 text-destructive">Failed to load history.</div>}

      {data && (
        <>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Issue</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.records.map((r) => (
                  <TableRow key={`${r.issue_id}-${r.completed_at}`}>
                    <TableCell>
                      <Link to={`/issue/${encodeURIComponent(r.issue_identifier)}`} className="text-primary hover:underline font-medium">
                        {r.issue_identifier}
                      </Link>
                    </TableCell>
                    <TableCell><StatusBadge status={r.outcome} /></TableCell>
                    <TableCell className="text-muted-foreground">{r.steps_traversed.join(" \u2192 ")}</TableCell>
                    <TableCell className="text-muted-foreground">{r.attempts}</TableCell>
                    <TableCell className="text-muted-foreground">{formatTokens(r.tokens.total_tokens)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDuration(r.duration_seconds)}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(r.completed_at).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {data.records.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">No records match the current filters.</div>
          )}
          {data.next_cursor != null && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setCursor(data.next_cursor!)}>
                Load More
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
