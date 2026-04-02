import type { ValidationIssue } from "@/generated/models";
import { AlertCircle } from "lucide-react";

interface ValidationPanelProps {
  issues: ValidationIssue[];
  title?: string;
}

export default function ValidationPanel({ 
  issues, 
  title = "Validation Issues" 
}: ValidationPanelProps) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
      <h4 className="flex items-center gap-2 font-semibold text-destructive">
        <AlertCircle className="h-4 w-4" />
        {title}
      </h4>
      <ul className="mt-2 space-y-2">
        {issues.map((issue, i) => (
          <li 
            key={i} 
            className="text-sm text-destructive/90 flex items-start gap-2"
          >
            <span className="font-mono text-xs bg-destructive/20 px-1.5 py-0.5 rounded">
              {issue.section}
              {issue.field && `.${issue.field}`}
            </span>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
