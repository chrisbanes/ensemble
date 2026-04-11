import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

interface IssueInfo {
  title: string;
  description?: string;
  labels: string[];
  priority?: number;
  url?: string;
}

interface IssueInfoSectionProps {
  issue: IssueInfo;
}

export default function IssueInfoSection({ issue }: IssueInfoSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Issue Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">{issue.title}</h4>
          {issue.description && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-3">
              {issue.description}
            </p>
          )}
        </div>
        
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((label) => (
              <Badge key={label} variant="secondary" className="text-xs">
                {label}
              </Badge>
            ))}
          </div>
        )}
        
        {issue.url && (
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            View on Tracker
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}
