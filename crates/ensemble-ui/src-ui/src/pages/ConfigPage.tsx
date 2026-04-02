import { useConfigStateQuery } from "@/hooks";
import type { ValidationIssue } from "@/generated/models";
import SetupWizard from "@/components/config/SetupWizard";
import YamlEditor from "@/components/config/YamlEditor";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Edit2 } from "lucide-react";

export default function ConfigPage() {
  const { data, isLoading, isError } = useConfigStateQuery();
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-destructive">Failed to load configuration.</div>;
  }

  if (!data) return null;

  const { state, issues, raw_yaml: rawYaml } = data;
  const hasIssues = issues.length > 0;
  const isRunnable = state === "parsed" && data.active_config != null && !hasIssues;

  // Missing config - show setup mode
  if (state === "missing" || showSetupWizard) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <SetupWizard 
          mode={state === "missing" ? "create" : "reconfigure"}
          onComplete={() => setShowSetupWizard(false)}
        />
      </div>
    );
  }

  // Syntax error - show YAML recovery
  if (state === "syntax_error") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <YamlEditor
          rawYaml={rawYaml || ""}
          isRecoveryMode={true}
          issues={issues}
        />
      </div>
    );
  }

  // Parsed with validation issues - show edit mode with validation
  if (state === "parsed" && hasIssues) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <Card>
          <CardContent className="p-6">
            <div className="rounded-lg p-4 border bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800">
              <h2 className="text-lg font-semibold text-yellow-800 dark:text-yellow-200">Configuration Issues</h2>
              <ul className="mt-2 space-y-2">
                {issues.map((issue: ValidationIssue, i: number) => (
                  <li key={i} className="text-sm text-red-600 dark:text-red-400">{issue.message}</li>
                ))}
              </ul>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" onClick={() => setShowSetupWizard(true)}>
                <Edit2 className="h-4 w-4 mr-2" />
                Reconfigure
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Runnable config - show edit mode with full tabs
  if (isRunnable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <Card>
          <CardContent className="p-6">
            <div className="rounded-lg p-4 border bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800">
              <h2 className="text-lg font-semibold text-green-800 dark:text-green-200">Configuration Editor</h2>
              <p className="text-sm text-green-700 dark:text-green-300">
                Configuration is valid and ready to use.
              </p>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" onClick={() => setShowSetupWizard(true)}>
                <Edit2 className="h-4 w-4 mr-2" />
                Reconfigure
              </Button>
            </div>
            <div className="mt-4 flex gap-2 text-sm">
              <span className="px-2 py-1 rounded bg-green-200 dark:bg-green-700">Guided</span>
              <span className="px-2 py-1 rounded bg-gray-200 dark:bg-gray-700">YAML</span>
              <span className="px-2 py-1 rounded bg-gray-200 dark:bg-gray-700">Validation</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fallback for any other state
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Configuration</h1>
      <Card>
        <CardContent className="p-6">
          <div className="rounded-lg p-4 border bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Unknown State</h2>
            <p className="text-sm text-muted-foreground">
              Configuration state: <code>{state}</code>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
