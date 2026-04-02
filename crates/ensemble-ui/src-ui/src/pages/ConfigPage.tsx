import { useConfigStateQuery } from "@/hooks";
import type { ValidationIssue } from "@/generated/models";

export default function ConfigPage() {
  const { data, isLoading, isError } = useConfigStateQuery();

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-destructive">Failed to load configuration.</div>;
  }

  if (!data) return null;

  const { state, issues, active_config: config } = data;
  const hasIssues = issues.length > 0;
  const isRunnable = state === "parsed" && config != null && !hasIssues;

  // Missing config - show setup mode
  if (state === "missing") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="rounded-lg p-6 border bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800">
          <h2 className="text-xl font-semibold text-red-800 dark:text-red-200">Set up Ensemble</h2>
          <p className="mt-2 text-red-700 dark:text-red-300">
            No configuration file found at <code className="bg-red-100 dark:bg-red-800 px-1 rounded">{data.config_path}</code>
          </p>
          <p className="mt-4 text-muted-foreground">
            Use the setup wizard to create your initial configuration.
          </p>
        </div>
      </div>
    );
  }

  // Syntax error - show YAML recovery placeholder
  if (state === "syntax_error") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="rounded-lg p-6 border bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800">
          <h2 className="text-xl font-semibold text-yellow-800 dark:text-yellow-200">YAML Syntax Error</h2>
          <p className="mt-2 text-yellow-700 dark:text-yellow-300">
            The configuration file has syntax errors that prevent parsing.
          </p>
          {issues.length > 0 && (
            <ul className="mt-4 space-y-2">
              {issues.map((issue: ValidationIssue, i: number) => (
                <li key={i} className="text-sm text-red-600 dark:text-red-400">{issue.message}</li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-muted-foreground">
            Edit the raw YAML to fix the syntax errors.
          </p>
        </div>
      </div>
    );
  }

  // Parsed with validation issues - show edit mode with validation panel
  if (state === "parsed" && hasIssues) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="rounded-lg p-6 border bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800">
          <h2 className="text-xl font-semibold text-yellow-800 dark:text-yellow-200">Configuration Issues</h2>
          <ul className="mt-4 space-y-2">
            {issues.map((issue: ValidationIssue, i: number) => (
              <li key={i} className="text-sm text-red-600 dark:text-red-400">{issue.message}</li>
            ))}
          </ul>
          <p className="mt-4 text-muted-foreground">
            Edit the configuration to resolve these validation issues.
          </p>
        </div>
      </div>
    );
  }

  // Runnable config - show edit mode with full tabs
  if (isRunnable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="rounded-lg p-6 border bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800">
          <h2 className="text-xl font-semibold text-green-800 dark:text-green-200">Configuration Editor</h2>
          <p className="mt-2 text-green-700 dark:text-green-300">
            Configuration is valid and ready to use.
          </p>
          <div className="mt-4 flex gap-2 text-sm">
            <span className="px-2 py-1 rounded bg-green-200 dark:bg-green-700">Guided</span>
            <span className="px-2 py-1 rounded bg-gray-200 dark:bg-gray-700">YAML</span>
            <span className="px-2 py-1 rounded bg-gray-200 dark:bg-gray-700">Validation</span>
          </div>
        </div>
      </div>
    );
  }

  // Fallback for any other state
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Configuration</h1>
      <div className="rounded-lg p-6 border bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">Unknown State</h2>
        <p className="mt-2 text-muted-foreground">
          Configuration state: <code>{state}</code>
        </p>
      </div>
    </div>
  );
}
