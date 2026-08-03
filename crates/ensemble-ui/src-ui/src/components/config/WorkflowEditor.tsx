import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, Plus, GripVertical } from "lucide-react";

export interface WorkflowStep {
  name: string;
  kind?: "agent" | "synthesis";
  agent: string;
  depends?: string[];
  tracker_state?: string | null;
}

export interface WorkflowAgent {
  name: string;
  label: string;
}

export interface WorkflowDraft {
  steps: WorkflowStep[];
  agents: WorkflowAgent[];
}

interface WorkflowEditorProps {
  value: WorkflowDraft;
  onChange: (draft: WorkflowDraft) => void;
}

export default function WorkflowEditor({ value, onChange }: WorkflowEditorProps) {
  const { steps, agents } = value;

  const updateStep = (index: number, updates: Partial<WorkflowStep>) => {
    const step = steps[index];
    if (!step) return;

    const renamedFrom = updates.name === undefined || updates.name === step.name
      ? undefined
      : step.name;
    const newSteps = steps.map((current, i) => {
      if (i === index) return { ...current, ...updates };
      if (renamedFrom === undefined || current.depends === undefined) return current;
      return {
        ...current,
        depends: current.depends.map((dependency) =>
          dependency === renamedFrom ? updates.name! : dependency
        ),
      };
    });
    onChange({ ...value, steps: newSteps });
  };

  const addStep = () => {
    const newStep: WorkflowStep = {
      name: `step-${steps.length + 1}`,
      kind: "agent",
      agent: agents[0]?.name || "",
      depends: undefined,
      tracker_state: null,
    };
    onChange({ ...value, steps: [...steps, newStep] });
  };

  const removeStep = (index: number) => {
    const step = steps[index];
    if (!step) return;
    const stepName = step.name;
    const newSteps = steps.filter((_, i) => i !== index);
    // Remove this step from dependencies of other steps
    const updatedSteps = newSteps.map((step) =>
      step.depends
        ? { ...step, depends: step.depends.filter((dependency) => dependency !== stepName) }
        : step
    );
    onChange({ ...value, steps: updatedSteps });
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    if (direction === "up" && index === 0) return;
    if (direction === "down" && index === steps.length - 1) return;

    const newSteps = [...steps];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    const currentStep = newSteps[index];
    const targetStep = newSteps[targetIndex];
    if (currentStep && targetStep) {
      newSteps[index] = targetStep;
      newSteps[targetIndex] = currentStep;
      onChange({ ...value, steps: newSteps });
    }
  };

  // Get available dependencies for a step (only prior steps)
  const getAvailableDependencies = (stepIndex: number): string[] => {
    return steps.slice(0, stepIndex).map((s) => s.name);
  };

  const toggleDependency = (stepIndex: number, depName: string) => {
    const step = steps[stepIndex];
    if (!step) return;
    const depends = step.depends ?? [];
    const hasDep = depends.includes(depName);
    const newDepends = hasDep
      ? depends.filter((dependency) => dependency !== depName)
      : [...depends, depName];
    updateStep(stepIndex, { depends: newDepends });
  };

  const dependencyMode = (step: WorkflowStep) => {
    if (step.depends === undefined) return "Default sequencing";
    return step.depends.length === 0 ? "Independent root" : "Selected prerequisites";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Pipeline Steps</h3>
        <Button onClick={addStep} size="sm" variant="outline">
          <Plus className="h-4 w-4 mr-1" />
          Add Step
        </Button>
      </div>

      {steps.length === 0 && (
        <div className="text-center py-8 text-muted-foreground border rounded-lg border-dashed">
          No steps defined. Click "Add Step" to create your first step.
        </div>
      )}

      <div className="space-y-3">
        {steps.map((step, index) => {
          const availableDeps = getAvailableDependencies(index);

          return (
            <div
              key={step.name || `${index}`}
              className="flex items-start gap-3 p-4 border rounded-lg bg-card"
            >
              <div className="flex flex-col gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => moveStep(index, "up")}
                  disabled={index === 0}
                >
                  <span className="sr-only">Move up</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m18 15-6-6-6 6" />
                  </svg>
                </Button>
                <div className="flex items-center justify-center h-6 w-6 text-muted-foreground">
                  <GripVertical className="h-4 w-4" />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => moveStep(index, "down")}
                  disabled={index === steps.length - 1}
                >
                  <span className="sr-only">Move down</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </Button>
              </div>

              <div className="flex-1 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Step Name</label>
                    <Input
                      value={step.name}
                      onChange={(e) => updateStep(index, { name: e.target.value })}
                      placeholder="e.g., implement"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor={`agent-${index}`}>Agent</label>
                    <Select
                      value={step.agent}
                      onValueChange={(val) => val && updateStep(index, { agent: val })}
                    >
                      <SelectTrigger id={`agent-${index}`}>
                        <SelectValue placeholder="Select agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem key={agent.name} value={agent.name}>
                            {agent.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor={`step-kind-${index}`}>Step Kind</label>
                  <Select
                    value={step.kind ?? "agent"}
                    onValueChange={(val) =>
                      updateStep(index, { kind: val as "agent" | "synthesis" })
                    }
                  >
                    <SelectTrigger aria-label={`Step kind ${step.name}`} id={`step-kind-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="synthesis">Synthesis</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor={`dependency-mode-${index}`}>
                    Dependency Mode
                  </label>
                  <Select
                    value={dependencyMode(step)}
                    onValueChange={(mode) => {
                      if (mode === "Default sequencing") updateStep(index, { depends: undefined });
                      if (mode === "Independent root") updateStep(index, { depends: [] });
                      if (mode === "Selected prerequisites") updateStep(index, { depends: availableDeps });
                    }}
                  >
                    <SelectTrigger id={`dependency-mode-${index}`} aria-label={`Dependency mode ${step.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Default sequencing">Default sequencing</SelectItem>
                      <SelectItem value="Independent root">Independent root</SelectItem>
                      {availableDeps.length > 0 && (
                        <SelectItem value="Selected prerequisites">Selected prerequisites</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {dependencyMode(step) === "Default sequencing" && (
                    <p className="text-xs text-muted-foreground">
                      {index === 0
                        ? "The first step has no prior step, so it is a root."
                        : "This step runs after the prior step."}
                    </p>
                  )}
                  {dependencyMode(step) === "Independent root" && (
                    <p className="text-xs text-muted-foreground">This step is an independent root.</p>
                  )}
                </div>

                {dependencyMode(step) === "Selected prerequisites" && availableDeps.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Prerequisites</label>
                    <div className="flex flex-wrap gap-2">
                      {availableDeps.map((depName) => {
                        const isSelected = step.depends?.includes(depName);
                        return (
                          <button
                            key={depName}
                            onClick={() => toggleDependency(index, depName)}
                            className={`px-2 py-1 text-xs rounded border transition-colors ${
                              isSelected
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-background hover:bg-muted"
                            }`}
                          >
                            {depName}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Tracker State (optional)</label>
                  <Input
                    value={step.tracker_state || ""}
                    onChange={(e) =>
                      updateStep(index, {
                        tracker_state: e.target.value || undefined,
                      })
                    }
                    placeholder="e.g., In Progress"
                  />
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeStep(index)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                aria-label={`Remove step ${step.name}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>

      {steps.length > 0 && (
        <div className="pt-4 border-t">
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Pipeline Summary</p>
            <p className="mt-1">{steps.length} step(s) • {agents.length} agent(s) available</p>
            <p className="mt-1">
              Execution order: {" "}
              {steps.map((s, i) => (
                <span key={s.name}>
                  {s.name}
                  {i < steps.length - 1 ? " → " : ""}
                </span>
              ))}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
