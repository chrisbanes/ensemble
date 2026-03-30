import { useConfigQuery } from "@/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export default function ConfigStatus() {
  const { data, isLoading, isError } = useConfigQuery();

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-destructive">Failed to load configuration.</div>;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Configuration</h1>

      {/* Validation banner */}
      <div className={cn(
        "rounded-lg p-4 border",
        data.valid
          ? "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800"
          : "bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800",
      )}>
        <div className="flex items-center gap-2">
          <span className={cn("text-lg", data.valid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
            {data.valid ? "\u2713" : "\u2717"}
          </span>
          <span className={cn("font-medium", data.valid ? "text-green-800 dark:text-green-200" : "text-red-800 dark:text-red-200")}>
            {data.valid ? "Configuration is valid" : "Configuration has errors"}
          </span>
        </div>
        {data.errors.length > 0 && (
          <ul className="mt-2 space-y-1">
            {data.errors.map((err, i) => (
              <li key={i} className="text-sm text-red-700 dark:text-red-300">{err}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Config file: <code className="bg-muted px-1 rounded">{data.config_path}</code>
        </p>
      </div>

      {/* Agents table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Agents</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Max Turns</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.agents.map((agent) => (
                <TableRow key={agent.name}>
                  <TableCell className="font-medium">{agent.name}</TableCell>
                  <TableCell><code className="bg-muted px-1 rounded text-sm">{agent.command}</code></TableCell>
                  <TableCell className="text-muted-foreground">{agent.model}</TableCell>
                  <TableCell className="text-muted-foreground">{agent.max_turns}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pipeline steps */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pipeline Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {data.pipeline.steps.map((step, idx) => (
              <div key={step.name} className="flex items-center gap-2">
                <Badge variant="secondary" className="px-3 py-1.5">
                  <span className="font-medium">{step.name}</span>
                  <span className="ml-1 opacity-70">({step.agent})</span>
                  {step.depends.length > 0 && (
                    <span className="ml-1 opacity-60">after {step.depends.join(", ")}</span>
                  )}
                </Badge>
                {idx < data.pipeline.steps.length - 1 && (
                  <span className="text-muted-foreground">&rarr;</span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Runtime settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Runtime Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Max Concurrent</dt>
              <dd className="text-sm">{data.runtime.max_concurrent}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Max Retries</dt>
              <dd className="text-sm">{data.runtime.max_retries}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Poll Interval</dt>
              <dd className="text-sm">{data.runtime.poll_interval_seconds}s</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Workspace Root</dt>
              <dd className="text-sm"><code className="bg-muted px-1 rounded">{data.runtime.workspace_root}</code></dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Tracker</dt>
              <dd className="text-sm">{data.runtime.tracker}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Server Port</dt>
              <dd className="text-sm">{data.runtime.server_port}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
