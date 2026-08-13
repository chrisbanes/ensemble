import { Link } from "react-router-dom";
import type { IssueDetailSnapshot } from "@/generated/models";
import { AcceptanceEvidencePanel } from "./AcceptanceEvidencePanel";
import ArtifactsPanel from "./ArtifactsPanel";

type ReviewGateData = Pick<
  IssueDetailSnapshot,
  | "issue_identifier"
  | "finalize"
  | "workflow_steps"
  | "acceptance_attempts"
  | "artifacts"
  | "workspace"
>;

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function deliverySummary(observation: NonNullable<ReviewGateData["finalize"]["repos"][number]["observation"]>): string {
  const facts = observation.facts;
  if (observation.freshness === "stale") {
    return "Delivery observation is stale. No readiness outcome is implied.";
  }
  if (observation.failure) {
    return `${observation.failure.message} No readiness outcome is implied.`;
  }
  if (!facts) {
    return "Delivery observation is unavailable. No readiness outcome is implied.";
  }
  if (facts.terminal_state === "merged") return "Pull request is merged.";
  if (facts.terminal_state === "closed_without_merge") return "Pull request closed without merge.";
  if (facts.head_diverged || !facts.matches_delivery) {
    return "Delivery head diverged. No readiness outcome is implied.";
  }
  if (facts.check_summary === "failing") return "Checks are failing.";
  if (facts.review_decision === "changes_requested") return "Changes were requested.";
  if (facts.mergeability === "conflicting") return "Pull request has merge conflicts.";
  if (facts.base_freshness === "behind") return "Pull request branch is behind its base.";
  return "Delivery evidence is current. No readiness outcome is implied.";
}

function DeliveryObservation({ data }: { data: ReviewGateData }) {
  const finalizedRepositories = data.finalize.repos.map((repo) => ({
    repo: repo.repo,
    status: repo.status,
    observation: repo.observation,
  }));
  const finalizedRepositoryNames = new Set(finalizedRepositories.map((repo) => repo.repo));
  const artifactRepositories = (data.artifacts?.repos ?? [])
    .filter((repo) => !finalizedRepositoryNames.has(repo.repo))
    .map((repo) => ({
      repo: repo.repo,
      status: repo.finalize_status,
      observation: repo.observation,
    }));
  const deliveryRepositories = [...finalizedRepositories, ...artifactRepositories];

  if (deliveryRepositories.length === 0) {
    return (
      <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
        Delivery observation is unavailable. No readiness outcome is implied.
      </p>
    );
  }

  return deliveryRepositories.map((repo) => {
    const observation = repo.observation;
    if (!observation) {
      return (
        <section key={repo.repo} className="space-y-2 rounded-lg border p-3" aria-label={`${repo.repo} delivery review`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{repo.repo}</h3>
            <span className="text-sm text-muted-foreground">Finalize: {repo.status}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Delivery observation is unavailable. No readiness outcome is implied.
          </p>
        </section>
      );
    }
    const facts = observation.facts;
    const pullRequestUrl = facts ? safeExternalUrl(facts.pull_request_url) : null;

    return (
      <section key={repo.repo} className="space-y-2 rounded-lg border p-3" aria-label={`${repo.repo} delivery review`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{repo.repo}</h3>
          <span className="text-sm text-muted-foreground">Finalize: {repo.status}</span>
        </div>
        <dl className="grid gap-1 text-sm text-muted-foreground">
          <div>Observation: <span className="text-foreground">{observation.freshness}</span></div>
          <div className="text-amber-700 dark:text-amber-400">{deliverySummary(observation)}</div>
          {facts ? (
            <>
              <div>Checks: <span className="text-foreground">{facts.check_summary}</span></div>
              <div>Review: <span className="text-foreground">{facts.review_decision}</span></div>
              <div>Merge: <span className="text-foreground">{facts.terminal_state}</span></div>
              <div>Mergeability: <span className="text-foreground">{facts.mergeability}</span></div>
              <div>Base: <span className="text-foreground">{facts.base_freshness}</span></div>
              {facts.checks.map((check) => (
                <div key={check.name}>{check.name}: {check.conclusion ?? check.status}</div>
              ))}
              {pullRequestUrl ? (
                <a className="text-primary underline" href={pullRequestUrl} target="_blank" rel="noreferrer">
                  PR #{facts.pull_request_number}
                </a>
              ) : null}
            </>
          ) : null}
          {observation.failure ? <div className="text-destructive">{observation.failure.message}</div> : null}
          {observation.retry ? <div>Retry due: {new Date(observation.retry.due_at).toLocaleString()}</div> : null}
        </dl>
      </section>
    );
  });
}

function WorkflowVerdicts({ data }: { data: ReviewGateData }) {
  return (
    <section className="space-y-2" aria-labelledby="workflow-verdicts-heading">
      <h3 id="workflow-verdicts-heading" className="font-medium">Workflow verdicts</h3>
      {data.workflow_steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workflow verdicts are available.</p>
      ) : (
        data.workflow_steps.map((step) => {
          const inspect = step.capabilities.inspect;
          const detail = `${step.name}: ${step.state}`;
          return inspect.enabled ? (
            <Link
              key={step.name}
              to={`/issue/${encodeURIComponent(data.issue_identifier)}/step/${encodeURIComponent(step.name)}`}
              aria-label={`Review step: ${step.name}`}
              className="flex justify-between rounded-lg border p-3 text-sm hover:bg-muted"
            >
              <span>{detail}</span>
              <span className="text-muted-foreground">View detail</span>
            </Link>
          ) : (
            <div key={step.name} className="rounded-lg border p-3 text-sm text-muted-foreground">
              {detail}: {inspect.disabled_reason ?? "Step inspection is unavailable."}
            </div>
          );
        })
      )}
    </section>
  );
}

export function ReviewGatePanel({ data }: { data: ReviewGateData }) {
  return (
    <div className="space-y-4">
      <section className="space-y-2" aria-labelledby="delivery-review-heading">
        <h2 id="delivery-review-heading" className="font-semibold">Delivery review</h2>
        <DeliveryObservation data={data} />
      </section>
      <WorkflowVerdicts data={data} />
      <section className="space-y-2" aria-labelledby="acceptance-evidence-heading">
        <h3 id="acceptance-evidence-heading" className="font-medium">Acceptance evidence</h3>
        <AcceptanceEvidencePanel attempts={data.acceptance_attempts} />
      </section>
      {data.artifacts ? (
        <section className="space-y-2" aria-labelledby="artifact-context-heading">
          <h3 id="artifact-context-heading" className="font-medium">Artifact context</h3>
          <ArtifactsPanel
            identifier={data.issue_identifier}
            workspacePath={data.workspace.path}
            artifacts={data.artifacts}
            workflowSteps={data.workflow_steps}
          />
        </section>
      ) : null}
    </div>
  );
}
