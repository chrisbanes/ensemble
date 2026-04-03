import { useState, useEffect } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import type { ValidationIssue } from "@/generated/models";
import ValidationPanel from "./ValidationPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

interface YamlEditorProps {
  rawYaml: string;
  isRecoveryMode?: boolean;
  issues: ValidationIssue[];
  onValidate?: (yaml: string) => Promise<ValidationIssue[]>;
  onSave?: (yaml: string) => void;
  onReset?: () => void;
  isValidating?: boolean;
  isSaving?: boolean;
}

export default function YamlEditor({
  rawYaml: initialYaml,
  isRecoveryMode = false,
  issues,
  onValidate,
  onSave,
  onReset,
  isValidating = false,
  isSaving = false,
}: YamlEditorProps) {
  const [rawYaml, setRawYaml] = useState(initialYaml);
  const [hasChanges, setHasChanges] = useState(false);
  const [validationIssues, setValidationIssues] = useState(issues);

  // Update state when initialYaml prop changes (e.g., after save)
  useEffect(() => {
    setRawYaml(initialYaml);
    setHasChanges(false);
  }, [initialYaml]);

  useEffect(() => {
    setValidationIssues(issues);
  }, [issues]);

  const handleChange = (value: string) => {
    setRawYaml(value);
    setHasChanges(value !== initialYaml);
  };

  const handleReset = () => {
    setRawYaml(initialYaml);
    setHasChanges(false);
    onReset?.();
  };

  const handleValidate = async () => {
    if (!onValidate) return;
    const nextIssues = await onValidate(rawYaml);
    setValidationIssues(nextIssues);
  };

  const handleSave = () => {
    onSave?.(rawYaml);
  };

  return (
    <Card className={isRecoveryMode ? "border-destructive" : undefined}>
      <CardHeader>
        <CardTitle>
          {isRecoveryMode ? "YAML Recovery Editor" : "Raw YAML Editor"}
        </CardTitle>
        {isRecoveryMode && (
          <p className="text-sm text-muted-foreground">
            Fix the YAML syntax errors below. The Guided tab is disabled until the YAML is valid.
          </p>
        )}
      </CardHeader>
      
      <CardContent className="space-y-4">
        <div className="border rounded-lg overflow-hidden">
          <CodeMirror
            value={rawYaml}
            extensions={[yaml()]}
            onChange={handleChange}
            basicSetup={{ lineNumbers: true, foldGutter: true }}
            className="text-sm"
          />
        </div>

        {validationIssues.length > 0 && (
          <ValidationPanel issues={validationIssues} />
        )}
      </CardContent>

      <CardFooter className="flex justify-between border-t pt-4">
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || isValidating || isSaving}
          >
            Reset
          </Button>
          <Button
            variant="secondary"
            onClick={handleValidate}
            disabled={isValidating || isSaving}
          >
            {isValidating ? "Validating..." : "Validate"}
          </Button>
        </div>
        <Button
          onClick={handleSave}
          disabled={isValidating || isSaving || (isRecoveryMode && validationIssues.length > 0)}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </CardFooter>
    </Card>
  );
}
