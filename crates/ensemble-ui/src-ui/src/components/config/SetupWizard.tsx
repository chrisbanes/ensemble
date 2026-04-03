import { useState, useEffect, useRef } from "react";
import { useGetSetupDefaults, useGetSetupAgents } from "@/generated/api/config/config";
import { useValidateSetupMutation, useSaveSetupMutation } from "@/hooks";
import FileBrowser from "./FileBrowser";
import type { 
  SetupTracker, 
  SetupRepo, 
  SetupAgent, 
  SetupStep,
  DiscoveredAgentInfo,
  SetupCheck,
} from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, CheckCircle2, AlertCircle, FolderOpen, FileText } from "lucide-react";

type WizardStep = "tracker" | "repos" | "agents" | "workflow" | "validation";

type TrackerKind = "todo_file" | "github";

interface SetupDraft {
  tracker: SetupTracker;
  repos: SetupRepo[];
  agents: SetupAgent[];
  steps: SetupStep[];
  onSuccess: string;
  onFailure: string;
}

interface SetupWizardProps {
  mode?: "create" | "reconfigure";
  onComplete?: () => void;
}

const DEFAULT_TODO_TRACKER: SetupTracker = { kind: "todo_file", path: "" };
const DEFAULT_GH_TRACKER: SetupTracker = { 
  kind: "github", 
  repository: "", 
  project_number: null,
  api_key_env: "GITHUB_TOKEN",
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
};

const DEFAULT_DRAFT: SetupDraft = {
  tracker: { ...DEFAULT_TODO_TRACKER },
  repos: [],
  agents: [{ role: "implement", acpx_agent: "", model: null, prompt: null, prompt_file: null }],
  steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
  onSuccess: "done",
  onFailure: "paused",
};

export default function SetupWizard({ mode = "create", onComplete }: SetupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>("tracker");
  const [draft, setDraft] = useState<SetupDraft>(DEFAULT_DRAFT);
  const [validationResult, setValidationResult] = useState<{
    canSave: boolean;
    checks: SetupCheck[];
  } | null>(null);
  const [repoPathInput, setRepoPathInput] = useState("");
  const [repoBranchInput, setRepoBranchInput] = useState("main");
  const hasVisitedWorkflow = useRef(false);

  // File browser states
  const [todoPathBrowserOpen, setTodoPathBrowserOpen] = useState(false);
  const [repoPathBrowserOpen, setRepoPathBrowserOpen] = useState(false);
  const [promptFileBrowserOpen, setPromptFileBrowserOpen] = useState(false);
  const [activePromptAgentIndex, setActivePromptAgentIndex] = useState<number | null>(null);

  // Custom agent tracking
  const [customAgents, setCustomAgents] = useState<Record<number, boolean>>({});

  // Prompt mode tracking for each agent (UI-only state)
  const [promptModes, setPromptModes] = useState<Record<number, "inline" | "file">>({});

  const { data: defaultsData, isLoading: isLoadingDefaults } = useGetSetupDefaults({
    query: { enabled: true },
  });
  
  const { data: agentsData, isLoading: isLoadingAgents } = useGetSetupAgents({
    query: { enabled: currentStep === "agents" },
  });

  const validateMutation = useValidateSetupMutation();
  const saveMutation = useSaveSetupMutation();

  // Load defaults on mount (for reconfigure flow)
  useEffect(() => {
    if (defaultsData?.data?.defaults && defaultsData.data.has_existing_config) {
      const defaults = defaultsData.data.defaults as Partial<SetupDraft>;
      setDraft(prev => ({
        ...prev,
        ...defaults,
        repos: defaults.repos || prev.repos,
        agents: defaults.agents || prev.agents,
        steps: defaults.steps || prev.steps,
      }));
    }
  }, [defaultsData]);

  const steps: { key: WizardStep; label: string }[] = [
    { key: "tracker", label: "Tracker" },
    { key: "repos", label: "Repositories" },
    { key: "agents", label: "Agents" },
    { key: "workflow", label: "Workflow" },
    { key: "validation", label: "Validation" },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === currentStep);

  const canGoNext = () => {
    switch (currentStep) {
      case "tracker":
        if (draft.tracker.kind === "todo_file") {
          return draft.tracker.path.trim().length > 0;
        }
        return draft.tracker.repository.trim().length > 0;
      case "repos":
        return draft.repos.length > 0;
      case "agents":
        return draft.agents.length > 0 && draft.agents.every(a => a.acpx_agent.trim().length > 0);
      case "workflow":
        return draft.steps.length > 0;
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (currentStepIndex < steps.length - 1) {
      const nextStep = steps[currentStepIndex + 1];
      if (nextStep) {
        setCurrentStep(nextStep.key);
      }
    }
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      const prevStep = steps[currentStepIndex - 1];
      if (prevStep) {
        setCurrentStep(prevStep.key);
      }
    }
  };

  const handleValidate = async () => {
    const result = await validateMutation.mutateAsync({
      data: {
        setup: {
          tracker: draft.tracker,
          repos: draft.repos,
          agents: draft.agents,
          steps: draft.steps,
          on_success: draft.onSuccess,
          on_failure: draft.onFailure,
        },
      },
    });
    
    if (result?.data) {
      setValidationResult({
        canSave: result.data.can_save,
        checks: result.data.checks,
      });
    }
  };

  const handleSave = async () => {
    await saveMutation.mutateAsync({
      data: {
        setup: {
          tracker: draft.tracker,
          repos: draft.repos,
          agents: draft.agents,
          steps: draft.steps,
          on_success: draft.onSuccess,
          on_failure: draft.onFailure,
        },
      },
    });
    onComplete?.();
  };

  // Generate default workflow steps based on agent count (CLI parity)
  const generateDefaultWorkflow = (agents: SetupAgent[]): SetupStep[] => {
    if (agents.length === 1 && agents[0]) {
      return [{ name: "implement", agent_role: agents[0].role, depends: [], tracker_state: null }];
    } else if (agents.length >= 2 && agents[0] && agents[1]) {
      return [
        { name: "implement", agent_role: agents[0].role, depends: [], tracker_state: null },
        { name: "review", agent_role: agents[1].role, depends: ["implement"], tracker_state: null },
      ];
    }
    return [];
  };

  // Update workflow when agents change (only on first visit to workflow step)
  useEffect(() => {
    if (currentStep === "workflow" && draft.agents.length > 0 && !hasVisitedWorkflow.current) {
      const defaultSteps = generateDefaultWorkflow(draft.agents);
      setDraft(prev => ({ ...prev, steps: defaultSteps }));
      hasVisitedWorkflow.current = true;
    }
  }, [draft.agents, currentStep]);

  const handleTrackerKindChange = (value: TrackerKind) => {
    if (value === "todo_file") {
      setDraft(prev => ({
        ...prev,
        tracker: { ...DEFAULT_TODO_TRACKER },
      }));
    } else {
      setDraft(prev => ({
        ...prev,
        tracker: { ...DEFAULT_GH_TRACKER },
      }));
    }
  };

  const renderTrackerStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Tracker Type</label>
        <Select
          value={draft.tracker.kind}
          onValueChange={(value) => {
            if (value === "todo_file" || value === "github") {
              handleTrackerKindChange(value);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todo_file">Todo File</SelectItem>
            <SelectItem value="github">GitHub Project</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {draft.tracker.kind === "todo_file" ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="todo-path">Path</label>
          <div className="flex gap-2">
            <Input
              id="todo-path"
              value={draft.tracker.path}
              onChange={(e) => setDraft(prev => ({
                ...prev,
                tracker: { kind: "todo_file", path: e.target.value },
              }))}
              placeholder="/path/to/todo.md"
              className="flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => setTodoPathBrowserOpen(true)}
              title="Browse for file"
            >
              <FileText className="h-4 w-4" />
            </Button>
          </div>
          <FileBrowser
            open={todoPathBrowserOpen}
            onOpenChange={setTodoPathBrowserOpen}
            mode="file"
            title="Select Todo File"
            initialPath={draft.tracker.path || "~"}
            onSelect={(path) => setDraft(prev => ({
              ...prev,
              tracker: { kind: "todo_file", path },
            }))}
          />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gh-repo">Repository</label>
            <Input
              id="gh-repo"
              value={draft.tracker.repository}
              onChange={(e) => setDraft(prev => ({
                ...prev,
                tracker: { 
                  ...prev.tracker,
                  repository: e.target.value,
                } as SetupTracker,
              }))}
              placeholder="owner/repo"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gh-project">Project Number (optional)</label>
            <Input
              id="gh-project"
              type="number"
              value={draft.tracker.project_number ?? ""}
              onChange={(e) => setDraft(prev => ({
                ...prev,
                tracker: { 
                  ...prev.tracker,
                  project_number: e.target.value ? parseInt(e.target.value) : null,
                } as SetupTracker,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
  const renderReposStep = () => {
    const handleAddRepo = () => {
      if (repoPathInput.trim()) {
        setDraft(prev => ({
          ...prev,
          repos: [...prev.repos, { path: repoPathInput, branch: repoBranchInput || "main" }],
        }));
        setRepoPathInput("");
        setRepoBranchInput("main");
      }
    };

    return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="Repository path"
          value={repoPathInput}
          onChange={(e) => setRepoPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleAddRepo();
            }
          }}
          aria-label="Repository path"
          className="flex-1"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={() => setRepoPathBrowserOpen(true)}
          title="Browse for directory"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
        <Input
          placeholder="Branch"
          value={repoBranchInput}
          onChange={(e) => setRepoBranchInput(e.target.value)}
          className="w-32"
          aria-label="Branch"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={handleAddRepo}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <FileBrowser
        open={repoPathBrowserOpen}
        onOpenChange={setRepoPathBrowserOpen}
        mode="directory"
        title="Select Repository Directory"
        initialPath={repoPathInput || "~"}
        onSelect={(path) => setRepoPathInput(path)}
      />

      {draft.repos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repositories added yet.</p>
      ) : (
        <div className="space-y-2">
          {draft.repos.map((repo, index) => (
            <div key={index} className="flex items-center justify-between p-2 rounded-lg border">
              <div className="flex items-center gap-2">
                <span className="font-medium">{repo.path}</span>
                <span className="text-sm text-muted-foreground">({repo.branch})</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDraft(prev => ({
                  ...prev,
                  repos: prev.repos.filter((_, i) => i !== index),
                }))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
    );
  };

  const renderAgentsStep = () => (
    <div className="space-y-4">
      {isLoadingAgents ? (
        <p className="text-sm text-muted-foreground">Loading available agents...</p>
      ) : (
        <>
          {draft.agents.map((agent, index) => {
            const isCustom = customAgents[index] || (agent.acpx_agent && !agentsData?.data?.agents?.find((a: DiscoveredAgentInfo) => a.name === agent.acpx_agent));
            const promptMode = promptModes[index] || "inline";
            
            return (
            <div key={index} className="p-4 rounded-lg border space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">Agent {index + 1}</span>
                {draft.agents.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setDraft(prev => ({
                        ...prev,
                        agents: prev.agents.filter((_, i) => i !== index),
                      }));
                      setCustomAgents(prev => {
                        const updated = { ...prev };
                        delete updated[index];
                        return updated;
                      });
                      setPromptModes(prev => {
                        const updated = { ...prev };
                        delete updated[index];
                        return updated;
                      });
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm" htmlFor={`agent-role-${index}`}>Role</label>
                  <Input
                    id={`agent-role-${index}`}
                    value={agent.role}
                    onChange={(e) => setDraft(prev => {
                      const newAgents = [...prev.agents];
                      newAgents[index] = { ...agent, role: e.target.value };
                      return { ...prev, agents: newAgents };
                    })}
                    placeholder="e.g., implement, review"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm">Model (optional)</label>
                  <Input
                    value={agent.model || ""}
                    onChange={(e) => setDraft(prev => {
                      const newAgents = [...prev.agents];
                      newAgents[index] = { ...agent, model: e.target.value || null };
                      return { ...prev, agents: newAgents };
                    })}
                    placeholder="e.g., gpt-4"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm" htmlFor={`agent-select-${index}`}>Agent</label>
                  <Select
                    value={isCustom ? "__custom__" : agent.acpx_agent}
                    onValueChange={(value) => {
                      if (value === "__custom__") {
                        setCustomAgents(prev => ({ ...prev, [index]: true }));
                        setDraft(prev => {
                          const newAgents = [...prev.agents];
                          newAgents[index] = { ...agent, acpx_agent: "" };
                          return { ...prev, agents: newAgents };
                        });
                      } else if (value) {
                        setCustomAgents(prev => ({ ...prev, [index]: false }));
                        setDraft(prev => {
                          const newAgents = [...prev.agents];
                          newAgents[index] = { ...agent, acpx_agent: value };
                          return { ...prev, agents: newAgents };
                        });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agentsData?.data?.agents?.map((discoveredAgent: DiscoveredAgentInfo) => (
                        <SelectItem key={discoveredAgent.name} value={discoveredAgent.name}>
                          {discoveredAgent.label} ({discoveredAgent.version})
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Custom...</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isCustom && (
                <div className="space-y-2">
                  <label className="text-sm">Custom Agent Name</label>
                  <Input
                    value={agent.acpx_agent}
                    onChange={(e) => setDraft(prev => {
                      const newAgents = [...prev.agents];
                      newAgents[index] = { ...agent, acpx_agent: e.target.value };
                      return { ...prev, agents: newAgents };
                    })}
                    placeholder="e.g., my-custom-agent"
                  />
                  <p className="text-xs text-muted-foreground">
                    Custom agents are not validated — ensure this agent is installed and accessible via acpx.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm" htmlFor={`agent-model-${index}`}>Model (optional)</label>
                <Input
                  id={`agent-model-${index}`}
                  value={agent.model || ""}
                  onChange={(e) => setDraft(prev => {
                    const newAgents = [...prev.agents];
                    newAgents[index] = { ...agent, model: e.target.value || null };
                    return { ...prev, agents: newAgents };
                  })}
                  placeholder="e.g., gpt-4"
                />
              </div>

              {/* Prompt Configuration */}
              <div className="space-y-2 pt-2 border-t">
                <label className="text-sm">Prompt Configuration</label>
                <Select
                  value={promptMode}
                  onValueChange={(value) => {
                    setPromptModes(prev => ({ ...prev, [index]: value as "inline" | "file" }));
                    // Clear the other field when switching
                    setDraft(prev => {
                      const newAgents = [...prev.agents];
                      newAgents[index] = { 
                        ...agent, 
                        prompt: value === "file" ? null : agent.prompt,
                        prompt_file: value === "inline" ? null : agent.prompt_file,
                      };
                      return { ...prev, agents: newAgents };
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inline">Inline text</SelectItem>
                    <SelectItem value="file">File path</SelectItem>
                  </SelectContent>
                </Select>

                {promptMode === "inline" ? (
                  <textarea
                    className="w-full min-h-[100px] p-2 text-sm border rounded-md bg-background"
                    placeholder="Enter prompt content..."
                    value={agent.prompt || ""}
                    onChange={(e) => setDraft(prev => {
                      const newAgents = [...prev.agents];
                      newAgents[index] = { ...agent, prompt: e.target.value };
                      return { ...prev, agents: newAgents };
                    })}
                  />
                ) : (
                  <div className="flex gap-2">
                    <Input
                      placeholder="/path/to/prompt.liquid"
                      value={agent.prompt_file || ""}
                      onChange={(e) => setDraft(prev => {
                        const newAgents = [...prev.agents];
                        newAgents[index] = { ...agent, prompt_file: e.target.value };
                        return { ...prev, agents: newAgents };
                      })}
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        setActivePromptAgentIndex(index);
                        setPromptFileBrowserOpen(true);
                      }}
                      title="Browse for prompt file"
                    >
                      <FileText className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
            );
          })}

          <FileBrowser
            open={promptFileBrowserOpen}
            onOpenChange={(open) => {
              setPromptFileBrowserOpen(open);
              if (!open) setActivePromptAgentIndex(null);
            }}
            mode="file"
            title="Select Prompt File"
            initialPath={activePromptAgentIndex !== null 
              ? draft.agents[activePromptAgentIndex]?.prompt_file || "~" 
              : "~"}
            onSelect={(path) => {
              if (activePromptAgentIndex !== null) {
                setDraft(prev => {
                  const newAgents = [...prev.agents];
                  newAgents[activePromptAgentIndex] = { 
                    ...newAgents[activePromptAgentIndex]!, 
                    prompt_file: path 
                  };
                  return { ...prev, agents: newAgents };
                });
              }
            }}
          />

          <Button
            variant="outline"
            onClick={() => {
              setDraft(prev => ({
                ...prev,
                agents: [...prev.agents, { role: "agent", acpx_agent: "", model: null, prompt: null, prompt_file: null }],
              }));
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Agent
          </Button>
        </>
      )}
    </div>
  );

  const renderWorkflowStep = () => (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Workflow steps are generated automatically based on your agents. 
        For a single agent, only an implement step is created. 
        For two or more agents, implement → review workflow is created.
      </p>

      {draft.steps.map((step, index) => (
        <div key={index} className="p-4 rounded-lg border">
          <div className="flex items-center gap-2">
            <span className="font-medium">{step.name}</span>
            <span className="text-sm text-muted-foreground">→</span>
            <span className="text-sm">{step.agent_role}</span>
            {step.depends.length > 0 && (
              <span className="text-xs text-muted-foreground">
                (depends on: {step.depends.join(", ")})
              </span>
            )}
          </div>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-4 pt-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">On Success</label>
          <Select
            value={draft.onSuccess}
            onValueChange={(value) => {
              if (value) {
                setDraft(prev => ({ ...prev, onSuccess: value }));
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">On Failure</label>
          <Select
            value={draft.onFailure}
            onValueChange={(value) => {
              if (value) {
                setDraft(prev => ({ ...prev, onFailure: value }));
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  const renderValidationStep = () => (
    <div className="space-y-4">
      {validationResult ? (
        <div className="space-y-4">
          <div className={`p-4 rounded-lg border ${validationResult.canSave ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200"}`}>
            <div className="flex items-center gap-2">
              {validationResult.canSave ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <span className="font-medium text-green-800">Validation Passed</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-5 w-5 text-yellow-600" />
                  <span className="font-medium text-yellow-800">Validation Failed</span>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Checks</h4>
            {validationResult.checks.map((check, index) => (
              <div key={index} className="flex items-center gap-2 p-2 rounded border">
                {check.passed ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-600" />
                )}
                <span className="font-medium">{check.label}</span>
                <span className="text-sm text-muted-foreground">- {check.detail}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Click "Validate" to check your configuration before saving.
        </p>
      )}
    </div>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case "tracker":
        return renderTrackerStep();
      case "repos":
        return renderReposStep();
      case "agents":
        return renderAgentsStep();
      case "workflow":
        return renderWorkflowStep();
      case "validation":
        return renderValidationStep();
      default:
        return null;
    }
  };

  if (isLoadingDefaults && mode === "reconfigure") {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-center text-muted-foreground">Loading existing configuration...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === "reconfigure" ? "Reconfigure Ensemble" : "Set up Ensemble"}
        </CardTitle>
        
        {/* Step indicators */}
        <div className="flex items-center gap-2 pt-2">
          {steps.map((step, index) => (
            <div key={step.key} className="flex items-center">
              <div
                className={`px-3 py-1 rounded-full text-sm ${
                  index === currentStepIndex
                    ? "bg-primary text-primary-foreground"
                    : index < currentStepIndex
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {step.label}
              </div>
              {index < steps.length - 1 && (
                <div className="w-4 h-px bg-border mx-1" />
              )}
            </div>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {renderStepContent()}
      </CardContent>

      <CardFooter className="flex justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={handleBack}
          disabled={currentStepIndex === 0}
        >
          Back
        </Button>

        <div className="flex gap-2">
          {currentStep === "validation" ? (
            <>
              <Button
                variant="secondary"
                onClick={handleValidate}
                disabled={validateMutation.isPending}
              >
                {validateMutation.isPending ? "Validating..." : "Validate"}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending || (validationResult ? !validationResult.canSave : true)}
              >
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <Button
              onClick={handleNext}
              disabled={!canGoNext()}
            >
              Next
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
