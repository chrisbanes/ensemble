import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Save, RotateCcw, Check, FileText } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import FileBrowser from "./FileBrowser";
import WorkflowEditor from "./WorkflowEditor";
import type { SecretDisplay, SecretEdit, ValidationIssue } from "@/generated/models";

type CapabilityDefinition = {
  id: string;
  name: string;
  description?: string | null;
};

const NONE_VALUE = "__none__";

const REASONING_LEVELS: CapabilityDefinition[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
];

const PERMISSION_MODE_FALLBACKS: CapabilityDefinition[] = [
  { id: "approve_reads", name: "Approve reads" },
  { id: "approve_all", name: "Approve all" },
  { id: "deny_all", name: "Deny all" },
];

const SUPPORTED_PERMISSION_MODES = new Set(PERMISSION_MODE_FALLBACKS.map((mode) => mode.id));

function capabilityLabel(item: CapabilityDefinition) {
  return item.name || item.id;
}

function permissionModeOptions(availableModes: CapabilityDefinition[] | undefined) {
  const discovered = (availableModes ?? []).filter((mode) => SUPPORTED_PERMISSION_MODES.has(mode.id));
  return discovered.length > 0 ? discovered : PERMISSION_MODE_FALLBACKS;
}

function supportedPermissionMode(value: string | undefined) {
  return value && SUPPORTED_PERMISSION_MODES.has(value) ? value : undefined;
}

function normalizeGuidedForm(form: GuidedForm): GuidedForm {
  return {
    ...form,
    agents: form.agents.map(({ available_models: _availableModels, available_modes: _availableModes, ...agent }) => ({
      ...agent,
      permission_mode: supportedPermissionMode(agent.permission_mode),
    })),
  };
}

export interface GuidedAgent {
  name: string;
  label: string;
}

interface PermissionRequestPolicy {
  mode: "approve_all" | "reject_all" | "select_option";
  option_id?: string;
}

export interface GuidedForm {
  tracker: {
    kind: string;
    path?: string;
    repository?: string;
    project_number?: number;
    api_key: SecretDisplay;
    api_key_edit?: SecretEdit;
    endpoint?: string;
    active_states: string[];
    terminal_states: string[];
    labels_filter: string[];
  };
  repos: Array<{
    path: string;
    branch: string;
    git_remote: string;
  }>;
  agents: Array<{
    name: string;
    executor?: string;
    model?: string;
    acpx_agent?: string;
    prompt?: string;
    prompt_template?: string;
    reasoning_level?: string;
    permission_mode?: string;
    available_models?: CapabilityDefinition[];
    available_modes?: CapabilityDefinition[];
  }>;
  steps: Array<{
    name: string;
    kind?: "agent" | "synthesis";
    agent: string;
    depends: string[];
    tracker_state?: string | null;
  }>;
  runtime: {
    max_cycles: number;
    concurrency: {
      max_concurrent_agents: number;
      max_step_parallelism: number;
    };
    polling: {
      interval_ms: number;
    };
    workspace: {
      root?: string;
    };
    hooks: {
      after_create?: string;
      before_run?: string;
      after_run?: string;
      before_remove?: string;
      timeout_ms: number;
    };
    agent: {
      max_turns: number;
      max_retry_backoff_ms: number;
      command: string;
      session_mode: string;
      permission_request_policy: PermissionRequestPolicy;
      turn_timeout_ms: number;
      read_timeout_ms: number;
      stall_timeout_ms: number;
    };
  };
  transitions: {
    on_success: string;
    on_failure: string;
  };
}

interface GuidedEditorProps {
  initialForm: GuidedForm;
  baseRawYaml: string;
  issues: ValidationIssue[];
  onValidate: (form: GuidedForm, baseRawYaml: string) => Promise<ValidationIssue[]>;
  onSave: (form: GuidedForm, baseRawYaml: string) => Promise<void>;
  onReset: () => void;
}

export default function GuidedEditor({
  initialForm,
  baseRawYaml,
  issues,
  onValidate,
  onSave,
  onReset,
}: GuidedEditorProps) {
  const [form, setForm] = useState<GuidedForm>(initialForm);
  const [isDirty, setIsDirty] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [displayedIssues, setDisplayedIssues] = useState<ValidationIssue[]>(issues);
  const [lastValidation, setLastValidation] = useState<{
    timestamp: Date;
    issues: ValidationIssue[];
  } | null>(null);
  const [trackerPathBrowserOpen, setTrackerPathBrowserOpen] = useState(false);

  useEffect(() => {
    setForm(initialForm);
    setIsDirty(false);
  }, [initialForm]);

  const handleFormChange = (updates: Partial<GuidedForm>) => {
    setForm((prev) => ({ ...prev, ...updates }));
    setIsDirty(true);
  };

  const handleAgentChange = (
    name: string,
    patch: Partial<GuidedForm["agents"][number]>
  ) => {
    setForm((prev) => ({
      ...prev,
      agents: prev.agents.map((agent) =>
        agent.name === name ? { ...agent, ...patch } : agent
      ),
    }));
    setIsDirty(true);
  };

  const handleValidate = async () => {
      setIsValidating(true);
    try {
      const validatedIssues = await onValidate(normalizeGuidedForm(form), baseRawYaml);
      setDisplayedIssues(validatedIssues);
      setLastValidation({
        timestamp: new Date(),
        issues: validatedIssues,
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(normalizeGuidedForm(form), baseRawYaml);
      setIsDirty(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setForm(initialForm);
    setIsDirty(false);
    onReset();
  };

  const hasErrors = displayedIssues.length > 0;
  const availableAgents: GuidedAgent[] = form.agents.map((a) => ({
    name: a.name,
    label: a.name,
  }));
  const secretEdit = form.tracker.api_key_edit ?? { action: "preserve" as const };
  const secretStatus =
    form.tracker.api_key.state === "redacted"
      ? "Existing secret is configured."
      : form.tracker.api_key.state === "environment"
        ? `Environment reference: $${form.tracker.api_key.variable}`
        : "No secret is configured.";

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Guided Configuration Editor</h2>
          {isDirty && (
            <Badge variant="outline" className="text-amber-600 border-amber-600">
              Unsaved Changes
            </Badge>
          )}
          {lastValidation && !hasErrors && (
            <Badge variant="outline" className="text-green-600 border-green-600">
              <Check className="h-3 w-3 mr-1" />
              Valid
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!isDirty || isSaving}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <Button
            variant="outline"
            onClick={handleValidate}
            disabled={isValidating}
          >
            Validate
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isDirty || isSaving || hasErrors}
          >
            <Save className="h-4 w-4 mr-2" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Validation issues */}
      {hasErrors && (
        <Card className="border-red-200 bg-red-50 dark:bg-red-900/20">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold text-red-800 dark:text-red-200">
                  Configuration Issues
                </h3>
                <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300">
                  {displayedIssues.map((issue, i) => (
                    <li key={i}>
              {issue.section ? `${issue.section}: ` : ""}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tracker Section */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-medium">Tracker</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="tracker-kind" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Kind</label>
              <Select
                value={form.tracker.kind}
                onValueChange={(v: string | null) =>
                  handleFormChange({
                    tracker: { ...form.tracker, kind: v ?? "todo_file" },
                  })
                }
              >
                <SelectTrigger id="tracker-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo_file">Todo File</SelectItem>
                  <SelectItem value="github">GitHub Project</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="tracker-path" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Path (optional)</label>
              <div className="flex gap-2">
                <Input
                  id="tracker-path"
                  value={form.tracker.path || ""}
                  onChange={(e) =>
                    handleFormChange({
                      tracker: { ...form.tracker, path: e.target.value || undefined },
                    })
                  }
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setTrackerPathBrowserOpen(true)}
                  title="Browse for file"
                >
                  <FileText className="h-4 w-4" />
                </Button>
              </div>
              <FileBrowser
                open={trackerPathBrowserOpen}
                onOpenChange={setTrackerPathBrowserOpen}
                mode="file"
                title="Select Tracker File"
                initialPath={form.tracker.path || "~"}
                onSelect={(path) =>
                  handleFormChange({
                    tracker: { ...form.tracker, path },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="tracker-repo" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Repository (optional)</label>
              <Input
                id="tracker-repo"
                value={form.tracker.repository || ""}
                onChange={(e) =>
                  handleFormChange({
                    tracker: {
                      ...form.tracker,
                      repository: e.target.value || undefined,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="tracker-secret-action" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">API Key</label>
              <p className="text-sm text-muted-foreground">{secretStatus}</p>
              <Select
                value={secretEdit.action}
                onValueChange={(action) => {
                  let apiKeyEdit: SecretEdit;
                  if (action === "set_literal") {
                    apiKeyEdit = { action, value: "" };
                  } else if (action === "set_environment") {
                    apiKeyEdit = {
                      action,
                      variable:
                        form.tracker.api_key.state === "environment"
                          ? form.tracker.api_key.variable
                          : "GITHUB_TOKEN",
                    };
                  } else if (action === "remove") {
                    apiKeyEdit = { action };
                  } else {
                    apiKeyEdit = { action: "preserve" };
                  }
                  handleFormChange({
                    tracker: { ...form.tracker, api_key_edit: apiKeyEdit },
                  });
                }}
              >
                <SelectTrigger id="tracker-secret-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preserve">Keep current value</SelectItem>
                  <SelectItem value="set_environment">Use environment variable</SelectItem>
                  <SelectItem value="set_literal">Replace with literal</SelectItem>
                  <SelectItem value="remove">Remove</SelectItem>
                </SelectContent>
              </Select>
              {secretEdit.action === "set_literal" && (
                <Input
                  aria-label="Replacement API key"
                  type="password"
                  value={secretEdit.value}
                  onChange={(event) =>
                    handleFormChange({
                      tracker: {
                        ...form.tracker,
                        api_key_edit: {
                          action: "set_literal",
                          value: event.target.value,
                        },
                      },
                    })
                  }
                  autoComplete="new-password"
                />
              )}
              {secretEdit.action === "set_environment" && (
                <Input
                  aria-label="API key environment variable"
                  value={secretEdit.variable}
                  onChange={(event) =>
                    handleFormChange({
                      tracker: {
                        ...form.tracker,
                        api_key_edit: {
                          action: "set_environment",
                          variable: event.target.value.replace(/^\$/, ""),
                        },
                      },
                    })
                  }
                  placeholder="GITHUB_TOKEN"
                />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agents Section */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-medium">Agents ({form.agents.length})</h3>
          <div className="space-y-4">
            {form.agents.map((agent) => (
              <div
                key={agent.name}
                className="p-4 border rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">{agent.name}</h4>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {agent.acpx_agent && (
                    <div>
                      <span className="text-muted-foreground">acpx_agent:</span>{" "}
                      {agent.acpx_agent}
                    </div>
                  )}
                  {agent.executor && (
                    <div>
                      <span className="text-muted-foreground">executor:</span>{" "}
                      {agent.executor}
                    </div>
                  )}
                  <div className="space-y-2">
                    <label htmlFor={`guided-agent-model-${agent.name}`} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Model</label>
                    {(agent.available_models?.length ?? 0) > 0 ? (
                      <Select
                        value={agent.model ?? NONE_VALUE}
                      onValueChange={(value) =>
                        handleAgentChange(agent.name, {
                            model: !value || value === NONE_VALUE ? undefined : value,
                          })
                        }
                      >
                        <SelectTrigger id={`guided-agent-model-${agent.name}`}>
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>Default</SelectItem>
                          {agent.available_models?.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {capabilityLabel(model)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={`guided-agent-model-${agent.name}`}
                        value={agent.model || ""}
                        onChange={(event) =>
                          handleAgentChange(agent.name, {
                            model: event.target.value || undefined,
                          })
                        }
                        placeholder="Default"
                      />
                    )}
                  </div>
                  <div className="space-y-2">
                    <label htmlFor={`guided-agent-reasoning-${agent.name}`} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Reasoning Level</label>
                    <Select
                      value={agent.reasoning_level ?? NONE_VALUE}
                      onValueChange={(value) =>
                        handleAgentChange(agent.name, {
                          reasoning_level: !value || value === NONE_VALUE ? undefined : value,
                        })
                      }
                    >
                      <SelectTrigger id={`guided-agent-reasoning-${agent.name}`}>
                        <SelectValue placeholder="Default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_VALUE}>Default</SelectItem>
                        {REASONING_LEVELS.map((level) => (
                          <SelectItem key={level.id} value={level.id}>
                            {level.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor={`guided-agent-mode-${agent.name}`} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Mode</label>
                    <Select
                      value={supportedPermissionMode(agent.permission_mode) ?? NONE_VALUE}
                      onValueChange={(value) =>
                        handleAgentChange(agent.name, {
                          permission_mode: !value || value === NONE_VALUE ? undefined : value,
                        })
                      }
                    >
                      <SelectTrigger id={`guided-agent-mode-${agent.name}`}>
                        <SelectValue placeholder="Default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_VALUE}>Default</SelectItem>
                        {permissionModeOptions(agent.available_modes).map((mode) => (
                          <SelectItem key={mode.id} value={mode.id}>
                            {capabilityLabel(mode)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {agent.prompt && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">prompt:</span>{" "}
                      {agent.prompt.substring(0, 50)}
                      {agent.prompt.length > 50 ? "..." : ""}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Workflow Section */}
      <Card>
        <CardContent className="p-6">
          <WorkflowEditor
            value={{
              steps: form.steps.map((s) => ({
                name: s.name,
                kind: s.kind,
                agent: s.agent,
                depends: s.depends,
                tracker_state: s.tracker_state,
              })),
              agents: availableAgents,
            }}
            onChange={(draft) =>
              handleFormChange({
                steps: draft.steps.map((s) => ({
                  name: s.name,
                  kind: s.kind,
                  agent: s.agent,
                  depends: s.depends,
                  tracker_state: s.tracker_state,
                })),
              })
            }
          />
        </CardContent>
      </Card>

      {/* Runtime Settings */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-medium">Runtime Settings</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <label htmlFor="max-cycles" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Max Cycles</label>
              <Input
                id="max-cycles"
                type="number"
                value={form.runtime.max_cycles}
                onChange={(e) =>
                  handleFormChange({
                    runtime: {
                      ...form.runtime,
                      max_cycles: parseInt(e.target.value, 10) || 0,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="max-concurrent" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Max Concurrent Agents</label>
              <Input
                id="max-concurrent"
                type="number"
                value={form.runtime.concurrency.max_concurrent_agents}
                onChange={(e) =>
                  handleFormChange({
                    runtime: {
                      ...form.runtime,
                      concurrency: {
                        ...form.runtime.concurrency,
                          max_concurrent_agents: parseInt(e.target.value, 10) || 0,
                      },
                    },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="polling-interval" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Polling Interval (ms)</label>
              <Input
                id="polling-interval"
                type="number"
                value={form.runtime.polling.interval_ms}
                onChange={(e) =>
                  handleFormChange({
                    runtime: {
                      ...form.runtime,
                      polling: {
                        interval_ms: parseInt(e.target.value, 10) || 0,
                      },
                    },
                  })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* State Transitions */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-medium">State Transitions</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="on-success" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">On Success</label>
              <Input
                id="on-success"
                value={form.transitions.on_success}
                onChange={(e) =>
                  handleFormChange({
                    transitions: {
                      ...form.transitions,
                      on_success: e.target.value,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="on-failure" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">On Failure</label>
              <Input
                id="on-failure"
                value={form.transitions.on_failure}
                onChange={(e) =>
                  handleFormChange({
                    transitions: {
                      ...form.transitions,
                      on_failure: e.target.value,
                    },
                  })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Last validation report */}
      {lastValidation && (
        <Card className="bg-muted/50">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              Last validated: {lastValidation.timestamp.toLocaleTimeString()}
              {lastValidation.issues.length === 0 && (
                <span className="text-green-600 ml-2">No issues found</span>
              )}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
