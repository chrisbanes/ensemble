import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  taskSchema,
  assignmentHistorySchema,
  type TaskRead,
  type Session,
  type OperatorCommand,
  type CommandReceipt,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review.js";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { Textarea } from "./ui/textarea.js";
import type { TaskWorkspaceState } from "./task-workspace-state.js";
import { NativeSelect } from "./ui/native-select.js";
type Reference = z.infer<typeof feedbackReferenceSchema>;
type History = z.infer<typeof assignmentHistorySchema>["data"];
const date = (n: number) => new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
function Literal({ text }: { text: string | null | undefined }) {
  return (
    <pre className="literal-text">{text ?? "Unavailable or redacted"}</pre>
  );
}
function Disclosure({
  id,
  title,
  text,
  state,
  changed,
}: {
  id: string;
  title: string;
  text: string | null | undefined;
  state: TaskWorkspaceState;
  changed: () => void;
}) {
  return (
    <details
      data-record-id={id}
      open={state.expanded.has(id)}
      onToggle={(e) => {
        if (e.currentTarget.open) state.expanded.add(id);
        else state.expanded.delete(id);
        changed();
      }}
    >
      <summary>{title}</summary>
      <Literal text={text} />
    </details>
  );
}
export function TaskWorkspace({
  client,
  session,
  taskId,
  path,
  state,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  path: string;
  state: TaskWorkspaceState;
}) {
  const [auxNotice, setAuxNotice] = useState("");
  const [, render] = useState(0),
    changed = () => render((n) => n + 1);
  const [histories, setHistory] = useState<Record<string, History>>({}),
    [historyErrors, setHistoryErrors] = useState<Record<string, string>>({}),
    [pending, setPending] = useState(false),
    [updates, setUpdates] = useState(false);
  const historyRequests = useRef(new Map<string, number>());
  const invalidateHistory = () => {
    for (const [id, revision] of historyRequests.current)
      historyRequests.current.set(id, revision + 1);
    setHistory({});
  };
  const scope = useRef(true),
    anchor = useRef<{ id: string; y: number } | null>(null),
    bottom = useRef(false),
    first = useRef(true),
    restoreReadingFocus = useRef(true),
    capturedFocus = useRef<HTMLElement | null>(null),
    material = useRef<string | null>(null);
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(`/api/operator/tasks/${taskId}`, taskSchema, signal),
    [client, taskId],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:${taskId}`,
      loader,
    ),
    data = resource.state.data?.data;
  const capture = () => {
    bottom.current =
      innerHeight + scrollY >= document.documentElement.scrollHeight - 64;
    const visible = [
      ...document.querySelectorAll<HTMLElement>("[data-record-id]"),
    ].filter((e) => {
      const bounds = e.getBoundingClientRect();
      return bounds.bottom > 80 && bounds.top < innerHeight;
    });
    const el = visible.find(
      (e) => !visible.some((child) => child !== e && e.contains(child)),
    );
    anchor.current = el
      ? { id: el.dataset.recordId ?? "", y: el.getBoundingClientRect().top }
      : null;
    state.scrollY = scrollY;
    state.historyAnchor = anchor.current;
    capturedFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    state.focusRecord =
      (capturedFocus.current?.closest("[data-record-id]") as HTMLElement | null)
        ?.dataset.recordId ?? null;
    restoreReadingFocus.current = Boolean(state.focusRecord);
    history.replaceState(
      {
        ...history.state,
        taskWorkspaceReading: {
          scrollY: state.scrollY,
          historyAnchor: state.historyAnchor,
          focusRecord: state.focusRecord,
        },
      },
      "",
    );
  };
  const refresh = () => {
    capture();
    invalidateHistory();
    resource.refresh();
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    scope.current = true;
    const leave = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest('a[href^="/app"]'))
        captureRef.current();
    };
    const intentionalFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== capturedFocus.current &&
        target !== document.body &&
        (target.closest("[data-record-id]") as HTMLElement | null)?.dataset
          .recordId !== state.focusRecord
      )
        restoreReadingFocus.current = false;
    };
    document.addEventListener("click", leave, true);
    document.addEventListener("focusin", intentionalFocus);
    const timer = setInterval(() => refreshRef.current(), 15000);
    return () => {
      scope.current = false;
      clearInterval(timer);
      document.removeEventListener("click", leave, true);
      document.removeEventListener("focusin", intentionalFocus);
    };
  }, [state]);
  const layoutPath = useRef(path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: history DOM insertion must restore the previously captured reading anchor.
  useLayoutEffect(() => {
    if (!data) return;
    if (layoutPath.current !== path) {
      layoutPath.current = path;
      const saved = history.state?.taskWorkspaceReading;
      if (saved) {
        state.scrollY = saved.scrollY;
        state.historyAnchor = saved.historyAnchor;
        state.focusRecord = saved.focusRecord;
        anchor.current = saved.historyAnchor;
        restoreReadingFocus.current = true;
        scrollTo(0, saved.scrollY);
      } else {
        const p = new URLSearchParams(path.split("?")[1] ?? "");
        const target = document.getElementById(
          p.get("section") ?? (p.has("result") ? "review" : "brief"),
        );
        if (target) {
          target.scrollIntoView();
          anchor.current = null;
          state.historyAnchor = null;
          bottom.current = false;
          state.scrollY = scrollY;
          restoreReadingFocus.current = false;
          const heading = target.querySelector<HTMLElement>("h3,h4");
          if (heading) {
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }
          return;
        }
      }
    }
    if (restoreReadingFocus.current && capturedFocus.current?.isConnected)
      restoreReadingFocus.current = false;
    if (restoreReadingFocus.current) {
      const target = state.focusRecord
        ? [...document.querySelectorAll<HTMLElement>("[data-record-id]")]
            .find((e) => e.dataset.recordId === state.focusRecord)
            ?.querySelector<HTMLElement>("summary,button,a")
        : null;
      if (target) {
        target.focus({ preventScroll: true });
        restoreReadingFocus.current = false;
      } else if (!state.focusRecord) restoreReadingFocus.current = false;
    }
    const signature = JSON.stringify([
      data.task,
      data.results,
      data.messages,
      data.questions,
      data.approvals,
      data.review?.sources,
    ]);
    const newMaterial =
      material.current !== null && material.current !== signature;
    material.current = signature;
    if (first.current) {
      first.current = false;
      const p = new URLSearchParams(path.split("?")[1] ?? ""),
        record = p.get("record") ?? p.get("request"),
        section = p.get("section");
      const target = record
        ? [...document.querySelectorAll<HTMLElement>("[data-record-id]")].find(
            (e) => e.dataset.recordId === record,
          )
        : section &&
            [
              "brief",
              "review",
              "context",
              "changes",
              "history",
              "reply",
            ].includes(section)
          ? document.getElementById(section)
          : null;
      if (target && state.scrollY === 0) target.scrollIntoView();
      else scrollTo(0, state.scrollY);
      if (state.focusRecord)
        [...document.querySelectorAll<HTMLElement>("[data-record-id]")]
          .find((e) => e.dataset.recordId === state.focusRecord)
          ?.querySelector<HTMLElement>("summary,button,a")
          ?.focus({ preventScroll: true });
      return;
    }
    if (bottom.current) scrollTo(0, document.documentElement.scrollHeight);
    else {
      const a = anchor.current ?? state.historyAnchor,
        el = a
          ? [
              ...document.querySelectorAll<HTMLElement>("[data-record-id]"),
            ].find((el) => el.dataset.recordId === a.id)
          : null;
      if (a && el) scrollBy(0, el.getBoundingClientRect().top - a.y);
      if (newMaterial) setUpdates(true);
    }
  }, [data, histories, state, path]);
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  const selectedPath = useRef<string | null>(null);
  if (selectedPath.current !== path) {
    selectedPath.current = path;
    if (params.has("result")) state.selectedResult = params.get("result");
    if (params.has("source")) state.selectedSource = params.get("source");
    if (params.has("assignment"))
      state.expanded.add(params.get("assignment") ?? "");
  }
  const loadHistory = useCallback(
    async (id: string, before?: number) => {
      const current = client.captureAuthenticationScope();
      const revision = (historyRequests.current.get(id) ?? 0) + 1;
      historyRequests.current.set(id, revision);
      const owned = () =>
        scope.current &&
        current() &&
        historyRequests.current.get(id) === revision;
      setHistory((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
      try {
        const pages = [...(state.historyPages[id] ?? [])];
        if (before && !pages.includes(before)) pages.push(before);
        const values: History[] = [];
        for (const boundary of [undefined, ...pages]) {
          values.push(
            (
              await client.read(
                `/api/operator/assignments/${id}/history${boundary ? `?beforeSequence=${boundary}` : ""}`,
                assignmentHistorySchema,
              )
            ).data,
          );
        }
        if (!owned()) return;
        const recent = values[0];
        if (!recent) return;
        if (
          values.some(
            (value) => value.visibilityRevision !== recent.visibilityRevision,
          )
        ) {
          setHistory((old) => {
            if (!owned()) return old;
            const next = { ...old };
            delete next[id];
            return next;
          });
          throw Error(
            "History visibility changed while loading retained pages",
          );
        }
        const items = values
          .flatMap((value) => value.items)
          .filter(
            (item, i, all) =>
              all.findIndex(
                (other) =>
                  other.workId === item.workId && other.itemId === item.itemId,
              ) === i,
          )
          .sort((a, b) => a.sequence - b.sequence);
        state.historyPages[id] = pages;
        setHistory((old) =>
          owned()
            ? {
                ...old,
                [id]: {
                  ...recent,
                  items,
                  omittedItemCount:
                    values.at(-1)?.omittedItemCount ?? recent.omittedItemCount,
                },
              }
            : old,
        );
        setHistoryErrors((old) => (owned() ? { ...old, [id]: "" } : old));
      } catch (e) {
        if (owned()) {
          setHistory((old) => {
            if (!owned()) return old;
            const next = { ...old };
            delete next[id];
            return next;
          });
          setHistoryErrors((old) =>
            owned()
              ? {
                  ...old,
                  [id]: e instanceof Error ? e.message : "Unavailable",
                }
              : old,
          );
        }
      }
    },
    [client, state],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: pending/error invalidates the current history ownership before any late batch can publish.
  useEffect(() => {
    if (resource.state.pending || resource.state.error) {
      invalidateHistory();
      return;
    }
    for (const a of data?.assignments ?? []) void loadHistory(a.assignmentId);
  }, [data, loadHistory, resource.state.pending, resource.state.error]);
  async function command(input: OperatorCommand) {
    if (pending) return;
    setPending(true);
    const current = client.captureAuthenticationScope();
    const outcome = await client.command(input, session.csrfToken);
    if (!scope.current || !current()) return;
    setPending(false);
    const reply = input.type === "message" || input.type === "comment.send";
    if (!reply) {
      if (outcome.state === "recorded") {
        if (outcome.receipt.kind === "comment-review")
          state.commentReview = outcome.receipt;
        setAuxNotice("Observation / review receipt recorded");
        refresh();
      } else
        setAuxNotice(
          `${outcome.state}: ${outcome.code}. Reply draft and original operation retained.`,
        );
      changed();
      return;
    }
    if (state.frozen?.key !== input.key) {
      setAuxNotice(
        "Unrelated reply receipt ignored; original operation retained.",
      );
      return;
    }
    if (
      outcome.state === "recorded" &&
      (outcome.receipt.key !== input.key ||
        !("taskId" in outcome.receipt) ||
        outcome.receipt.taskId !== taskId ||
        (input.type === "message"
          ? outcome.receipt.kind !== "coordination"
          : outcome.receipt.kind !== "delivery" ||
            outcome.receipt.operationId !== input.key))
    ) {
      state.uncertain = true;
      state.notice =
        "Unknown receipt identity; original reply retained for reconciliation.";
      changed();
      return;
    }
    if (outcome.state === "recorded") {
      state.receipt = outcome.receipt;
      state.uncertain = false;
      state.notice =
        outcome.receipt.kind === "delivery"
          ? `${outcome.receipt.state}: ${outcome.receipt.reason ?? "provider receipt recorded"}`
          : "Receipt recorded";
      if (
        outcome.receipt.kind === "coordination" ||
        (outcome.receipt.kind === "delivery" &&
          outcome.receipt.state === "confirmed-success")
      ) {
        state.draft = "";
        if (input.type === "message") state.reference = undefined;
        state.commentReview = null;
      }
      if (
        outcome.receipt.kind === "delivery" &&
        ["uncertain", "attempting", "prepared"].includes(outcome.receipt.state)
      ) {
        state.uncertain = true;
      } else state.frozen = null;
      refresh();
    } else {
      state.notice = `${outcome.state}: ${outcome.code}. Draft retained.`;
      state.uncertain = outcome.state === "unknown";
      if (!state.uncertain) state.frozen = null;
    }
    changed();
  }
  const ask = (reference: Reference, label: string) => {
    if (state.uncertain || pending) return;
    state.reference = reference;
    state.destination = "lead";
    state.draft = `Please review ${label}.`;
    changed();
    requestAnimationFrame(() =>
      document.getElementById("workspace-reply")?.focus(),
    );
  };
  if (!data)
    return (
      <section>
        <ResourceStatus state={resource.state} retry={refresh} />
        <p>
          Task material is unavailable. Exact historical targets are not
          replaced with current records.
        </p>
        <ActionLink href="/app/tasks">All tasks</ActionLink>
      </section>
    );
  const review = data.review,
    sources = review?.sources ?? [],
    latestSource = sources.at(-1),
    source = state.selectedSource
      ? sources.find((s) => s.sourceId === state.selectedSource)
      : latestSource;
  const selected = state.selectedResult
      ? data.results.find((r) => r.resultId === state.selectedResult)
      : data.results.at(-1),
    meta = review?.results.find((r) => r.resultId === selected?.resultId);
  const leadId = data.leadAssignmentId,
    lead = data.assignments.find((a) => a.assignmentId === leadId);
  const openRequests = [...data.questions, ...data.approvals].filter(
    (q) => q.status === "open",
  );
  const returnPath =
    (window.history.state as { origin?: string } | null)?.origin ??
    `/app/projects/${data.task.projectId}`;
  async function send() {
    if (!state.draft.trim() || pending) return;
    if (state.frozen) {
      await command(state.frozen);
      return;
    }
    const key = crypto.randomUUID();
    let input: OperatorCommand;
    if (state.destination === "lead") {
      if (!lead) return;
      input = {
        type: "message",
        key,
        taskId,
        recipientAssignmentId: lead.assignmentId,
        expectedAssignmentVersion: lead.version,
        message: state.draft,
        ...(state.reference ? { reference: state.reference } : {}),
      };
    } else {
      input = {
        type: "comment.send",
        key: state.commentReview?.operationId ?? key,
        taskId,
        expectedTaskVersion: data?.task.version ?? 0,
        body: state.draft,
        ...(state.commentReview
          ? { reviewId: state.commentReview.reviewId }
          : {}),
      };
    }
    state.frozen = structuredClone(input);
    await command(input);
  }
  const viewedIndexes =
    review?.viewed?.resultIds.map((id) =>
      data.results.findIndex((r) => r.resultId === id),
    ) ?? [];
  const newestViewed = Math.max(-1, ...viewedIndexes);
  const changes = review?.viewed
    ? `${newestViewed >= 0 ? `${data.results.length - newestViewed - 1} new result(s)` : "Newer results unknown; no retained viewed result ordering"}; ${review.viewed.sourceId !== latestSource?.sourceId ? "source requirements changed" : "source unchanged"}`
    : "No viewing baseline. Comparison with previously viewed material is unknown.";
  return (
    <article className="task-workspace" aria-label="Task workspace">
      <div className="task-actions">
        {window.history.state?.origin ? (
          <Button variant="secondary" onClick={() => window.history.back()}>
            Back to originating view
          </Button>
        ) : (
          <ActionLink href={returnPath}>Back to project</ActionLink>
        )}
        <Button variant="secondary" onClick={refresh}>
          Refresh task
        </Button>
        <ActionLink href={`/task/${taskId}`}>Advanced task controls</ActionLink>
        <ActionLink href={`/runtime/task/${taskId}`}>
          Runtime / Stop / Resume
        </ActionLink>
        <ActionLink href={`/coordination/task/${taskId}`}>
          Requests and coordination
        </ActionLink>
      </div>
      <ResourceStatus state={resource.state} retry={refresh} />
      <header>
        <h2 className="section-heading">
          {data.task.title ?? "Title unavailable"}
        </h2>
        <div className="task-actions">
          <StatusBadge>{data.task.state}</StatusBadge>
          <span>
            Lead: {data.lead?.name ?? "Unconfigured"} · execution{" "}
            {data.execution.state}
          </span>
        </div>
      </header>
      <section
        className="workspace-attention"
        aria-label="Pending requests and holds"
      >
        <h3 className="section-heading">Needs attention</h3>
        {openRequests.length === 0 &&
          !data.admission.reasons.length &&
          !Object.values(data.execution.holds).some(Boolean) && (
            <p>No pending request or recorded hold.</p>
          )}
        {data.admission.reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
        {Object.entries(data.execution.holds)
          .filter(([, v]) => v)
          .map(([k]) => (
            <p key={k}>{k} hold — use exact recovery controls</p>
          ))}
        {openRequests.map((q) => (
          <div key={q.interactionId} data-record-id={q.interactionId}>
            <StatusBadge tone="warning">{q.kind} pending</StatusBadge>
            <Literal text={q.prompt} />
            {q.kind === "approval" && (
              <>
                <p>
                  Action: {q.action ?? "Unavailable"} · Target:{" "}
                  {q.target ?? "Unavailable"} · revision {q.revision}
                </p>
                <p>
                  Exact reviewed material: {q.materialHash ?? "Unavailable"}
                </p>
              </>
            )}
            <ActionLink
              href={`/coordination/task/${taskId}#${q.interactionId}`}
            >
              {q.kind === "approval"
                ? "Review exact approval / Deny / Leave pending"
                : "Answer question"}
            </ActionLink>
          </div>
        ))}
        {data.completionRequests
          .filter((r) => r.status === "pending")
          .map((r) => (
            <ActionLink key={r.requestId} href={`/coordination/task/${taskId}`}>
              Pending completion review
            </ActionLink>
          ))}
        {data.unresolvedResults.length > 0 && (
          <ActionLink href={`/coordination/task/${taskId}`}>
            Unresolved result delivery
          </ActionLink>
        )}
      </section>
      <nav className="task-actions" aria-label="Task sections">
        {["brief", "review", "context", "changes", "history", "reply"].map(
          (s) => (
            <ActionLink variant="secondary" key={s} href={`#${s}`}>
              {s[0]?.toUpperCase()}
              {s.slice(1)}
            </ActionLink>
          ),
        )}
      </nav>
      {updates && (
        <Button
          onClick={() => {
            scrollTo(0, document.documentElement.scrollHeight);
            setUpdates(false);
          }}
        >
          New updates — jump to latest
        </Button>
      )}
      <section id="brief">
        <h3 className="section-heading">Brief and source</h3>
        {state.selectedSource && !source && (
          <p role="alert">
            Selected source revision is unavailable. Current requirements are
            not substituted.
          </p>
        )}
        {source && (
          <>
            <p>
              {source.kind} source revision {source.revision} ·{" "}
              {source.sourceId}
            </p>
            <Disclosure
              id={source.sourceId}
              title={`${source.title ?? "Brief"} — read supplied text`}
              text={source.body}
              state={state}
              changed={changed}
            />
            <p className="literal-preview">
              {source.body?.slice(0, 500) ?? "Source text unavailable"}
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                ask(
                  { sourceId: source.sourceId },
                  `source revision ${source.revision}`,
                )
              }
            >
              Ask lead about brief
            </Button>
          </>
        )}
        {!source && !state.selectedSource && (
          <Literal text={data.task.outcome} />
        )}
        <label htmlFor="retained-source-revision">
          Retained source revision{" "}
          <NativeSelect
            id="retained-source-revision"
            className="control"
            value={state.selectedSource ?? ""}
            onChange={(e) => {
              state.selectedSource = e.target.value || null;
              changed();
            }}
          >
            <option value="">Latest</option>
            {sources.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                Revision {s.revision}
              </option>
            ))}
          </NativeSelect>
        </label>
        {data.source && (
          <div>
            <p>
              GitHub source is read-only here: {data.source.repositoryName} #
              {data.source.number} · {data.source.identity.nodeId}
            </p>
            <ActionLink href={data.source.url ?? "#"}>
              Open GitHub to edit source
            </ActionLink>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await client.refreshSources(session.csrfToken);
                  refresh();
                } catch {
                  state.notice =
                    "Source refresh failed. Last successful source retained.";
                  changed();
                }
              }}
            >
              Refresh source observation
            </Button>
            {data.source.memberships.map((m) => (
              <p key={m.selectionId}>
                Selection {m.selectionId} · last successful{" "}
                {m.sync.lastSuccessfulAt ?? "never"} ·{" "}
                {m.sync.reasonCode ??
                  (m.sync.complete ? "complete" : "unknown")}
              </p>
            ))}
            <h4>Native GitHub dependencies</h4>
            {data.source.nativeBlockers.map((b) => (
              <p key={b.nodeId}>
                {b.repositoryName} #{b.number} {b.state}
              </p>
            ))}
          </div>
        )}
        <h4>Local task dependencies</h4>
        {data.localDependencies.length ? (
          data.localDependencies.map((d) => (
            <ActionLink key={d.id} href={`/app/tasks/${d.id}`}>
              {d.title ?? "Unavailable"} · {d.state}
            </ActionLink>
          ))
        ) : (
          <p>No local dependency recorded.</p>
        )}
      </section>
      <section id="review">
        <h3 className="section-heading">Evidence review</h3>
        <p>{changes}</p>
        <Button
          variant="secondary"
          onClick={() =>
            void command({
              type: "review.view",
              key: crypto.randomUUID(),
              taskId,
              sourceId: state.selectedSource
                ? (source?.sourceId ?? null)
                : selected
                  ? (meta?.metadata.sourceId ?? null)
                  : (source?.sourceId ?? null),
              resultIds: selected ? [selected.resultId] : [],
            })
          }
          disabled={
            Boolean(state.selectedResult && !selected) ||
            Boolean(state.selectedSource && !source)
          }
        >
          Set viewing reference
        </Button>
        <p>
          Viewing records availability only; it does not approve work or clear
          holds. Retained records may be incomplete.
        </p>
        <label htmlFor="retained-result-revision">
          Result revision{" "}
          <NativeSelect
            id="retained-result-revision"
            className="control"
            value={state.selectedResult ?? ""}
            onChange={(e) => {
              state.selectedResult = e.target.value || null;
              changed();
            }}
          >
            <option value="">Latest result</option>
            {data.results.map((r, i) => (
              <option key={r.resultId} value={r.resultId}>
                Result {i + 1} · {r.workId}
              </option>
            ))}
          </NativeSelect>
        </label>
        {state.selectedResult && !selected && (
          <p role="alert">
            Exact selected result is unavailable. A newer result is not
            substituted.
          </p>
        )}
        {selected ? (
          <div data-record-id={selected.resultId}>
            <p>
              Result {selected.resultId} · assignment {selected.assignmentId} ·
              work revision {selected.workRevision} · {date(selected.createdAt)}
            </p>
            <Literal text={selected.summary} />
            <Button
              variant="secondary"
              onClick={() =>
                ask(
                  {
                    resultId: selected.resultId,
                    workId: selected.workId,
                    ...(meta?.metadata.sourceId
                      ? { sourceId: meta.metadata.sourceId }
                      : {}),
                  },
                  `result ${selected.resultId}`,
                )
              }
            >
              Ask lead about result
            </Button>
            {!meta && (
              <p>No structured review evidence was supplied for this result.</p>
            )}
            {meta && (
              <ReviewEvidence
                data={data}
                resultId={selected.resultId}
                sourceId={meta.metadata.sourceId}
                ask={ask}
              />
            )}
          </div>
        ) : (
          !state.selectedResult && <p>No result recorded.</p>
        )}
      </section>
      <section id="context">
        <h3 className="section-heading">Captured context</h3>
        <p>
          Captured preparation records distinguish supplied material from
          current configuration. Availability is not proof that an agent read
          it.
        </p>
        {review?.contexts.length ? (
          review.contexts.map((c) => (
            <div key={c.captureId} data-record-id={c.captureId}>
              <p>
                Supplier {c.supplier} · assignment {c.assignmentId} revision{" "}
                {c.assignmentVersion} · {c.workId ?? "assignment creation"} ·
                captured {date(c.createdAt)}
              </p>
              <p>
                Profile revision {c.profileRevision}; instructions revision{" "}
                {c.instructionsRevision}; source {c.sourceId ?? "unavailable"}
              </p>
              <Disclosure
                id={c.captureId}
                title="Captured brief"
                text={c.brief}
                state={state}
                changed={changed}
              />
            </div>
          ))
        ) : (
          <p>
            No retained context capture for this legacy task. Current settings
            are not reconstructed as history.
          </p>
        )}
        {data.assignments.map((a) => (
          <p key={a.assignmentId}>
            Current assignment {a.assignmentId}: profile revision{" "}
            {a.currentProfileRevision}, instructions revision{" "}
            {a.currentInstructionsRevision}
          </p>
        ))}
      </section>
      <Changes
        data={data}
        selected={meta}
        refresh={() =>
          void command({
            type: "delivery.refresh",
            key: crypto.randomUUID(),
            taskId,
          })
        }
      />
      <section id="history">
        <h3 className="section-heading">Assignments and retained history</h3>
        <div className="task-actions">
          <Button
            variant="secondary"
            onClick={() => {
              for (const a of data.assignments)
                state.expanded.add(a.assignmentId);
              for (const h of Object.values(histories))
                for (const i of h.items)
                  state.expanded.add(`${i.workId}:${i.itemId}`);
              changed();
            }}
          >
            Expand all history
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              state.expanded.clear();
              changed();
            }}
          >
            Collapse all history
          </Button>
          <Button
            variant="secondary"
            aria-pressed={state.chronological}
            onClick={() => {
              state.chronological = !state.chronological;
              changed();
            }}
          >
            Chronological view
          </Button>
        </div>
        <p>
          Source-faithful captured text; no generated summaries or
          full-transcript promise. Redaction and retention can omit content.
        </p>
        {state.chronological ? (
          <div>
            {Object.values(histories)
              .flatMap((h) => h.items)
              .sort(
                (a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence,
              )
              .map((i) => (
                <Disclosure
                  key={`${i.workId}:${i.itemId}`}
                  id={`${i.workId}:${i.itemId}`}
                  title={`${date(i.createdAt)} · ${i.assignmentId} · ${i.lifecycle}`}
                  text={
                    i.text ?? `Omitted: ${i.omissionReason ?? "unavailable"}`
                  }
                  state={state}
                  changed={changed}
                />
              ))}
          </div>
        ) : (
          data.assignments.map((a) => (
            <details
              key={a.assignmentId}
              data-record-id={a.assignmentId}
              open={state.expanded.has(a.assignmentId)}
              onToggle={(e) => {
                if (e.currentTarget.open) state.expanded.add(a.assignmentId);
                else state.expanded.delete(a.assignmentId);
                changed();
              }}
            >
              <summary>
                {a.name ?? "Assignment"} · {a.state} · version {a.version}
              </summary>
              <p>
                Assignment {a.assignmentId} · profile revision{" "}
                {a.profileRevision} · instructions revision{" "}
                {a.instructionsRevision}
              </p>
              <p>Supplied responsibility / brief</p>
              <Literal text={a.brief} />
              <p>
                Requester assignment:{" "}
                {a.requesterAssignmentId ?? "Not recorded"}; result destination:{" "}
                {a.resultDestination ?? "Unavailable"}; resolved recipient:{" "}
                {a.resultRecipientAssignmentId ?? "Unavailable"} (
                {a.resultRecipientDisposition ?? "Unknown disposition"}).
              </p>
              <p>
                Recorded wait / execution reason:{" "}
                {a.waitReason ?? "No recorded wait reason; unknown"}.
              </p>
              {data.results
                .filter((r) => r.assignmentId === a.assignmentId)
                .map((r) => (
                  <p key={r.resultId}>
                    <ActionLink
                      href={`/app/tasks/${taskId}?section=review&assignment=${a.assignmentId}&result=${r.resultId}`}
                    >
                      Open exact assignment result {r.resultId}
                    </ActionLink>
                  </p>
                ))}
              <ActionLink href={`/coordination/assignment/${a.assignmentId}`}>
                Advanced assignment and history controls
              </ActionLink>
              {historyErrors[a.assignmentId] && (
                <p role="alert">
                  History refresh failed: {historyErrors[a.assignmentId]}.
                  Unvalidated history is hidden; retry to read current material.
                </p>
              )}
              <p className="literal-preview">
                {histories[a.assignmentId]?.items.at(-1)?.text?.slice(0, 500) ??
                  "Recent captured text unavailable"}
              </p>
              {histories[a.assignmentId]?.omittedItemCount ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    capture();
                    void loadHistory(
                      a.assignmentId,
                      histories[a.assignmentId]?.items[0]?.sequence,
                    );
                  }}
                >
                  Load earlier retained history (
                  {histories[a.assignmentId]?.omittedItemCount})
                </Button>
              ) : null}
              {histories[a.assignmentId]?.items.map((i) => (
                <Disclosure
                  key={`${i.workId}:${i.itemId}`}
                  id={`${i.workId}:${i.itemId}`}
                  title={`${date(i.createdAt)} · ${i.lifecycle} · ${i.itemId}`}
                  text={
                    i.text ?? `Omitted: ${i.omissionReason ?? "unavailable"}`
                  }
                  state={state}
                  changed={changed}
                />
              ))}
              <Button
                variant="secondary"
                onClick={() => void loadHistory(a.assignmentId)}
              >
                Refresh captured history
              </Button>
            </details>
          ))
        )}
        {data.messages.map((m) => (
          <div key={m.eventId} data-record-id={m.eventId}>
            <p>
              {m.eventType} · {m.deliveryState} · {date(m.createdAt)}
            </p>
            <Literal text={m.text} />
            {m.reference && (
              <p>Exact feedback reference: {JSON.stringify(m.reference)}</p>
            )}
          </div>
        ))}
      </section>
      <section id="reply">
        <h3 className="section-heading">Reply</h3>
        <div className="task-actions">
          <Button
            variant={state.destination === "lead" ? "primary" : "secondary"}
            disabled={pending || state.uncertain}
            onClick={() => {
              state.destination = "lead";
              changed();
            }}
          >
            Message task lead
          </Button>
          <Button
            variant={state.destination === "github" ? "primary" : "secondary"}
            disabled={
              pending || state.uncertain || !data.commentPolicy?.available
            }
            onClick={() => {
              state.destination = "github";
              changed();
            }}
          >
            Post GitHub comment
          </Button>
        </div>
        <p>
          {state.destination === "lead"
            ? `Local Ensemble inbox for ${lead?.name ?? "unconfigured lead"}. Does not post to GitHub or approve work.`
            : `GitHub issue comment · ${data.commentPolicy?.mode ?? "unavailable"} policy · ${data.commentPolicy?.reason ?? ""}`}
        </p>
        {state.destination === "lead" && state.reference && (
          <p>Immutable reference: {JSON.stringify(state.reference)}</p>
        )}
        <label htmlFor="workspace-reply">Editable reply</label>
        <Textarea
          id="workspace-reply"
          value={state.draft}
          disabled={pending || state.uncertain}
          onChange={(e) => {
            state.draft = e.target.value;
            if (state.destination === "github") state.commentReview = null;
            changed();
          }}
          rows={5}
        />
        {state.destination === "github" &&
          data.commentPolicy?.mode === "approval" && (
            <>
              <Button
                disabled={pending || state.uncertain || !state.draft.trim()}
                onClick={() =>
                  void command({
                    type: "comment.review",
                    key: crypto.randomUUID(),
                    operationId: crypto.randomUUID(),
                    taskId,
                    expectedTaskVersion: data.task.version,
                    body: state.draft,
                  })
                }
              >
                Review exact GitHub comment
              </Button>
              {state.commentReview && (
                <CommentReview
                  record={state.commentReview}
                  disabled={pending}
                  confirm={(decision) => {
                    const review = state.commentReview;
                    if (!review) return;
                    void command({
                      type: "comment.confirm",
                      key: crypto.randomUUID(),
                      taskId,
                      reviewId: review.reviewId,
                      expectedRevision: review.revision,
                      materialHash: review.materialHash,
                      decision,
                    });
                  }}
                />
              )}
            </>
          )}
        <Button
          disabled={
            pending ||
            !state.draft.trim() ||
            (state.destination === "lead" &&
              (!lead || !["pending", "running"].includes(lead.state)) &&
              !state.uncertain) ||
            (state.destination === "github" &&
              (!data.commentPolicy?.available ||
                (data.commentPolicy.mode === "approval" &&
                  state.commentReview?.decision !== "approved")) &&
              !state.uncertain)
          }
          onClick={() => void send()}
        >
          {pending
            ? "Sending…"
            : state.uncertain
              ? "Reconcile original operation"
              : state.destination === "lead"
                ? "Send to task lead"
                : "Post comment"}
        </Button>
        {auxNotice && <p role="status">{auxNotice}</p>}
        {state.destination === "lead" &&
          lead &&
          !["pending", "running"].includes(lead.state) && (
            <p>
              Task lead is {lead.state}; local message delivery is unavailable.
              The exact-reference draft remains editable. Existing coordination
              controls retain the lifecycle boundary.
            </p>
          )}
        {state.notice && <p role="status">{state.notice}</p>}
        {state.receipt && (
          <p className="metadata">
            Receipt key {state.receipt.key} · {state.receipt.kind}
          </p>
        )}
        <p>
          Failed or uncertain operations retain the draft. Reconciliation uses
          the original operation identity.
        </p>
      </section>
    </article>
  );
}
function CommentReview({
  record,
  confirm,
  disabled,
}: {
  record: Extract<CommandReceipt, { kind: "comment-review" }>;
  confirm: (d: "approved" | "denied") => void;
  disabled: boolean;
}) {
  return (
    <div className="workspace-attention">
      <h4>Exact operator comment review</h4>
      <Literal text={record.body} />
      <p>
        Issue {record.target.nodeId} #{record.target.number} · repository{" "}
        {record.target.repositoryId}
      </p>
      <p>
        Task revision {record.taskVersion}; source {record.sourceId} revision{" "}
        {record.sourceRevision}; policy {record.policyVersion}; operation{" "}
        {record.operationId}; review {record.revision} · {record.decision}
      </p>
      <p>Material {record.materialHash}</p>
      {record.decision === "pending" && (
        <>
          <Button disabled={disabled} onClick={() => confirm("approved")}>
            Confirm exact comment
          </Button>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => confirm("denied")}
          >
            Deny comment
          </Button>
          <p>Leave pending by continuing without confirming.</p>
        </>
      )}
    </div>
  );
}
function ReviewEvidence({
  data,
  resultId,
  sourceId,
  ask,
}: {
  data: TaskRead["data"];
  resultId: string;
  sourceId: string | undefined;
  ask: (r: Reference, label: string) => void;
}) {
  const result = data.review?.results.find((r) => r.resultId === resultId),
    metadata = result?.metadata,
    s = data.review?.sources.find((s) => s.sourceId === sourceId),
    latest = data.review?.sources.at(-1);
  if (!metadata) return null;
  return (
    <>
      <h4>Supplied criteria</h4>
      {!s?.criteria.length && (
        <p>
          No literal checklist records. Consult the supplied brief prose for
          requirements.
        </p>
      )}
      {s?.criteria.map((c) => {
        const outcome = metadata.criteria.find(
          (x) => x.criterionId === c.criterionId,
        );
        return (
          <div key={c.criterionId} data-record-id={c.criterionId}>
            <p>
              {c.text} · {outcome?.outcome ?? "unverified"}{" "}
              {latest?.sourceId !== s.sourceId ? "· stale source revision" : ""}
            </p>
            <p>
              Source revision {s.revision} ·{" "}
              {outcome?.scope ?? "No supporting scope supplied"} · provenance{" "}
              {outcome?.provenance ?? "Unavailable"}
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                ask(
                  {
                    resultId,
                    sourceId: s.sourceId,
                    criterionId: c.criterionId,
                  },
                  `criterion ${c.position + 1} in source revision ${s.revision}`,
                )
              }
            >
              Ask lead about criterion
            </Button>
          </div>
        );
      })}
      {latest && s && latest.sourceId !== s.sourceId && (
        <p>
          Newer source revision {latest.revision} has requirements not covered
          by this historical result.
        </p>
      )}
      {latest && s && latest.sourceId !== s.sourceId && (
        <div>
          <h4>
            Current supplied criteria not covered by this historical result
          </h4>
          {latest.criteria.map((c) => (
            <p key={c.criterionId}>
              {c.text} · unverified for source revision {latest.revision}
            </p>
          ))}
        </div>
      )}
      {metadata.decisions
        .map((d, i) => ({ d, recordId: `${resultId}:decision:${i}` }))
        .map(({ d, recordId }) => (
          <div key={recordId} data-record-id={recordId}>
            <h4>Recorded decision</h4>
            <p>{d.attribution}</p>
            <Literal text={d.text} />
          </div>
        ))}
      <h4>Validation records</h4>
      {metadata.validations.length ? (
        metadata.validations.map((v) => (
          <p key={`${v.label}:${v.scope}:${v.provenance}`}>
            {v.label}: {v.outcome} · {v.scope} · {v.provenance} · checked head{" "}
            {v.checkedHead ?? "not supplied"}
          </p>
        ))
      ) : (
        <p>No supplied validation record. No overall pass is inferred.</p>
      )}
      <h4>Recorded comparisons and evidence</h4>
      {!metadata.artifacts.length && <p>No artifact evidence supplied.</p>}
      {[
        ...new Set(
          metadata.artifacts.map((a) => a.pairId ?? `unpaired:${a.artifactId}`),
        ),
      ].map((pair) => {
        const group = metadata.artifacts.filter(
          (a) => (a.pairId ?? `unpaired:${a.artifactId}`) === pair,
        );
        return (
          <section key={pair} data-artifact-pair={pair}>
            <h5>
              {pair.startsWith("unpaired:")
                ? "Unpaired recorded evidence"
                : `Recorded pair ${pair}`}
            </h5>
            <div className="artifact-comparisons">
              {["before", "after", "evidence"].map((role) => (
                <div key={role} data-artifact-role={role}>
                  {group
                    .filter((a) => a.role === role)
                    .map((a) =>
                      metadata.artifacts.filter(
                        (v) => v.artifactId === a.artifactId,
                      ).length > 1 ? (
                        <p key={`${a.artifactId}:${role}:${a.label}`}>
                          Duplicate artifact identity {a.artifactId}; preview
                          and feedback unavailable.
                        </p>
                      ) : (
                        <Artifact
                          key={a.artifactId}
                          taskId={data.task.id}
                          artifact={a}
                          ask={() =>
                            ask(
                              {
                                resultId,
                                artifactId: a.artifactId,
                                ...(sourceId ? { sourceId } : {}),
                              },
                              `${a.role} artifact ${a.label}`,
                            )
                          }
                        />
                      ),
                    )}
                  {!pair.startsWith("unpaired:") &&
                    role !== "evidence" &&
                    !group.some((a) => a.role === role) && (
                      <p>{role}: recorded side missing.</p>
                    )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <p>
        Before/after labels and pairing are producer records. Missing sides and
        preview failures are not replaced with another revision.
      </p>
      {metadata.artifacts
        .filter((a) => a.pairId)
        .map(
          (a) =>
            !metadata.artifacts.some(
              (b) => b.pairId === a.pairId && b.role !== a.role,
            ) && (
              <p key={a.artifactId}>
                Pair {a.pairId}: opposite side unavailable.
              </p>
            ),
        )}
    </>
  );
}
function Artifact({
  taskId,
  artifact,
  ask,
}: {
  taskId: string;
  artifact: NonNullable<
    TaskRead["data"]["review"]
  >["results"][number]["metadata"]["artifacts"][number];
  ask: () => void;
}) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  return (
    <figure data-record-id={artifact.artifactId}>
      <figcaption>
        {artifact.role}: {artifact.label} · revision {artifact.revision} · pair{" "}
        {artifact.pairId ?? "none recorded"}
      </figcaption>
      {artifact.availability === "available" ? (
        <>
          <img
            key={retry}
            loading="lazy"
            src={`/api/operator/tasks/${taskId}/artifacts/${artifact.artifactId}`}
            alt={`${artifact.role}: ${artifact.label}`}
            onError={() => setFailed(true)}
            hidden={failed}
          />
          {failed && (
            <>
              <p>
                Preview unavailable or mismatched. Recorded identity retained.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setFailed(false);
                  setRetry((n) => n + 1);
                }}
              >
                Retry recorded preview
              </Button>
            </>
          )}
          {artifact.url && (
            <ActionLink href={artifact.url}>
              Open recorded artifact link
            </ActionLink>
          )}
        </>
      ) : (
        <p>{artifact.availability}</p>
      )}
      <Button variant="secondary" onClick={ask}>
        Ask lead about artifact
      </Button>
    </figure>
  );
}
function Changes({
  data,
  selected,
  refresh,
}: {
  data: TaskRead["data"];
  selected:
    | NonNullable<TaskRead["data"]["review"]>["results"][number]
    | undefined;
  refresh: () => void;
}) {
  const changes = selected?.metadata.changes,
    d = data.delivery;
  return (
    <section id="changes">
      <h3 className="section-heading">Changes and delivery</h3>
      {changes ? (
        <>
          <p>Recorded files: {changes.files.join(", ") || "not supplied"}</p>
          <p>
            Recorded commits: {changes.commits.join(", ") || "not supplied"}
          </p>
          <Literal text={changes.diff} />
          {changes.reference && (
            <ActionLink href={changes.reference}>
              Recorded change reference
            </ActionLink>
          )}
          {changes.findings.map((f) => (
            <p key={`${f.finding}:${f.repairAssignmentId ?? "unknown"}`}>
              {f.finding} · repair assignment{" "}
              {f.repairAssignmentId ?? "ownership unknown"}
            </p>
          ))}
        </>
      ) : (
        <p>No recorded file, commit or diff metadata for this result.</p>
      )}
      {d?.binding ? (
        <>
          <p>
            PR #{d.binding.number} · {d.binding.repositoryName} ·{" "}
            {d.binding.state} · observed head {d.binding.headSha}
          </p>
          <p>
            Provider observed {date(d.binding.observedAt)} ·{" "}
            {d.binding.readError
              ? "Stale / failed read"
              : "last successful observation"}
          </p>
          {d.binding.checks.map((c) => (
            <p key={`${c.name}:${c.sha}`}>
              {c.name}: {c.status} · head {c.sha}{" "}
              {c.sha !== d.binding?.headSha ? "stale checked head" : ""}
            </p>
          ))}
          {d.binding.feedback.map((f) => (
            <div key={f.nodeId}>
              <p>
                {f.kind} · {f.author ?? "Author unavailable"} · {f.state} · head{" "}
                {f.commitSha ?? "unknown"}
              </p>
              <Literal text={f.body} />
              <p>Repair ownership is not inferred from provider feedback.</p>
            </div>
          ))}
          {d.binding.state === "MERGED" && (
            <p>
              PR merged; task completion still requires its recorded completion
              workflow.
            </p>
          )}
        </>
      ) : (
        <p>No bound PR. Provider checks and repair ownership unavailable.</p>
      )}
      {d?.blockers.map((b) => (
        <p key={b}>{b}</p>
      ))}
      <Button variant="secondary" onClick={refresh}>
        Refresh delivery observation
      </Button>
      <p>
        Refresh reads provider state; it does not post, approve, merge or clear
        a hold.
      </p>
      {d?.actions.map((a) => (
        <p key={a.operationId}>
          {a.kind}: {a.state} · {a.reason ?? "receipt recorded"} · operation{" "}
          {a.operationId}
        </p>
      ))}
    </section>
  );
}

export function TaskInbox({
  client,
  session,
  ids,
}: {
  client: OperatorClient;
  session: Session;
  ids: string[];
}) {
  return (
    <section>
      <ActionLink href="/coordination">
        Open existing coordination controls
      </ActionLink>
      <p>
        Pending task requests and recorded holds. Open the exact task to review
        its current material.
      </p>
      {ids.length ? (
        ids.map((id) => (
          <InboxTask key={id} client={client} session={session} taskId={id} />
        ))
      ) : (
        <p>No recorded task attention.</p>
      )}
    </section>
  );
}
function InboxTask({
  client,
  session,
  taskId,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
}) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(`/api/operator/tasks/${taskId}`, taskSchema, signal),
    [client, taskId],
  );
  const r = useOperatorResource(`${session.csrfToken}:inbox:${taskId}`, loader),
    d = r.state.data?.data;
  return (
    <div>
      <ResourceStatus state={r.state} retry={r.refresh} />
      {d && (
        <>
          <ActionLink href={`/app/tasks/${taskId}?section=review`}>
            {d.task.title ?? "Unavailable task"}
          </ActionLink>
          {[...d.questions, ...d.approvals]
            .filter((q) => q.status === "open")
            .map((q) => (
              <p key={q.interactionId}>
                <ActionLink
                  href={`/app/tasks/${taskId}?request=${q.interactionId}`}
                >
                  {q.kind}: {q.prompt ?? "Material unavailable"}
                </ActionLink>
              </p>
            ))}
          {d.admission.reasons.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </>
      )}
    </div>
  );
}
