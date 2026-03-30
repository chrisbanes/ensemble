import { useConfigQuery } from "../api";

export default function ConfigStatus() {
  const { data, isLoading, isError } = useConfigQuery();

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading configuration...</div>;
  }

  if (isError) {
    return <div className="text-center py-12 text-red-600 dark:text-red-400">Failed to load configuration.</div>;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Configuration</h1>

      {/* Validation banner */}
      <div className={`rounded-lg p-4 ${data.valid ? "bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800" : "bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800"}`}>
        <div className="flex items-center gap-2">
          <span className={`text-lg ${data.valid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {data.valid ? "\u2713" : "\u2717"}
          </span>
          <span className={`font-medium ${data.valid ? "text-green-800 dark:text-green-200" : "text-red-800 dark:text-red-200"}`}>
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
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Config file: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{data.config_path}</code>
        </p>
      </div>

      {/* Agents table */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Agents</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Command</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Model</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Max Turns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {data.agents.map((agent) => (
                <tr key={agent.name}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{agent.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{agent.command}</code>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{agent.model}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{agent.max_turns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Pipeline steps */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Pipeline Steps</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <div className="flex flex-wrap items-center gap-2">
            {data.pipeline.steps.map((step, idx) => (
              <div key={step.name} className="flex items-center gap-2">
                <div className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-lg px-3 py-2 text-sm">
                  <span className="font-medium">{step.name}</span>
                  <span className="ml-1 text-xs text-blue-600 dark:text-blue-400">({step.agent})</span>
                  {step.depends.length > 0 && (
                    <span className="ml-1 text-xs text-blue-500 dark:text-blue-300">
                      after {step.depends.join(", ")}
                    </span>
                  )}
                </div>
                {idx < data.pipeline.steps.length - 1 && (
                  <span className="text-gray-400 dark:text-gray-500">&rarr;</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Runtime settings */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Runtime Settings</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Max Concurrent</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{data.runtime.max_concurrent}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Max Retries</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{data.runtime.max_retries}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Poll Interval</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{data.runtime.poll_interval_seconds}s</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Workspace Root</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">
                <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{data.runtime.workspace_root}</code>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Tracker</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{data.runtime.tracker}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Server Port</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{data.runtime.server_port}</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}
