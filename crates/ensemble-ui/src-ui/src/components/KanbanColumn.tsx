import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import IssueCard from "./IssueCard";
import type { RunningSessionRow, RetryRow, WaitingInteractionRow } from "@/generated/models";

// Base interface for all issue items
interface BaseIssueItem {
  issue_id: string;
  issue_identifier: string;
}

interface CompletedIssueItem extends BaseIssueItem {
  status: string;
  completed_at: string;
}

type IssueItem = RunningSessionRow | RetryRow | WaitingInteractionRow | CompletedIssueItem;

function isCompletedIssue(issue: IssueItem): issue is CompletedIssueItem {
  return 'completed_at' in issue;
}

interface KanbanColumnProps {
  title: string;
  status: string;
  issues: IssueItem[];
}

export default function KanbanColumn({ title, status, issues }: KanbanColumnProps) {
  return (
    <Card className="flex-shrink-0 w-72 flex flex-col max-h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          <Badge variant="secondary">{issues.length}</Badge>
        </div>
      </CardHeader>
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
        {issues.map((issue) => (
          <IssueCard 
            key={issue.issue_id} 
            issue={issue} 
            status={isCompletedIssue(issue) ? issue.status : status}
          />
        ))}
        {issues.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No issues
          </div>
        )}
      </div>
    </Card>
  );
}
