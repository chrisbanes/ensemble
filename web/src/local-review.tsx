import { createContext, useCallback, useContext } from "react";
import {
  localReviewDraftReadSchema,
  localReviewOperationReadSchema,
  retainedReviewAnchorReadSchema,
  type CommandReceipt,
  type Session,
} from "../../src/operator/contracts.js";
import type { CommandState, OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import type {
  LocalReviewSend,
  LocalReviewState,
  ReviewAnchorCandidate,
} from "./task-workspace-state.js";
import { Textarea } from "./ui/textarea.js";

type Lead = { assignmentId: string; version: number; name: string };
type DraftRead = ReturnType<typeof localReviewDraftReadSchema.parse>["data"];

const sendStorageKey = (taskId: string) =>
  `ensemble:local-review-send:${taskId}`;

/** Frozen send identity survives reload; it carries no comment text. */
function storeSend(taskId: string, send: LocalReviewSend | null) {
  try {
    if (send && (send.status === "sending" || send.status === "unknown"))
      sessionStorage.setItem(sendStorageKey(taskId), JSON.stringify(send));
    else sessionStorage.removeItem(sendStorageKey(taskId));
  } catch {
    // Storage is a convenience; the server operation remains authoritative.
  }
}

function restoredSend(taskId: string): LocalReviewSend | null {
  try {
    const raw = sessionStorage.getItem(sendStorageKey(taskId));
    if (!raw) return null;
    const value = JSON.parse(raw) as LocalReviewSend;
    return typeof value.key === "string"
      ? { ...value, status: "unknown" }
      : null;
  } catch {
    return null;
  }
}

function useLocalReviewController({
  client,
  session,
  taskId,
  state,
  changed,
  lead,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  state: LocalReviewState;
  changed: () => void;
  lead: Lead | null;
}) {
  const draftPath = `/api/operator/tasks/${taskId}/review-draft`;
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(draftPath, localReviewDraftReadSchema, signal),
    [client, draftPath],
  );
  const resource = useOperatorResource(
    `${session.csrfToken}:${draftPath}`,
    loader,
  );
  const draft = resource.state.data?.data ?? null;
  if (!state.send) {
    const restored = restoredSend(taskId);
    if (restored) state.send = restored;
  }

  const execute = async (input: Parameters<OperatorClient["command"]>[0]) =>
    client.command(input, session.csrfToken);
  const failure = (result: CommandState) =>
    result.state === "recorded" ? "" : (result.code ?? result.state);

  const saveDraft = async (
    content: DraftRead["draft"],
    expectedDraftVersion: number,
  ) => {
    const result = await execute({
      type: "review.draft.save",
      key: crypto.randomUUID(),
      taskId,
      expectedDraftVersion,
      draft: content,
    });
    await resource.refresh();
    return result;
  };

  const settleSend = (send: LocalReviewSend, result: CommandState) => {
    if (result.state === "recorded") {
      const receipt = result.receipt as Extract<
        CommandReceipt,
        { kind: "local-review-operation" }
      >;
      send.status =
        receipt.state === "prepared"
          ? "unknown"
          : (receipt.state as LocalReviewSend["status"]);
    } else if (
      result.state === "unknown" ||
      result.code === "unavailable" ||
      result.code === "command-outcome-unknown"
    ) {
      send.status = "unknown";
    } else {
      send.status = "rejected";
      send.reason = result.code ?? result.state;
    }
    if (send.status === "recorded") state.inspectKey = send.key;
    storeSend(taskId, send);
  };

  return {
    draft,
    resource,
    lead,
    open(originKey: string, label: string, anchor: ReviewAnchorCandidate) {
      state.composer = {
        originKey,
        label,
        anchor,
        body: "",
        error: "",
        saving: false,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      };
      changed();
    },
    close() {
      const composer = state.composer;
      state.composer = null;
      changed();
      // The trigger may re-render; prefer the live control for the same origin.
      requestAnimationFrame(() => {
        const live = composer
          ? document.querySelector<HTMLElement>(
              `[data-review-origin="${CSS.escape(composer.originKey)}"]`,
            )
          : null;
        const target = live ?? composer?.returnFocus;
        if (target?.isConnected) target.focus();
      });
    },
    async saveComposer() {
      const composer = state.composer;
      if (!composer || !draft || composer.saving || !composer.body.trim())
        return;
      composer.saving = true;
      composer.error = "";
      changed();
      const staged = await execute({
        type: "review.anchor.stage",
        key: crypto.randomUUID(),
        taskId,
        expectedDraftVersion: draft.version,
        anchors: [composer.anchor],
      });
      if (
        staged.state !== "recorded" ||
        staged.receipt.kind !== "local-review-anchor"
      ) {
        // Keep the typed text; an unvalidated anchor is never added.
        composer.saving = false;
        composer.error = `The exact lines could not be captured (${failure(staged)}). Your comment is kept.`;
        await resource.refresh();
        changed();
        return;
      }
      const saved = await saveDraft(
        {
          summary: draft.draft.summary,
          comments: [
            ...draft.draft.comments,
            {
              commentId: crypto.randomUUID(),
              body: composer.body.trim(),
              anchorGroupIds: [staged.receipt.groupId],
            },
          ],
        },
        staged.receipt.draftVersion,
      );
      if (saved.state !== "recorded") {
        composer.saving = false;
        composer.error = `The comment could not be saved (${failure(saved)}). Your comment is kept.`;
        changed();
        return;
      }
      this.close();
    },
    async updateComment(commentId: string, body: string | null) {
      if (!draft) return;
      state.pending = true;
      changed();
      const result = await saveDraft(
        {
          summary: draft.draft.summary,
          comments: draft.draft.comments.flatMap((comment) =>
            comment.commentId !== commentId
              ? [comment]
              : body === null
                ? []
                : [{ ...comment, body: body.trim() }],
          ),
        },
        draft.version,
      );
      state.pending = false;
      if (result.state === "recorded") delete state.editing[commentId];
      state.notice =
        result.state === "recorded"
          ? ""
          : `Draft change failed (${failure(result)}). Your text is kept.`;
      changed();
    },
    async saveSummary() {
      if (!draft || state.summary === null) return;
      state.pending = true;
      changed();
      const result = await saveDraft(
        { summary: state.summary.trim(), comments: draft.draft.comments },
        draft.version,
      );
      state.pending = false;
      if (result.state === "recorded") state.summary = null;
      state.notice =
        result.state === "recorded"
          ? ""
          : `Summary could not be saved (${failure(result)}). Your text is kept.`;
      changed();
    },
    async send() {
      if (!draft || !lead || state.send) return;
      const send: LocalReviewSend = {
        key: crypto.randomUUID(),
        expectedDraftVersion: draft.version,
        recipientAssignmentId: lead.assignmentId,
        expectedAssignmentVersion: lead.version,
        recipientName: lead.name,
        status: "sending",
      };
      state.send = send;
      storeSend(taskId, send);
      changed();
      const result = await execute({
        type: "review.send",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      settleSend(send, result);
      await resource.refresh();
      changed();
    },
    async reconcile() {
      const send = state.send;
      if (!send || send.status !== "unknown") return;
      send.status = "sending";
      changed();
      // Same key and material only: reconciliation never sends an edited review.
      const result = await execute({
        type: "review.send.reconcile",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      settleSend(send, result);
      await resource.refresh();
      changed();
    },
    async startNew() {
      if (!draft) return;
      state.pending = true;
      changed();
      const result = await execute({
        type: "review.draft.discard",
        key: crypto.randomUUID(),
        taskId,
        expectedDraftVersion: draft.version,
      });
      state.pending = false;
      if (result.state === "recorded") {
        state.send = null;
        state.inspectKey = null;
        state.editing = {};
        state.summary = null;
        storeSend(taskId, null);
      }
      state.notice =
        result.state === "recorded"
          ? ""
          : `Draft could not be cleared (${failure(result)}).`;
      await resource.refresh();
      changed();
    },
    acknowledgeRejection() {
      state.send = null;
      storeSend(taskId, null);
      changed();
    },
  };
}

type Controller = ReturnType<typeof useLocalReviewController> & {
  state: LocalReviewState;
  changed: () => void;
  client: OperatorClient;
  session: Session;
  taskId: string;
};
const LocalReviewContext = createContext<Controller | null>(null);
export const useLocalReview = () => useContext(LocalReviewContext);

export function LocalReviewProvider({
  children,
  ...props
}: Parameters<typeof useLocalReviewController>[0] & {
  children: React.ReactNode;
}) {
  const controller = useLocalReviewController(props);
  return (
    <LocalReviewContext.Provider
      value={{
        ...controller,
        state: props.state,
        changed: props.changed,
        client: props.client,
        session: props.session,
        taskId: props.taskId,
      }}
    >
      {children}
    </LocalReviewContext.Provider>
  );
}

const frozen = (review: Controller) =>
  review.state.send !== null && review.state.send.status !== "rejected";

/** Opens the composer for one exact origin; disabled without a valid selection. */
export function CommentAction({
  originKey,
  label,
  anchor,
}: {
  originKey: string;
  label: string;
  anchor: ReviewAnchorCandidate | null;
}) {
  const review = useLocalReview();
  if (!review) return null;
  // Stays focusable while a composer is open so Cancel/Save can return focus here.
  const composing = review.state.composer !== null;
  return (
    <Button
      variant="secondary"
      disabled={
        !anchor ||
        !review.draft ||
        review.draft.state !== "editable" ||
        frozen(review)
      }
      aria-disabled={composing || undefined}
      data-review-origin={originKey}
      onClick={() =>
        anchor && !composing && review.open(originKey, label, anchor)
      }
    >
      Add review comment
    </Button>
  );
}

export function ReviewComposer({ originKey }: { originKey: string }) {
  const review = useLocalReview();
  const composer = review?.state.composer;
  if (!review || !composer || composer.originKey !== originKey) return null;
  const { anchor } = composer;
  return (
    <form
      className="review-composer"
      aria-label="Review comment"
      onSubmit={(event) => {
        event.preventDefault();
        void review.saveComposer();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          review.close();
        }
      }}
    >
      <p className="file-observation">
        Comment on {composer.label} · {anchor.repositoryId ?? "task workspace"}/
        {anchor.path} · lines {anchor.startLine}–{anchor.endLine}
        {anchor.side !== "file"
          ? ` · ${anchor.side === "left" ? "Before" : "After"}`
          : ""}
      </p>
      <details>
        <summary>Exact source</summary>
        <dl className="retained-provenance">
          <dt>Context</dt>
          <dd>{anchor.context}</dd>
          {anchor.comparisonId && (
            <>
              <dt>Comparison</dt>
              <dd>{anchor.comparisonId}</dd>
            </>
          )}
          {anchor.resultId && (
            <>
              <dt>Result</dt>
              <dd>
                {anchor.resultId} · item {anchor.resultItemId}
              </dd>
            </>
          )}
          {anchor.turnId && (
            <>
              <dt>Turn</dt>
              <dd>{anchor.turnId}</dd>
            </>
          )}
          <dt>Content</dt>
          <dd>SHA-256 {anchor.contentSha256}</dd>
        </dl>
      </details>
      <label htmlFor={`review-comment-${originKey}`}>Comment</label>
      <Textarea
        id={`review-comment-${originKey}`}
        autoFocus
        autoGrow
        maxLength={4000}
        value={composer.body}
        disabled={composer.saving}
        onChange={(event) => {
          composer.body = event.target.value;
          review.changed();
        }}
      />
      {composer.error && <p role="alert">{composer.error}</p>}
      <div className="task-actions">
        <Button
          type="submit"
          disabled={composer.saving || !composer.body.trim()}
        >
          {composer.saving ? "Saving comment…" : "Save comment"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={composer.saving}
          onClick={() => review.close()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AnchorContext({ anchorId }: { anchorId: string }) {
  const review = useLocalReview();
  const path = review
    ? `/api/operator/tasks/${review.taskId}/review-anchors/${anchorId}`
    : null;
  const client = review?.client;
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!client || !path) throw new Error("No review context");
      return client.read(path, retainedReviewAnchorReadSchema, signal);
    },
    [client, path],
  );
  const resource = useOperatorResource(
    review && path ? `${review.session.csrfToken}:${path}` : null,
    loader,
  );
  const data = resource.state.data?.data;
  if (!data)
    return resource.state.error ? (
      <p role="status">Original context could not be read.</p>
    ) : (
      <p role="status">Reading original context…</p>
    );
  if (data.state === "unavailable")
    return (
      <p role="status">
        Original context is unavailable ({data.reason}). Current bytes are not
        substituted.
      </p>
    );
  const a = data.anchor;
  const excerpt =
    data.state === "available" && data.preview.kind === "text"
      ? data.preview.text
      : null;
  return (
    <div className="review-anchor-context">
      <p className="file-observation">
        {a.repositoryId ?? "task workspace"}/{a.path} · lines {a.startLine}–
        {a.endLine} · {a.context}
        {a.side !== "file"
          ? ` · ${a.side === "left" ? "Before" : "After"}`
          : ""}{" "}
        ·{" "}
        <StatusBadge>
          {data.status === "unavailable" ? "unavailable" : data.status}
        </StatusBadge>
      </p>
      {excerpt !== null ? (
        <pre className="review-anchor-excerpt">
          <code>{excerpt}</code>
        </pre>
      ) : (
        <p role="status">
          Original excerpt is not available as text
          {data.state === "gap" && a.reason ? ` (${a.reason})` : ""}.
        </p>
      )}
    </div>
  );
}

function SentReview({ operationKey }: { operationKey: string }) {
  const review = useLocalReview();
  const path = review
    ? `/api/operator/tasks/${review.taskId}/local-reviews/${operationKey}`
    : null;
  const client = review?.client;
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!client || !path) throw new Error("No review context");
      return client.read(path, localReviewOperationReadSchema, signal);
    },
    [client, path],
  );
  const resource = useOperatorResource(
    review && path ? `${review.session.csrfToken}:${path}` : null,
    loader,
  );
  const data = resource.state.data?.data;
  if (!data)
    return resource.state.error ? (
      <p role="status">
        This sent review is unavailable or not authorised. Current drafts are
        not substituted.
      </p>
    ) : (
      <p role="status">Reading sent review…</p>
    );
  const groups = new Map((data.groups ?? []).map((g) => [g.groupId, g]));
  return (
    <section className="sent-review" aria-label="Sent review">
      <p>
        Review {data.reviewId} · <StatusBadge>{data.state}</StatusBadge>
        {data.eventId ? ` · event ${data.eventId}` : ""}
      </p>
      {data.summary && <p>Summary: {data.summary}</p>}
      <ol className="review-comments">
        {(data.comments ?? []).map((comment) => (
          <li key={comment.commentId}>
            <p>{comment.body ?? "Comment withheld under current access."}</p>
            {comment.anchorGroupIds.flatMap((groupId) =>
              (groups.get(groupId)?.anchors ?? []).map((anchor) =>
                anchor.state === "unavailable" ? (
                  <p key={anchor.anchorId} role="status">
                    Original context unavailable ({anchor.reason}).
                  </p>
                ) : (
                  <AnchorContext
                    key={anchor.anchorId}
                    anchorId={anchor.anchorId}
                  />
                ),
              ),
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The complete draft, its named destination and the one logical send. */
export function LocalReviewPanel() {
  const review = useLocalReview();
  const draft = review?.draft;
  const state = review?.state;
  if (!review || !state) return null;
  const send = state.send;
  const locked = frozen(review) || draft?.state !== "editable";
  const groupAnchors = new Map(
    (draft?.groups ?? []).map((group) => [group.groupId, group.anchorIds]),
  );
  const comments = draft?.draft.comments ?? [];
  return (
    <section id="local-review" aria-labelledby="local-review-heading">
      <h3 id="local-review-heading" className="section-heading">
        Local review
      </h3>
      <p>
        Select lines in Files, Changes or retained evidence, then add review
        comments. The review is sent as one local message to the named project
        lead. It does not post to GitHub, approve, merge or clear holds.
      </p>
      {draft?.unsentDraftLost && (
        <p role="status">
          An unsent draft from an earlier session was removed when that session
          ended. It cannot be recovered here.
        </p>
      )}
      {review.resource.state.error && !draft && (
        <p role="alert">The review draft could not be read. Retry later.</p>
      )}
      {draft && comments.length === 0 && !send && (
        <p>No review comments yet.</p>
      )}
      {comments.length > 0 && (
        <ol className="review-comments" aria-label="Review comments">
          {comments.map((comment) => {
            const editing = state.editing[comment.commentId];
            return (
              <li key={comment.commentId}>
                {comment.anchorGroupIds.flatMap((groupId) =>
                  (groupAnchors.get(groupId) ?? []).map((anchorId) => (
                    <AnchorContext key={anchorId} anchorId={anchorId} />
                  )),
                )}
                {editing === undefined ? (
                  <p>{comment.body}</p>
                ) : (
                  <>
                    <label htmlFor={`edit-${comment.commentId}`}>
                      Edit comment
                    </label>
                    <Textarea
                      id={`edit-${comment.commentId}`}
                      autoGrow
                      maxLength={4000}
                      value={editing}
                      onChange={(event) => {
                        state.editing[comment.commentId] = event.target.value;
                        review.changed();
                      }}
                    />
                  </>
                )}
                {!locked && (
                  <div className="task-actions">
                    {editing === undefined ? (
                      <Button
                        variant="secondary"
                        disabled={state.pending}
                        onClick={() => {
                          state.editing[comment.commentId] = comment.body;
                          review.changed();
                        }}
                      >
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button
                          disabled={state.pending || !editing.trim()}
                          onClick={() =>
                            void review.updateComment(
                              comment.commentId,
                              editing,
                            )
                          }
                        >
                          Save edit
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            delete state.editing[comment.commentId];
                            review.changed();
                          }}
                        >
                          Cancel edit
                        </Button>
                      </>
                    )}
                    <Button
                      variant="secondary"
                      disabled={state.pending}
                      onClick={() =>
                        void review.updateComment(comment.commentId, null)
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {draft && (comments.length > 0 || draft.draft.summary) && (
        <>
          <label htmlFor="local-review-summary">Summary (optional)</label>
          <Textarea
            id="local-review-summary"
            autoGrow
            maxLength={4000}
            disabled={locked || state.pending}
            value={state.summary ?? draft.draft.summary}
            onChange={(event) => {
              state.summary = event.target.value;
              review.changed();
            }}
          />
          {!locked && state.summary !== null && (
            <Button
              variant="secondary"
              disabled={state.pending}
              onClick={() => void review.saveSummary()}
            >
              Save summary
            </Button>
          )}
        </>
      )}
      {state.notice && <p role="alert">{state.notice}</p>}
      {draft && comments.length > 0 && !send && (
        <div className="review-send">
          <p>
            Destination:{" "}
            {review.lead
              ? `${review.lead.name} (project lead · assignment ${review.lead.assignmentId})`
              : "no project lead assignment is available"}
          </p>
          <Button
            disabled={
              !review.lead ||
              locked ||
              state.pending ||
              state.summary !== null ||
              Object.keys(state.editing).length > 0
            }
            onClick={() => void review.send()}
          >
            Send review ({comments.length} comment
            {comments.length === 1 ? "" : "s"})
          </Button>
          {(state.summary !== null ||
            Object.keys(state.editing).length > 0) && (
            <p className="muted">Save or cancel open edits before sending.</p>
          )}
        </div>
      )}
      {draft?.state === "sending" && !send && (
        <p role="status">
          A review send for this draft is unsettled and its operation is not
          known in this browser. The draft stays frozen; it is never resent.
        </p>
      )}
      {send?.status === "sending" && (
        <p role="status">Sending review to {send.recipientName}…</p>
      )}
      {send?.status === "unknown" && (
        <div role="status">
          <p>
            Delivery to {send.recipientName} is unknown. The review is frozen
            and will not be edited or resent with different content.
          </p>
          <Button onClick={() => void review.reconcile()}>
            Check delivery
          </Button>
        </div>
      )}
      {send &&
        (send.status === "rejected" || send.status === "not-recorded") && (
          <div role="alert">
            <p>
              The review was not delivered
              {send.reason ? ` (${send.reason})` : ""}. Your comments remain
              editable.
            </p>
            <Button
              variant="secondary"
              onClick={() => review.acknowledgeRejection()}
            >
              Return to draft
            </Button>
          </div>
        )}
      {send?.status === "recorded" && (
        <div role="status">
          <p>
            Review sent to {send.recipientName}. One local message was queued.
          </p>
        </div>
      )}
      {state.inspectKey && <SentReview operationKey={state.inspectKey} />}
      {draft?.state === "sent" && (
        <Button
          variant="secondary"
          disabled={state.pending}
          onClick={() => void review.startNew()}
        >
          Start a new review
        </Button>
      )}
    </section>
  );
}
