import type { RunArtifacts } from "@/generated/models";

function enforcementDescription(enforcement: string): string {
  switch (enforcement) {
    case "acpx_approve_reads":
      return "Immutable access enforced: ACPX approves reads.";
    case "acpx_deny_all":
      return "Immutable access enforced: ACPX denies all.";
    case "direct_acp_unsupported":
      return "Limitation: immutable access enforcement is unsupported for this runtime.";
    default:
      return `Immutable access enforcement: ${enforcement}.`;
  }
}

interface EvaluationEvidenceProps {
  artifacts: RunArtifacts;
}

export function EvaluationEvidence({ artifacts }: EvaluationEvidenceProps) {
  const gates = Object.entries(artifacts.gate_evidence ?? {});
  const accessEvidence = artifacts.artifact_access_evidence ?? [];
  const violations = artifacts.artifact_integrity_violations ?? [];
  if (gates.length === 0 && accessEvidence.length === 0 && violations.length === 0) return null;

  return (
    <section className="rounded-lg border bg-muted/20 p-3" aria-labelledby="evaluation-evidence-heading">
      <h3 id="evaluation-evidence-heading" className="font-medium">Evaluation evidence</h3>
      <div className="mt-2 space-y-3 text-xs">
        {gates.map(([gateStep, gate]) => (
          <section key={gateStep} className="rounded border bg-background p-2" aria-label={`${gateStep} gate evidence`}>
            <div className="font-medium">Gate: {gateStep}</div>
            <div className="mt-1 text-muted-foreground">Outcome: <span className="text-foreground">{gate.outcome}</span></div>
            {gate.human_resolution ? (
              <div className="text-muted-foreground">
                Human decision: <span className="text-foreground">{gate.human_resolution.decision}</span>
                {gate.human_resolution.reason ? <span> — {gate.human_resolution.reason}</span> : null}
              </div>
            ) : gate.outcome === "awaiting_human" ? (
              <div className="text-muted-foreground">Human decision: unresolved</div>
            ) : null}
            {Object.entries(gate.assessments).map(([sourceStep, assessment]) => (
              <section key={sourceStep} className="mt-2 rounded bg-muted/30 p-2" aria-label={`${sourceStep} assessment`}>
                <div className="font-medium">Assessment source: {sourceStep}</div>
                {assessment.findings.map((finding) => {
                  const disposition = gate.adjudication.dispositions.find(
                    (candidate) => candidate.source_step === sourceStep && candidate.finding_id === finding.id,
                  );
                  return (
                    <div key={finding.id} className="mt-1 text-muted-foreground">
                      <span className="text-foreground">{finding.id}: {finding.summary}</span>
                      {" — "}Severity: {finding.severity}; Disposition: {disposition?.disposition ?? "missing"}
                    </div>
                  );
                })}
              </section>
            ))}
          </section>
        ))}
        {accessEvidence.length > 0 ? (
          <section aria-label="Immutable access enforcement">
            <div className="font-medium">Immutable access enforcement</div>
            {accessEvidence.map((evidence) => (
              <div key={evidence.consumer_step} className="text-muted-foreground">
                {evidence.consumer_step}: {enforcementDescription(evidence.enforcement)}
              </div>
            ))}
          </section>
        ) : null}
        {violations.length > 0 ? (
          <section aria-label="Artifact integrity violations">
            <div className="font-medium text-destructive">Artifact integrity violations</div>
            {violations.map((violation) => (
              <div key={`${violation.consumer_step}:${violation.producer_step}:${violation.repository}`} className="text-muted-foreground">
                {violation.consumer_step} rejected {violation.producer_step} ({violation.repository}): {violation.changed_paths.join(", ")}
                {violation.omitted_changed_path_count > 0 ? ` and ${violation.omitted_changed_path_count} more path(s)` : ""}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}
