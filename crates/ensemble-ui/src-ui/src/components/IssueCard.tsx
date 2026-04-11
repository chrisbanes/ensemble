import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTokens } from "@/lib/formatters";
import type { RunningSessionRow, RetryRow, WaitingInteractionRow } from "@/generated/models";

type IssueItem = RunningSessionRow | RetryRow | WaitingInteractionRow;

interface IssueCardProps {
  issue: IssueItem;
  status: string;
}

const statusColors: Record<string, string> = {
  running: "border-l-green-500",
  retrying: "border-l-yellow-500",
  waiting_on_human: "border-l-blue-500",
  finalize_pending_approval: "border-l-purple-500",
  finalize_in_progress: "border-l-purple-500",
  completed_succeeded: "border-l-gray-400",
  completed_failed: "border-l-red-400",
  completed_stopped: "border-l-gray-400",
};

export default function IssueCard({ issue, status }: IssueCardProps) {
  const colorClass = statusColors[status] ?? "border-l-gray-400";
  const isRunning = 'turn_count' in issue;
  
  return (
    <Card className={`border-l-4 ${colorClass} hover:shadow-md transition-shadow`}>
      <CardContent className="p-3 space-y-2">
        <Link 
          to={`/issue/${encodeURIComponent(issue.issue_identifier)}`}
          className="text-sm font-medium text-primary hover:underline block truncate"
        >
          {issue.issue_identifier}
        </Link>
        
        {isRunning && issue.step_name && (
          <Badge variant="outline" className="text-xs">
            {issue.step_name}
          </Badge>
        )}
        
        {isRunning && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatTokens(issue.tokens.total_tokens)} tokens</span>
            <span>{issue.turn_count} turns</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
