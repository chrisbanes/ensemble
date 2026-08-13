import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RunArtifacts, WorkflowStepInfo } from "@/generated/models";

interface ArtifactsPanelProps {
  identifier: string;
  workspacePath: string;
  artifacts?: RunArtifacts | null;
  workflowSteps: WorkflowStepInfo[];
}

export default function ArtifactsPanel({
  identifier,
  workspacePath,
  artifacts,
  workflowSteps,
}: ArtifactsPanelProps) {
  const effectiveWorkspace = artifacts?.workspace_path ?? workspacePath;
  const repos = artifacts?.repos ?? [];
  const transcripts = artifacts?.transcripts ?? [];
  const snapshots = artifacts?.artifact_snapshots ?? [];

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="font-medium">Workspace</div>
        <code className="mt-2 block rounded bg-background px-2 py-1 text-xs">
          {effectiveWorkspace}
        </code>
      </div>

      {repos.map((repo) => (
        <div key={repo.repo} className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium">{repo.repo}</div>
            <Badge variant="outline">{repo.finalize_status}</Badge>
          </div>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <div>
              Branch: <span className="text-foreground">{repo.branch}</span>
            </div>
            <div>
              Base: <span className="text-foreground">{repo.base_branch}</span>
            </div>
            {repo.head_sha ? (
              <div>
                HEAD: <span className="text-foreground">{repo.head_sha}</span>
              </div>
            ) : null}
            <div>
              Finalize: <span className="text-foreground">{repo.finalize_mode}</span>
            </div>
            {repo.pushed_ref ? (
              <div>
                Pushed: <span className="text-foreground">{repo.pushed_ref}</span>
              </div>
            ) : null}
          </div>
          {repo.pr_url ? (
            <a
              href={repo.pr_url}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Pull request
            </a>
          ) : null}
          {repo.changed_files.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {repo.changed_files.map((file) => (
                <li key={file}>
                  <code className="rounded bg-background px-1 py-0.5">{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {repo.last_error ? (
            <p className="mt-3 whitespace-pre-wrap text-xs text-destructive">
              {repo.last_error}
            </p>
          ) : null}
        </div>
      ))}

      {snapshots.length > 0 ? (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="font-medium">Artifact snapshots</div>
          <div className="mt-2 space-y-3">
            {snapshots.map((snapshot) => {
              const inspect = workflowSteps.find(
                (step) => step.name === snapshot.producer_step,
              )?.capabilities.inspect;
              return (
                <section key={snapshot.identity} className="rounded border bg-background p-2 text-xs">
                  {inspect?.enabled ? (
                    <Link
                      to={`/issue/${encodeURIComponent(identifier)}/step/${encodeURIComponent(snapshot.producer_step)}`}
                      aria-label={`Producer step: ${snapshot.producer_step}`}
                      className="font-medium text-primary underline"
                    >
                      {snapshot.producer_step}
                    </Link>
                  ) : (
                    <div className="font-medium text-muted-foreground">
                      {snapshot.producer_step}: {inspect?.disabled_reason ?? "Step inspection is unavailable."}
                    </div>
                  )}
                  <dl className="mt-2 grid gap-1 text-muted-foreground">
                    <div>Identity: <code className="text-foreground">{snapshot.identity}</code></div>
                    <div>Output digest: <code className="text-foreground">{snapshot.output_digest}</code></div>
                    <div>Cycle {snapshot.cycle}, attempt {snapshot.attempt}</div>
                    {snapshot.repositories.map((repository) => (
                      <div key={repository.repository} className="rounded bg-muted/30 p-1">
                        <div>
                          {repository.repository}: <span className="text-foreground">{repository.head}</span>
                        </div>
                        <div>Index digest: <code className="text-foreground">{repository.index_digest}</code></div>
                        <div>Worktree digest: <code className="text-foreground">{repository.tracked_worktree_digest}</code></div>
                        {repository.untracked_paths.length > 0 ? (
                          <div>Untracked: {repository.untracked_paths.join(", ")}</div>
                        ) : null}
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
        </div>
      ) : null}

      {transcripts.length > 0 ? (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="font-medium">Step transcripts</div>
          <div className="mt-2 space-y-2">
            {transcripts.map((transcript) => (
              <Link
                key={transcript.step_name}
                to={`/issue/${encodeURIComponent(identifier)}/step/${encodeURIComponent(
                  transcript.step_name,
                )}`}
                className="flex items-center justify-between rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                <span>{transcript.step_name}</span>
                <span className="text-muted-foreground">
                  {transcript.record_count} records
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
