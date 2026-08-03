import { useConfigStateQuery, useValidateGuidedFormMutation, useSaveGuidedFormMutation, useValidateYamlDraftMutation, useSaveYamlDraftMutation } from "@/hooks";
import type { GuidedConfigForm } from "@/generated/models";
import type { ValidationIssue } from "@/generated/models";
import SetupWizard, { type SetupWizardCompletion } from "@/components/config/SetupWizard";
import RestartRequiredNotice, {
  restartRequiredMessage,
} from "@/components/config/RestartRequiredNotice";
import YamlEditor from "@/components/config/YamlEditor";
import GuidedEditor, { type GuidedForm } from "@/components/config/GuidedEditor";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Edit2, FileText, Settings } from "lucide-react";

const SUPPORTED_PERMISSION_MODES = new Set(["approve_all", "approve_reads", "deny_all"]);
const SUPPORTED_PERMISSION_REQUEST_POLICY_MODES = new Set(["approve_all", "reject_all", "select_option"]);

function toPermissionRequestPolicy(
  policy: GuidedConfigForm["runtime"]["agent"]["permission_request_policy"]
): GuidedForm["runtime"]["agent"]["permission_request_policy"] {
  const mode = SUPPORTED_PERMISSION_REQUEST_POLICY_MODES.has(policy.mode)
    ? (policy.mode as GuidedForm["runtime"]["agent"]["permission_request_policy"]["mode"])
    : "approve_all";
  return {
    mode,
    option_id: policy.option_id ?? undefined,
  };
}

function toGuidedForm(form: GuidedConfigForm): GuidedForm {
  return {
    tracker: {
      ...form.tracker,
      path: form.tracker.path ?? undefined,
      repository: form.tracker.repository ?? undefined,
      project_number: form.tracker.project_number ?? undefined,
      api_key: form.tracker.api_key ?? { state: "unset" },
      api_key_edit: form.tracker.api_key_edit ?? { action: "preserve" },
      endpoint: form.tracker.endpoint ?? undefined,
    },
    repos: form.repos.map((repo) => ({ ...repo })),
    agents: form.agents.map((agent) => ({
      ...agent,
      acpx_agent: agent.acpx_agent ?? undefined,
      executor: agent.executor ?? undefined,
      model: agent.model ?? undefined,
      permission_mode: agent.permission_mode ?? undefined,
      prompt: agent.prompt ?? undefined,
      prompt_template: agent.prompt_template ?? undefined,
      reasoning_level: agent.reasoning_level ?? undefined,
      available_models: agent.available_models ?? undefined,
      available_modes: agent.available_modes ?? undefined,
    })),
    steps: form.steps.map((step) => ({
      ...step,
      depends: step.depends ?? undefined,
      kind: (step.kind ?? "agent") as "agent" | "synthesis",
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
      agent: {
        ...form.runtime.agent,
        max_concurrent_agents_by_state:
          form.runtime.agent.max_concurrent_agents_by_state ?? {},
        permission_request_policy: toPermissionRequestPolicy(form.runtime.agent.permission_request_policy),
      },
    },
    transitions: { ...form.transitions },
  };
}

function stripGuidedRuntimeMetadata(form: GuidedForm): GuidedForm {
  return {
    ...form,
    agents: form.agents.map(({ available_models: _availableModels, available_modes: _availableModes, ...agent }) => ({
      ...agent,
      permission_mode:
        agent.permission_mode && SUPPORTED_PERMISSION_MODES.has(agent.permission_mode)
          ? agent.permission_mode
          : undefined,
    })),
  };
}

export default function ConfigPage() {
  const { data, isLoading, isError, refetch } = useConfigStateQuery();
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [activeTab, setActiveTab] = useState<"guided" | "yaml">("guided");
  const [comparisonMode, setComparisonMode] = useState(false);
  const [displayedIssues, setDisplayedIssues] = useState<ValidationIssue[]>([]);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const issues = data?.issues ?? [];

  const validateGuidedFormMutation = useValidateGuidedFormMutation();
  const saveGuidedFormMutation = useSaveGuidedFormMutation();
  const validateYamlMutation = useValidateYamlDraftMutation();
  const saveYamlMutation = useSaveYamlDraftMutation();

  const handleRestartRequired = async (error: unknown) => {
    const message = restartRequiredMessage(error);
    if (!message) {
      throw error;
    }
    setRestartMessage(message);
    await refetch();
  };

  const handleValidateGuided = async (form: GuidedForm, baseRawYaml: string): Promise<ValidationIssue[]> => {
    const response = await validateGuidedFormMutation.mutateAsync({
      baseRawYaml,
      form: stripGuidedRuntimeMetadata(form),
    });
    setDisplayedIssues(response.data.issues);
    await refetch();
    return response.data.issues;
  };

  const handleSaveGuided = async (form: GuidedForm, baseRawYaml: string) => {
    const normalizedForm = {
      ...stripGuidedRuntimeMetadata(form),
      steps: form.steps.map((step) => ({
        ...step,
        kind: step.kind && step.kind !== "agent" ? step.kind : undefined,
      })),
    };
    try {
      await saveGuidedFormMutation.mutateAsync({ baseRawYaml, form: normalizedForm });
      setDisplayedIssues([]);
      await refetch();
    } catch (error) {
      await handleRestartRequired(error);
    }
  };

  const handleValidateYaml = async (yaml: string): Promise<ValidationIssue[]> => {
    const response = await validateYamlMutation.mutateAsync({ data: { raw_yaml: yaml } });
    setDisplayedIssues(response.data.issues);
    await refetch();
    return response.data.issues;
  };

  const handleSaveYaml = async (yaml: string) => {
    try {
      await saveYamlMutation.mutateAsync({ data: { raw_yaml: yaml } });
      setDisplayedIssues([]);
      await refetch();
    } catch (error) {
      await handleRestartRequired(error);
    }
  };

  const handleSetupComplete = (completion?: SetupWizardCompletion) => {
    setShowSetupWizard(false);
    if (completion?.restartRequiredMessage) {
      setRestartMessage(completion.restartRequiredMessage);
      void refetch();
    }
  };

  const guidedForm = data?.guided_form;
  const memoizedForm = useMemo(
    () => (guidedForm ? toGuidedForm(guidedForm) : null),
    [guidedForm]
  );

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-destructive">Failed to load configuration.</div>;
  }

  if (!data) return null;

  const { state, raw_yaml: rawYaml } = data;

  const hasIssues = (displayedIssues.length > 0 || issues.length > 0);
  const isEditable = state === "parsed";
  const bannerIssues = displayedIssues.length > 0 ? displayedIssues : issues;

  if (restartMessage) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <RestartRequiredNotice message={restartMessage} />
      </div>
    );
  }

  // Missing config - show setup mode
  if (state === "missing" || showSetupWizard) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <SetupWizard 
          mode={state === "missing" ? "create" : "reconfigure"}
          onComplete={handleSetupComplete}
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
                  {bannerIssues.map((issue: ValidationIssue, i: number) => (
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
              {activeTab === "guided" && memoizedForm && (
                <GuidedEditor
                  initialForm={memoizedForm}
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
