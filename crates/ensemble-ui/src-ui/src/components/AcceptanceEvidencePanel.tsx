import type { AcceptanceAttempt, AcceptanceOutput, AcceptanceResult } from "@/generated/models";
import { Badge } from "@/components/ui/badge";

interface AcceptanceEvidencePanelProps {
  attempts: AcceptanceAttempt[];
}

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function Timing({ result }: { result: AcceptanceResult }) {
  if (result.timing?.kind !== "observed") {
    return <div className="text-xs text-muted-foreground">Timing unknown</div>;
  }

  return <div className="text-xs text-muted-foreground">Observed: {result.timing.duration_ms.toLocaleString()} ms</div>;
}

function CommandEvidence({ result }: { result: AcceptanceResult }) {
  if (result.evidence.kind !== "command") return null;
  const { exit_code, stderr, stdout } = result.evidence;
  return (
    <div className="space-y-2 text-sm">
      <div>Exit code: {exit_code ?? "unavailable"}</div>
      <OutputEvidence label="stdout" output={stdout} />
      <OutputEvidence label="stderr" output={stderr} />
    </div>
  );
}

function OutputEvidence({
  label,
  output,
}: {
  label: string;
  output: AcceptanceOutput;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">
        {label} ({output.total_bytes.toLocaleString()} bytes){output.truncated ? ", truncated" : ""}
      </div>
      {output.tail ? <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">{output.tail}</pre> : null}
    </div>
  );
}

function Evidence({ result }: { result: AcceptanceResult }) {
  switch (result.evidence.kind) {
    case "command":
      return <CommandEvidence result={result} />;
    case "file":
      return (
        <div className="space-y-1 text-sm">
          <div>{result.evidence.repo}: {result.evidence.path}</div>
          <div>File observation: {result.evidence.observation}</div>
        </div>
      );
    case "handoff":
      return (
        <div className="space-y-1 text-sm">
          <div>Step: {result.evidence.step}</div>
          <div>
            Output observation: {result.evidence.output.kind}
            {result.evidence.output.kind === "non_object" ? ` (${result.evidence.output.value_kind})` : ""}
          </div>
          {result.evidence.sections.map((section) => (
            <div key={section.name}>{section.name}: {section.observation}</div>
          ))}
        </div>
      );
    case "pull_request": {
      const url = safeExternalUrl(result.evidence.pr_url);
      return (
        <div className="space-y-1 text-sm">
          <div>Repository: {result.evidence.repo}</div>
          <div>Delivery phase: {result.evidence.delivery_phase}</div>
          {result.evidence.base_branch ? <div>Base: {result.evidence.base_branch}</div> : null}
          {result.evidence.head_branch ? <div>Head: {result.evidence.head_branch}</div> : null}
          {result.evidence.head_sha ? <div>Head SHA: {result.evidence.head_sha}</div> : null}
          {url && result.evidence.pr_number != null ? (
            <a className="text-primary underline" href={url} target="_blank" rel="noreferrer">
              PR #{result.evidence.pr_number}
            </a>
          ) : result.evidence.pr_number != null ? (
            <div>PR #{result.evidence.pr_number}</div>
          ) : null}
        </div>
      );
    }
  }
}

export function AcceptanceEvidencePanel({ attempts }: AcceptanceEvidencePanelProps) {
  if (attempts.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
        <p>No acceptance evidence has been recorded.</p>
        <p className="mt-1">No acceptance outcome is implied.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Results are shown exactly as recorded. No outcome is inferred for checks that were not recorded.
      </p>
      {attempts.map((attempt) => (
        <section key={attempt.cycle} className="space-y-3" aria-label={`Acceptance cycle ${attempt.cycle}`}>
          <h3 className="font-semibold">Cycle {attempt.cycle}</h3>
          {attempt.results.length === 0 ? (
            <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              No results were recorded for this cycle.
            </p>
          ) : (
            attempt.results.map((result, index) => (
              <article key={`${result.name}-${index}`} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="font-medium">{result.name}</h4>
                    <p className="text-sm text-muted-foreground">{result.summary}</p>
                  </div>
                  <Badge variant={result.status === "failed" ? "destructive" : "outline"}>
                    {result.status}
                  </Badge>
                </div>
                <Timing result={result} />
                <Evidence result={result} />
              </article>
            ))
          )}
        </section>
      ))}
    </div>
  );
}
