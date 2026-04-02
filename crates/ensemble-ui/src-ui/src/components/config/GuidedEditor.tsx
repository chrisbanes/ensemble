import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Save, RotateCcw, Check } from "lucide-react";
import WorkflowEditor from "./WorkflowEditor";
import type { ValidationIssue } from "@/generated/models";

export interface GuidedAgent {
  name: string;
  label: string;
}

export interface GuidedForm {
  tracker: {
    kind: string;
    path?: string;
    repository?: string;
    project_number?: number;
    api_key?: string;
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
  }>;
  steps: Array<{
    name: string;
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
      permission_policy: string;
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
  onValidate: (form: GuidedForm, baseRawYaml: string) => Promise<void>;
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
  const [lastValidation, setLastValidation] = useState<{
    timestamp: Date;
    issues: ValidationIssue[];
  } | null>(null);

  const handleFormChange = (updates: Partial<GuidedForm>) => {
    setForm((prev) => ({ ...prev, ...updates }));
    setIsDirty(true);
  };

  const handleValidate = async () => {
    setIsValidating(true);
    try {
      await onValidate(form, baseRawYaml);
      setLastValidation({
        timestamp: new Date(),
        issues: issues,
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(form, baseRawYaml);
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

  const hasErrors = issues.length > 0;
  const availableAgents: GuidedAgent[] = form.agents.map((a) => ({
    name: a.name,
    label: a.name,
  }));

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
                  {issues.map((issue, i) => (
                    <li key={i}>
                      {issue.section && `${issue.section}: `}
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
              <Input
                id="tracker-kind"
                value={form.tracker.kind}
                onChange={(e) =>
                  handleFormChange({
                    tracker: { ...form.tracker, kind: e.target.value },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="tracker-path" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Path (optional)</label>
              <Input
                id="tracker-path"
                value={form.tracker.path || ""}
                onChange={(e) =>
                  handleFormChange({
                    tracker: { ...form.tracker, path: e.target.value || undefined },
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
              <label htmlFor="tracker-api-key" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">API Key (optional)</label>
              <Input
                id="tracker-api-key"
                type="password"
                value={form.tracker.api_key || ""}
                onChange={(e) =>
                  handleFormChange({
                    tracker: {
                      ...form.tracker,
                      api_key: e.target.value || undefined,
                    },
                  })
                }
                placeholder="$ENV_VAR or value"
              />
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
                  {agent.model && (
                    <div>
                      <span className="text-muted-foreground">model:</span>{" "}
                      {agent.model}
                    </div>
                  )}
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
                      max_cycles: parseInt(e.target.value) || 0,
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
                        max_concurrent_agents: parseInt(e.target.value) || 0,
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
                        interval_ms: parseInt(e.target.value) || 0,
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
