import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RunArtifacts } from "@/generated/models";

interface ArtifactsPanelProps {
  identifier: string;
  workspacePath: string;
  artifacts?: RunArtifacts | null;
}

export default function ArtifactsPanel({
  identifier,
  workspacePath,
  artifacts,
}: ArtifactsPanelProps) {
  const effectiveWorkspace = artifacts?.workspace_path ?? workspacePath;
  const repos = artifacts?.repos ?? [];
  const transcripts = artifacts?.transcripts ?? [];

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
