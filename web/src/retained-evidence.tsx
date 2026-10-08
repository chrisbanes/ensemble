import { useCallback } from "react";
import {
  retainedEvidenceItemContentReadSchema,
  retainedResultEvidenceReadSchema,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { FilePreviewBody } from "./task-files.js";
import type {
  RetainedEvidenceState,
  TaskFilesState,
} from "./task-workspace-state.js";

const time = (value: number | null) =>
  value === null ? "not observed" : new Date(value).toLocaleString();

function retainedScope(repositoryId: string | null): TaskFilesState["scope"] {
  return repositoryId
    ? { kind: "repository", repositoryId }
    : { kind: "workspace" };
}

/** Original bytes recorded with one result; current workspace bytes are never substituted. */
export function RetainedResultEvidence({
  client,
  session,
  taskId,
  resultId,
  state,
  changed,
  openCurrent,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  resultId: string;
  state: RetainedEvidenceState;
  changed: () => void;
  openCurrent: (scope: TaskFilesState["scope"], path: string[]) => void;
}) {
  const base = `/api/operator/tasks/${taskId}/results/${resultId}/evidence`;
  const evidenceLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(base, retainedResultEvidenceReadSchema, signal),
    [client, base],
  );
  const evidence = useOperatorResource(
    `${session.csrfToken}:${base}`,
    evidenceLoader,
  );
  const itemId = state.selectedItemId;
  const itemLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `${base}/${itemId}`,
        retainedEvidenceItemContentReadSchema,
        signal,
      ),
    [client, base, itemId],
  );
  const item = useOperatorResource(
    itemId ? `${session.csrfToken}:${base}/${itemId}` : null,
    itemLoader,
  );
  const data = evidence.state.data?.data;
  const content =
    item.state.data?.data.itemId === itemId ? item.state.data.data : null;

  return (
    <section
      className="retained-evidence"
      aria-labelledby={`retained-${resultId}`}
    >
      <h4 id={`retained-${resultId}`}>Retained result evidence</h4>
      {evidence.state.pending && !data && (
        <p role="status">Reading retained evidence…</p>
      )}
      {evidence.state.error && !data && (
        <p role="alert">Retained evidence could not be read. Retry later.</p>
      )}
      {data?.state === "unavailable" && (
        <p role="status">
          Retained evidence is unavailable for this result ({data.reason}).
          Current workspace bytes are not substituted.
        </p>
      )}
      {data && data.state !== "unavailable" && (
        <>
          <p className="file-observation">
            Retained result evidence · result {data.resultId} · captured{" "}
            {time(data.capturedAt)} · <StatusBadge>{data.state}</StatusBadge>
          </p>
          {data.state !== "available" && data.state !== "empty" && (
            <p role="status">
              Retained evidence is {data.state}; missing items stay identified
              and are not backfilled from later bytes.
            </p>
          )}
          <details>
            <summary>Capture provenance</summary>
            <dl className="retained-provenance">
              <dt>Assignment</dt>
              <dd>
                {data.identity.assignmentId} · version{" "}
                {data.identity.assignmentVersion}
              </dd>
              <dt>Work</dt>
              <dd>
                {data.identity.workId} · revision {data.identity.workRevision}
              </dd>
              <dt>Turn</dt>
              <dd>
                {data.identity.threadId} / {data.identity.turnId}
              </dd>
              <dt>Task version</dt>
              <dd>
                {data.identity.captureTaskVersion} at capture ·{" "}
                {data.identity.taskVersion} at result
              </dd>
              <dt>Source observation</dt>
              <dd>
                {data.sourceObservation.captureState}
                {data.sourceObservation.outcome
                  ? ` · ${data.sourceObservation.outcome}`
                  : ""}
                {data.sourceObservation.comparisonId
                  ? ` · comparison ${data.sourceObservation.comparisonId}`
                  : ""}{" "}
                · observed {time(data.sourceObservation.observedAt)}
              </dd>
            </dl>
          </details>
          {data.items.length === 0 ? (
            <p>No file or diff evidence was retained with this result.</p>
          ) : (
            <ul className="retained-items" aria-label="Retained evidence items">
              {data.items.map((entry) => (
                <li key={entry.itemId}>
                  {entry.state === "available" ? (
                    <Button
                      variant={
                        entry.itemId === itemId ? "primary" : "secondary"
                      }
                      aria-pressed={entry.itemId === itemId}
                      title={`${entry.repositoryId ?? "Task workspace"}/${entry.path}`}
                      onClick={() => {
                        state.selectedItemId = entry.itemId;
                        changed();
                      }}
                    >
                      {entry.kind} · {entry.path} ·{" "}
                      {entry.size.toLocaleString()} bytes
                    </Button>
                  ) : (
                    <span>
                      {entry.kind} {entry.state}: {entry.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {itemId && item.state.pending && !content && (
            <p role="status">Reading retained bytes…</p>
          )}
          {itemId && item.state.error && !content && (
            <p role="alert">Retained item could not be read. Retry later.</p>
          )}
          {content && content.state !== "available" && (
            <p role="status">
              Retained item is {content.state} ({content.reason}). Current bytes
              are not substituted.
            </p>
          )}
          {content?.state === "available" && (
            <div className="retained-preview">
              <p className="file-observation">
                Original {content.item.kind} ·{" "}
                {content.item.repositoryId ?? "task workspace"}/
                {content.item.path} · captured {time(content.item.capturedAt)}
              </p>
              <FilePreviewBody
                data={content.preview}
                name={content.item.path}
                tab={state.tab(
                  content.itemId,
                  retainedScope(content.item.repositoryId),
                  content.item.path.split("/"),
                )}
                changed={changed}
              />
              {content.item.kind === "file" && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    openCurrent(
                      retainedScope(content.item.repositoryId),
                      content.item.path.split("/"),
                    )
                  }
                >
                  Open current file in Files
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
