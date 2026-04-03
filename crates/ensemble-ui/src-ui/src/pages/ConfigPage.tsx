import { useConfigStateQuery, useValidateGuidedFormMutation, useSaveGuidedFormMutation, useValidateYamlDraftMutation, useSaveYamlDraftMutation } from "@/hooks";
import type { GuidedConfigForm } from "@/generated/models";
import type { ValidationIssue } from "@/generated/models";
import SetupWizard from "@/components/config/SetupWizard";
import YamlEditor from "@/components/config/YamlEditor";
import GuidedEditor, { type GuidedForm } from "@/components/config/GuidedEditor";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Edit2, FileText, Settings } from "lucide-react";

function toGuidedForm(form: GuidedConfigForm): GuidedForm {
  return {
    tracker: {
      ...form.tracker,
      path: form.tracker.path ?? undefined,
      repository: form.tracker.repository ?? undefined,
      project_number: form.tracker.project_number ?? undefined,
      api_key: form.tracker.api_key ?? undefined,
      endpoint: form.tracker.endpoint ?? undefined,
    },
    repos: form.repos.map((repo) => ({ ...repo })),
    agents: form.agents.map((agent) => ({
      ...agent,
      acpx_agent: agent.acpx_agent ?? undefined,
      executor: agent.executor ?? undefined,
      model: agent.model ?? undefined,
      prompt: agent.prompt ?? undefined,
      prompt_template: agent.prompt_template ?? undefined,
      reasoning_level: agent.reasoning_level ?? undefined,
    })),
    steps: form.steps.map((step) => ({
      ...step,
      tracker_state: step.tracker_state ?? undefined,
    })),
    runtime: {
      ...form.runtime,
      workspace: {
        ...form.runtime.workspace,
        root: form.runtime.workspace.root ?? undefined,
      },
      hooks: {
        ...form.runtime.hooks,
        after_create: form.runtime.hooks.after_create ?? undefined,
        before_run: form.runtime.hooks.before_run ?? undefined,
        after_run: form.runtime.hooks.after_run ?? undefined,
        before_remove: form.runtime.hooks.before_remove ?? undefined,
      },
    },
    transitions: { ...form.transitions },
  };
}

export default function ConfigPage() {
  const { data, isLoading, isError, refetch } = useConfigStateQuery();
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [activeTab, setActiveTab] = useState<"guided" | "yaml">("guided");
  const [comparisonMode, setComparisonMode] = useState(false);
  const [displayedIssues, setDisplayedIssues] = useState<ValidationIssue[]>([]);
  const issues = data?.issues ?? [];

  const validateGuidedFormMutation = useValidateGuidedFormMutation();
  const saveGuidedFormMutation = useSaveGuidedFormMutation();
  const validateYamlMutation = useValidateYamlDraftMutation();
  const saveYamlMutation = useSaveYamlDraftMutation();

  const handleValidateGuided = async (form: GuidedForm, baseRawYaml: string): Promise<ValidationIssue[]> => {
    const response = await validateGuidedFormMutation.mutateAsync({ baseRawYaml, form });
    await refetch();
    return response.data.issues;
  };

  const handleSaveGuided = async (form: GuidedForm, baseRawYaml: string) => {
    await saveGuidedFormMutation.mutateAsync({ baseRawYaml, form });
    await refetch();
  };

  const handleValidateYaml = async (yaml: string): Promise<ValidationIssue[]> => {
    const response = await validateYamlMutation.mutateAsync({ data: { raw_yaml: yaml } });
    await refetch();
    return response.data.issues;
  };

  const handleSaveYaml = async (yaml: string) => {
    await saveYamlMutation.mutateAsync({ data: { raw_yaml: yaml } });
    await refetch();
  };

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-destructive">Failed to load configuration.</div>;
  }

  if (!data) return null;

  const { state, raw_yaml: rawYaml } = data;
  const guidedForm = data.guided_form;

  const hasIssues = displayedIssues.length > 0;
  const isEditable = state === "parsed";

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
          onValidate={handleValidateYaml}
          onSave={handleSaveYaml}
          onReset={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  if (isEditable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <Card>
          <CardContent className="p-6">
            <div className={`rounded-lg p-4 border ${hasIssues
              ? "bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800"
              : "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800"}`}>
              <h2 className={`text-lg font-semibold ${hasIssues
                ? "text-yellow-800 dark:text-yellow-200"
                : "text-green-800 dark:text-green-200"}`}>
                Configuration Editor
              </h2>
              <p className={`text-sm ${hasIssues
                ? "text-yellow-700 dark:text-yellow-300"
                : "text-green-700 dark:text-green-300"}`}>
                {hasIssues
                  ? "Configuration has validation issues. Fix them in guided or YAML mode and validate again before saving."
                  : "Configuration is valid and ready to use."}
              </p>
              {hasIssues && (
                <ul className="mt-2 space-y-2">
                  {displayedIssues.map((issue: ValidationIssue, i: number) => (
                    <li key={i} className="text-sm text-red-600 dark:text-red-400">{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" onClick={() => setShowSetupWizard(true)}>
                <Edit2 className="h-4 w-4 mr-2" />
                Reconfigure
              </Button>
              {rawYaml && (
                <Button variant="outline" onClick={() => setComparisonMode(!comparisonMode)}>
                  <FileText className="h-4 w-4 mr-2" />
                  {comparisonMode ? "Hide Saved YAML" : "View Saved YAML"}
                </Button>
              )}
            </div>
            <div className="mt-4 flex gap-2 text-sm border-b">
              <button
                onClick={() => setActiveTab("guided")}
                className={`px-3 py-2 rounded-t-lg flex items-center gap-1 ${
                  activeTab === "guided"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Settings className="h-4 w-4" />
                Guided
              </button>
              <button
                onClick={() => setActiveTab("yaml")}
                className={`px-3 py-2 rounded-t-lg flex items-center gap-1 ${
                  activeTab === "yaml"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <FileText className="h-4 w-4" />
                YAML
              </button>
            </div>
            <div className="mt-4">
              {activeTab === "guided" && guidedForm && (
                <GuidedEditor
                  initialForm={toGuidedForm(guidedForm)}
                  baseRawYaml={rawYaml || ""}
                  issues={displayedIssues}
                  onValidate={handleValidateGuided}
                  onSave={handleSaveGuided}
                  onReset={() => {
                    void refetch();
                  }}
                />
              )}
              {activeTab === "yaml" && rawYaml && (
                <YamlEditor
                  rawYaml={rawYaml}
                  isRecoveryMode={false}
                  issues={displayedIssues}
                  onValidate={handleValidateYaml}
                  onSave={handleSaveYaml}
                  onReset={() => {
                    void refetch();
                  }}
                />
              )}
            </div>
          </CardContent>
        </Card>
        {comparisonMode && rawYaml && (
          <Card>
            <CardContent className="p-6">
              <h3 className="text-lg font-medium mb-4">Raw YAML (Read Only)</h3>
              <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                <code>{rawYaml}</code>
              </pre>
            </CardContent>
          </Card>
        )}
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
