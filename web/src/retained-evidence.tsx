import { useCallback, useMemo } from "react";
import { z } from "zod";
import {
  retainedEvidenceItemContentReadSchema,
  retainedResultEvidenceReadSchema,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import {
  DiffHunk,
  DiffLayoutControls,
  type DiffHunkData,
} from "./diff-view.js";
import { useOperatorResource } from "./resource.js";
import { resultEvidenceAnchor } from "./review-anchor.js";
import { FilePreviewBody } from "./task-files.js";
import type {
  RetainedEvidenceState,
  TaskFilesState,
} from "./task-workspace-state.js";

const time = (value: number | null) =>
  value === null ? "not observed" : new Date(value).toLocaleString();

const diffSideSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }),
  z.object({ state: z.literal("text"), text: z.string() }),
]);
/** Payload of a `workspace-diff+json` item: the complete Before and After texts. */
const retainedDiffSchema = z.object({
  version: z.literal(1),
  repositoryId: z.string().nullable(),
  path: z.string(),
  previousPath: z.string().optional(),
  left: diffSideSchema,
  right: diffSideSchema,
});
type RetainedDiff = z.infer<typeof retainedDiffSchema>;

const maxDiffLines = 5_000;

const textLines = (side: RetainedDiff["left"]) =>
  side.state === "absent" || side.text === ""
    ? []
    : side.text.replace(/\n$/, "").split("\n");

// ponytail: above this many LCS cells the changed middle is shown as one replaced block.
const maxLcsCells = 1_000_000;

/** Unified-patch rows for two line lists; each change run lists deletions before additions. */
function patchRows(before: string[], after: string[]) {
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const old = before.slice(head, before.length - tail);
  const next = after.slice(head, after.length - tail);
  const rows = before.slice(0, head).map((line) => ` ${line}`);
  let deleted: string[] = [];
  let added: string[] = [];
  const flush = () => {
    rows.push(...deleted, ...added);
    deleted = [];
    added = [];
  };
  if (old.length * next.length > maxLcsCells) {
    deleted = old.map((line) => `-${line}`);
    added = next.map((line) => `+${line}`);
  } else {
    const width = next.length + 1;
    const lcs = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--)
      for (let j = next.length - 1; j >= 0; j--)
        lcs[i * width + j] =
          old[i] === next[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(
                lcs[(i + 1) * width + j] ?? 0,
                lcs[i * width + j + 1] ?? 0,
              );
    let i = 0;
    let j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) {
        flush();
        rows.push(` ${old[i]}`);
        i++;
        j++;
      } else if (
        i < old.length &&
        (j === next.length ||
          (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
      )
        deleted.push(`-${old[i++]}`);
      else added.push(`+${next[j++]}`);
    }
  }
  flush();
  rows.push(...before.slice(before.length - tail).map((line) => ` ${line}`));
  return rows;
}

/** One hunk holding both complete sides. */
function retainedHunk(diff: RetainedDiff) {
  const before = textLines(diff.left);
  const after = textLines(diff.right);
  const rows = patchRows(before, after);
  const hunk: DiffHunkData = {
    oldStart: before.length ? 1 : 0,
    oldLines: before.length,
    newStart: after.length ? 1 : 0,
    newLines: after.length,
    patch: rows.slice(0, maxDiffLines).join("\n"),
  };
  return { hunk, omitted: Math.max(0, rows.length - maxDiffLines) };
}

/** Original Before and After of a retained diff. No review anchor exists for a diff. */
function RetainedDiffView({
  text,
  layout,
  onLayout,
}: {
  text: string;
  layout: "split" | "unified";
  onLayout: (layout: "split" | "unified") => void;
}) {
  const diff = useMemo(() => {
    try {
      const parsed = retainedDiffSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, [text]);
  const rendered = useMemo(() => (diff ? retainedHunk(diff) : null), [diff]);
  if (!diff || !rendered)
    return (
      <p role="alert">
        This retained diff could not be displayed because its recorded payload
        is not a recognised diff.
      </p>
    );
  const describe = (side: RetainedDiff["left"]) =>
    side.state === "absent"
      ? "absent (no file on this side)"
      : `${textLines(side).length.toLocaleString()} lines`;
  return (
    <div className="retained-diff">
      <p>
        {diff.previousPath ? `${diff.previousPath} → ` : ""}
        {diff.path} · Before {describe(diff.left)} · After{" "}
        {describe(diff.right)}
      </p>
      <p className="muted" role="note">
        Review comments cannot be added to a retained diff. The service anchors
        retained result evidence to retained file bytes only.
      </p>
      <DiffLayoutControls layout={layout} onChange={onLayout} />
      <DiffHunk hunk={rendered.hunk} hunkIndex={0} layout={layout} />
      {rendered.omitted > 0 && (
        <p role="status">
          Showing the first {maxDiffLines.toLocaleString()} diff lines;{" "}
          {rendered.omitted.toLocaleString()} more are not displayed.
        </p>
      )}
    </div>
  );
}

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
              {content.item.kind === "diff" ? (
                content.preview.kind === "text" ? (
                  <>
                    <p>
                      {content.preview.mime} ·{" "}
                      {content.preview.size.toLocaleString()} bytes · SHA-256{" "}
                      {content.preview.sha256}
                    </p>
                    <RetainedDiffView
                      text={content.preview.text}
                      layout={state.diffLayout}
                      onLayout={(layout) => {
                        state.diffLayout = layout;
                        changed();
                      }}
                    />
                  </>
                ) : (
                  <p role="alert">This retained diff could not be displayed.</p>
                )
              ) : (
                <FilePreviewBody
                  data={content.preview}
                  name={content.item.path}
                  tab={state.tab(
                    content.itemId,
                    retainedScope(content.item.repositoryId),
                    content.item.path.split("/"),
                  )}
                  changed={changed}
                  comment={{
                    originKey: `retained:${content.itemId}`,
                    label: `retained result ${data.resultId}`,
                    anchorFor: (startLine, endLine, contentSha256) =>
                      resultEvidenceAnchor(
                        taskId,
                        { resultId: data.resultId, ...data.identity },
                        content.item,
                        { startLine, endLine },
                        contentSha256,
                      ),
                  }}
                />
              )}
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
