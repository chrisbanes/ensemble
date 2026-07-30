import { useState, useEffect, useRef } from "react";
import { useSetupDefaultsQuery } from "@/hooks";
import { useValidateSetupMutation, useSaveSetupMutation } from "@/hooks";
import { useAgentDiscovery } from "@/hooks/useAgentDiscovery";
import FileBrowser from "./FileBrowser";
import type {
  SetupTracker,
  SetupRepo,
  SetupAgent,
  SetupStep,
  DiscoveredAgentInfo,
  SetupCheck,
  SecretEdit,
} from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

type CapabilityDefinition = {
  id: string;
  name: string;
  description?: string | null;
};

type SetupAgentDraft = SetupAgent & {
  reasoning_level?: string | null;
  permission_mode?: string | null;
};

type DiscoveredAgentWithCapabilities = DiscoveredAgentInfo & {
  available_models?: CapabilityDefinition[];
  available_modes?: CapabilityDefinition[];
};

interface SetupDraft {
  tracker: SetupTracker;
  repos: SetupRepo[];
  agents: SetupAgentDraft[];
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
  api_key: { state: "unset" },
  api_key_edit: { action: "set_environment", variable: "GITHUB_TOKEN" },
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
};

const DEFAULT_DRAFT: SetupDraft = {
  tracker: { ...DEFAULT_TODO_TRACKER },
  repos: [],
  agents: [{ role: "implement", acpx_agent: "", model: null, reasoning_level: null, permission_mode: null, prompt: null, prompt_file: null }],
  steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
  onSuccess: "done",
  onFailure: "paused",
};

const CUSTOM_VALUE = "__custom__";
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

function supportedPermissionMode(value: string | null | undefined) {
  return value && SUPPORTED_PERMISSION_MODES.has(value) ? value : null;
}

function modelOptions(availableModels: CapabilityDefinition[] | undefined) {
  const models = availableModels ?? [];
  return models.some((model) => model.id === "default")
    ? models
    : [{ id: "default", name: "Default" }, ...models];
}

function findDiscoveredAgent(
  agents: DiscoveredAgentInfo[],
  name: string | null | undefined
) {
  return agents.find((agent) => agent.name === name) as DiscoveredAgentWithCapabilities | undefined;
}

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
  const [customModels, setCustomModels] = useState<Record<number, boolean>>({});

  // Prompt mode tracking for each agent (UI-only state)
  const [promptModes, setPromptModes] = useState<Record<number, "inline" | "file">>({});

  const { data: defaultsData, isLoading: isLoadingDefaults } = useSetupDefaultsQuery();
  
  // Use progressive agent discovery via SSE
  const {
    agents: discoveredAgents,
    isLoading: isLoadingAgents,
    isError: isAgentsError,
  } = useAgentDiscovery({
    enabled: currentStep === "agents"
  });

  const validateMutation = useValidateSetupMutation();
  const saveMutation = useSaveSetupMutation();

  // Load defaults on mount (for reconfigure flow)
  useEffect(() => {
    if (defaultsData?.data?.defaults && defaultsData.data.has_existing_config) {
      const defaults = defaultsData.data.defaults as Partial<SetupDraft>;
      const tracker = defaults.tracker?.kind === "github"
        ? {
            ...defaults.tracker,
            api_key: defaults.tracker.api_key ?? { state: "unset" as const },
            api_key_edit: defaults.tracker.api_key_edit ?? { action: "preserve" as const },
          }
        : defaults.tracker;
      setDraft(prev => ({
        ...prev,
        ...defaults,
        tracker: tracker ?? prev.tracker,
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
    const agents = draft.agents.map((agent) => ({
      ...agent,
      permission_mode: supportedPermissionMode(agent.permission_mode),
    }));
    const result = await validateMutation.mutateAsync({
      data: {
        setup: {
          tracker: draft.tracker,
          repos: draft.repos,
          agents,
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
    const agents = draft.agents.map((agent) => ({
      ...agent,
      permission_mode: supportedPermissionMode(agent.permission_mode),
    }));
    await saveMutation.mutateAsync({
      data: {
        setup: {
          tracker: draft.tracker,
          repos: draft.repos,
          agents,
          steps: draft.steps,
          on_success: draft.onSuccess,
          on_failure: draft.onFailure,
        },
      },
    });
    onComplete?.();
  };

  // Generate default workflow steps based on agent count (CLI parity)
  const updateAgent = (index: number, patch: Partial<SetupAgentDraft>) => {
    setDraft(prev => {
      const newAgents = [...prev.agents];
      const currentAgent = newAgents[index];
      if (!currentAgent) {
        return prev;
      }
      newAgents[index] = { ...currentAgent, ...patch };
      return { ...prev, agents: newAgents };
    });
  };

  const generateDefaultWorkflow = (agents: SetupAgentDraft[]): SetupStep[] => {
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

  useEffect(() => {
    hasVisitedWorkflow.current = false;
  }, [draft.agents]);

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
                  project_number: e.target.value ? parseInt(e.target.value, 10) : null,
                } as SetupTracker,
              }))}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="setup-secret-action">API Key</label>
            <p className="text-sm text-muted-foreground">
              {draft.tracker.api_key?.state === "redacted"
                ? "Existing secret is configured."
                : draft.tracker.api_key?.state === "environment"
                  ? `Environment reference: $${draft.tracker.api_key.variable}`
                  : "No secret is configured."}
            </p>
            <Select
              value={(draft.tracker.api_key_edit ?? { action: "preserve" }).action}
              onValueChange={(action) => {
                let edit: SecretEdit;
                if (action === "set_literal") {
                  edit = { action, value: "" };
                } else if (action === "set_environment") {
                  edit = {
                    action,
                    variable:
                      draft.tracker.kind === "github" &&
                      draft.tracker.api_key.state === "environment"
                        ? draft.tracker.api_key.variable
                        : "GITHUB_TOKEN",
                  };
                } else if (action === "remove") {
                  edit = { action };
                } else {
                  edit = { action: "preserve" };
                }
                setDraft(prev => prev.tracker.kind === "github" ? {
                  ...prev,
                  tracker: { ...prev.tracker, api_key_edit: edit },
                } : prev);
              }}
            >
              <SelectTrigger id="setup-secret-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="preserve">Keep current value</SelectItem>
                <SelectItem value="set_environment">Use environment variable</SelectItem>
                <SelectItem value="set_literal">Replace with literal</SelectItem>
                <SelectItem value="remove">Remove</SelectItem>
              </SelectContent>
            </Select>
            {draft.tracker.api_key_edit?.action === "set_literal" && (
              <Input
                aria-label="Replacement API key"
                type="password"
                value={draft.tracker.api_key_edit.value}
                onChange={(event) => setDraft(prev => prev.tracker.kind === "github" ? {
                  ...prev,
                  tracker: {
                    ...prev.tracker,
                    api_key_edit: {
                      action: "set_literal",
                      value: event.target.value,
                    },
                  },
                } : prev)}
                autoComplete="new-password"
              />
            )}
            {draft.tracker.api_key_edit?.action === "set_environment" && (
              <Input
                aria-label="API key environment variable"
                value={draft.tracker.api_key_edit.variable}
                onChange={(event) => setDraft(prev => prev.tracker.kind === "github" ? {
                  ...prev,
                  tracker: {
                    ...prev.tracker,
                    api_key_edit: {
                      action: "set_environment",
                      variable: event.target.value.replace(/^\$/, ""),
                    },
                  },
                } : prev)}
                placeholder="GITHUB_TOKEN"
              />
            )}
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
          aria-label="Browse for repository directory"
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
          aria-label="Add repository"
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
      {isLoadingAgents && discoveredAgents.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Discovering available agents...</p>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-primary animate-pulse w-1/3" />
          </div>
        </div>
      ) : isAgentsError && discoveredAgents.length === 0 ? (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" />
            <span className="font-medium text-red-800">Failed to load agents</span>
          </div>
          <p className="text-sm text-red-700 mt-2">
            Could not discover available agents. Make sure acpx is installed and accessible.
          </p>
        </div>
      ) : (
        <>
          {/* Show progress while still discovering */}
          {isLoadingAgents && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <span>Found {discoveredAgents.length} agent{discoveredAgents.length !== 1 ? 's' : ''}...</span>
            </div>
          )}
          
          {discoveredAgents.length === 0 && !isLoadingAgents && (
            <div className="p-4 rounded-lg border border-yellow-200 bg-yellow-50">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-yellow-600" />
                <span className="font-medium text-yellow-800">No agents found</span>
              </div>
              <p className="text-sm text-yellow-700 mt-2">
                No coding agents were discovered. Make sure acpx is installed and agents are configured.
              </p>
            </div>
          )}
          
          {draft.agents.map((agent, index) => {
            const selectedDiscoveredAgent = findDiscoveredAgent(discoveredAgents, agent.acpx_agent);
            const hasDiscoveredMatch = !!selectedDiscoveredAgent;
            const isCustom = customAgents[index] || (!!agent.acpx_agent && !isLoadingAgents && !hasDiscoveredMatch);
            const hasModelOptions = (selectedDiscoveredAgent?.available_models?.length ?? 0) > 0;
            const isCustomModel = customModels[index] || !hasModelOptions;
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
                        const updated: Record<number, boolean> = {};
                        for (const [k, v] of Object.entries(prev)) {
                          const numK = Number(k);
                          if (numK < index) updated[numK] = v;
                          else if (numK > index) updated[numK - 1] = v;
                        }
                        return updated;
                      });
                      setCustomModels(prev => {
                        const updated: Record<number, boolean> = {};
                        for (const [k, v] of Object.entries(prev)) {
                          const numK = Number(k);
                          if (numK < index) updated[numK] = v;
                          else if (numK > index) updated[numK - 1] = v;
                        }
                        return updated;
                      });
                      setPromptModes(prev => {
                        const updated: Record<number, "inline" | "file"> = {};
                        for (const [k, v] of Object.entries(prev)) {
                          const numK = Number(k);
                          if (numK < index) updated[numK] = v;
                          else if (numK > index) updated[numK - 1] = v;
                        }
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
                  <label className="text-sm" htmlFor={`agent-select-${index}`}>Agent</label>
                  <Select
                    value={isCustom ? CUSTOM_VALUE : agent.acpx_agent}
                    onValueChange={(value) => {
                      if (value === CUSTOM_VALUE) {
                        setCustomAgents(prev => ({ ...prev, [index]: true }));
                        updateAgent(index, { acpx_agent: "", model: null, reasoning_level: null, permission_mode: null });
                      } else if (value) {
                        setCustomAgents(prev => ({ ...prev, [index]: false }));
                        setCustomModels(prev => ({ ...prev, [index]: false }));
                        updateAgent(index, { acpx_agent: value, model: null, reasoning_level: null, permission_mode: null });
                      }
                    }}
                  >
                    <SelectTrigger id={`agent-select-${index}`}>
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {discoveredAgents.map((discoveredAgent: DiscoveredAgentInfo) => (
                        <SelectItem key={discoveredAgent.name} value={discoveredAgent.name}>
                          {discoveredAgent.label} {discoveredAgent.version && `(${discoveredAgent.version})`}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_VALUE}>Custom...</SelectItem>
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
                <label
                  className="text-sm"
                  htmlFor={isCustomModel && hasModelOptions ? `agent-model-custom-${index}` : `agent-model-${index}`}
                >
                  Model (optional)
                </label>
                {hasModelOptions && (
                  <Select
                    value={customModels[index] ? CUSTOM_VALUE : agent.model ?? "default"}
                    onValueChange={(value) => {
                      if (value === CUSTOM_VALUE) {
                        setCustomModels(prev => ({ ...prev, [index]: true }));
                        return;
                      }
                      setCustomModels(prev => ({ ...prev, [index]: false }));
                      updateAgent(index, { model: value === "default" ? null : value });
                    }}
                  >
                    <SelectTrigger id={`agent-model-${index}`}>
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions(selectedDiscoveredAgent?.available_models).map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {capabilityLabel(model)}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_VALUE}>Custom...</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {isCustomModel && (
                  <Input
                    id={hasModelOptions ? `agent-model-custom-${index}` : `agent-model-${index}`}
                    value={agent.model || ""}
                    onChange={(e) => updateAgent(index, { model: e.target.value || null })}
                    placeholder="e.g., gpt-5"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm" htmlFor={`agent-reasoning-${index}`}>Reasoning Level</label>
                  <Select
                    value={agent.reasoning_level ?? NONE_VALUE}
                    onValueChange={(value) => updateAgent(index, { reasoning_level: value === NONE_VALUE ? null : value })}
                  >
                    <SelectTrigger id={`agent-reasoning-${index}`}>
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
                  <label className="text-sm" htmlFor={`agent-mode-${index}`}>Mode</label>
                  <Select
                    value={agent.permission_mode ?? NONE_VALUE}
                    onValueChange={(value) => updateAgent(index, { permission_mode: value === NONE_VALUE ? null : value })}
                  >
                    <SelectTrigger id={`agent-mode-${index}`}>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Default</SelectItem>
                      {permissionModeOptions(selectedDiscoveredAgent?.available_modes).map((mode) => (
                        <SelectItem key={mode.id} value={mode.id}>
                          {capabilityLabel(mode)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Prompt Configuration */}
              <div className="space-y-2 pt-2 border-t">
                <label className="text-sm" htmlFor={`prompt-mode-${index}`}>Prompt Configuration</label>
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
                  <SelectTrigger id={`prompt-mode-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inline">Inline text</SelectItem>
                    <SelectItem value="file">File path</SelectItem>
                  </SelectContent>
                </Select>

                {promptMode === "inline" ? (
                  <Textarea
                    className="min-h-[100px]"
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
              if (
                activePromptAgentIndex !== null
                && activePromptAgentIndex >= 0
                && activePromptAgentIndex < draft.agents.length
              ) {
                setDraft(prev => {
                  const newAgents = [...prev.agents];
                  const selectedAgent = newAgents[activePromptAgentIndex];
                  if (!selectedAgent) {
                    return prev;
                  }
                  newAgents[activePromptAgentIndex] = {
                    ...selectedAgent,
                    prompt_file: path,
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
                agents: [...prev.agents, { role: "agent", acpx_agent: "", model: null, reasoning_level: null, permission_mode: null, prompt: null, prompt_file: null }],
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
