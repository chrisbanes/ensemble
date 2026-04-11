import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface WorkflowStep {
  name: string;
  agent: string;
  dependencies: string[];
  state: string;
  can_navigate: boolean;
}

interface WorkflowStepsSidebarProps {
  steps: WorkflowStep[];
  issueIdentifier: string;
  currentStep?: string;
}

const stateIcons: Record<string, string> = {
  pending: "○",
  running: "●",
  passed: "✓",
  failed: "✗",
  waiting: "◐",
  rejected: "⊘",
};

const stateColors: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-blue-500",
  passed: "text-green-500",
  failed: "text-red-500",
  waiting: "text-yellow-500",
  rejected: "text-orange-500",
};

export default function WorkflowStepsSidebar({ 
  steps, 
  issueIdentifier,
  currentStep 
}: WorkflowStepsSidebarProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Workflow Steps</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step) => {
          const isActive = step.name === currentStep;
          const icon = stateIcons[step.state] ?? "○";
          const color = stateColors[step.state] ?? "text-gray-400";
          
          return (
            <div key={step.name} className="flex items-center gap-2">
              <span className={`text-lg ${color}`}>{icon}</span>
              {step.can_navigate ? (
                <Link
                  to={`/issue/${encodeURIComponent(issueIdentifier)}/step/${encodeURIComponent(step.name)}`}
                  className={`text-sm hover:underline ${isActive ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
                >
                  {step.name}
                </Link>
              ) : (
                <span className="text-sm text-muted-foreground">{step.name}</span>
              )}
              <Badge variant="outline" className="text-xs ml-auto">
                {step.agent}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
