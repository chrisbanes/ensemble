import {
  taskListPageSchema,
  uuid,
  type TaskListPage,
  type TaskListSummary,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
export const columns = [
  "Ready",
  "Running",
  "Waiting",
  "Paused",
  "Stopping",
  "Uncertain",
  "Draft",
  "Done",
  "Cancelled",
] as const;
export type TaskColumn = (typeof columns)[number];
/** Everything except the terminal columns: unfinished work, Draft included. */
export const activeColumns: readonly TaskColumn[] = columns.slice(0, 7);
export const isActiveColumn = (column: TaskColumn) =>
  activeColumns.includes(column);
/** `state` is empty (Active tasks), `all`, or one column; a terminal choice adds its column. */
export function visibleColumns(state: string): readonly TaskColumn[] {
  if (state === "all") return columns;
  const extra = columns.find((c) => c === state && !isActiveColumn(c));
  return extra ? [...activeColumns, extra] : activeColumns;
}
export function columnCounts(tasks: readonly TaskListSummary[]) {
  const counts = Object.fromEntries(columns.map((c) => [c, 0])) as Record<
    TaskColumn,
    number
  >;
  for (const task of tasks) counts[taskColumn(task)]++;
  return counts;
}
export interface TaskAggregate {
  tasks: TaskListSummary[];
  firstObservedAt: number;
  lastObservedAt: number;
}
export async function loadTaskList(
  client: OperatorClient,
  signal?: AbortSignal,
): Promise<TaskAggregate> {
  const tasks: TaskListSummary[] = [];
  let cursor: string | null = null,
    fingerprint: string | undefined,
    firstObservedAt = 0,
    lastObservedAt = 0;
  for (let page = 0; page < 100; page++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result: TaskListPage = await client.read(
      `/api/operator/task-list${cursor ? `?cursor=${cursor}` : ""}`,
      taskListPageSchema,
      signal,
    );
    if (
      fingerprint !== undefined &&
      fingerprint !== result.data.catalogFingerprint
    )
      throw Error("catalog-changed");
    fingerprint = result.data.catalogFingerprint;
    if (page === 0) firstObservedAt = result.observedAt;
    lastObservedAt = result.observedAt;
    for (const task of result.data.tasks) {
      const prior = tasks.at(-1)?.id ?? cursor;
      if (prior && task.id <= prior) throw Error("invalid-catalog-order");
      tasks.push(task);
    }
    if (tasks.length > 10000) throw Error("catalog-too-large");
    const next: string | null = result.data.nextCursor;
    if (next === null) return { tasks, firstObservedAt, lastObservedAt };
    if (
      next === cursor ||
      next !== tasks.at(-1)?.id ||
      result.data.tasks.length === 0
    )
      throw Error("invalid-catalog-cursor");
    cursor = next;
  }
  throw Error("catalog-too-large");
}
export function taskColumn(task: TaskListSummary): TaskColumn {
  const s = task.execution.state;
  if (s === "stopping") return "Stopping";
  if (s === "uncertain") return "Uncertain";
  if (s === "running" || s === "starting") return "Running";
  if (task.state === "done") return "Done";
  if (task.state === "cancelled") return "Cancelled";
  if (task.project.paused || s === "paused") return "Paused";
  if (!task.ready) return "Draft";
  if (!task.admission.eligible || s === "waiting" || task.execution.holds.task)
    return "Waiting";
  return "Ready";
}
export const taskDetailHref = (task: Pick<TaskListSummary, "id">) =>
  `/app/tasks/${task.id}`;
export interface TaskFilters {
  project: string;
  state: string;
  source: string;
  ready: string;
  q: string;
  view: "list" | "board";
}
export function parseTaskFilters(search: string): TaskFilters {
  const p = new URLSearchParams(search),
    project = p.get("project") ?? "",
    state = p.get("state") ?? "",
    source = p.get("source") ?? "",
    ready = p.get("ready") ?? "";
  return {
    project: uuid.safeParse(project).success ? project : "",
    state: state === "all" || columns.some((c) => c === state) ? state : "",
    source: source === "local" || source === "github" ? source : "",
    ready: ready === "yes" || ready === "no" ? ready : "",
    q: (p.get("q") ?? "").slice(0, 512),
    view: p.get("view") === "board" ? "board" : "list",
  };
}
export function taskFiltersUrl(path: string, filters: TaskFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value && !(key === "view" && value === "list")) params.set(key, value);
  return path + (params.size ? `?${params}` : "");
}
export function filterTasks(
  tasks: TaskListSummary[],
  f: TaskFilters,
  projectId?: string,
) {
  const query = f.q.toLocaleLowerCase();
  return tasks.filter(
    (t) =>
      (!projectId || t.projectId === projectId) &&
      (!f.project || projectId || t.projectId === f.project) &&
      (f.state === "all" ||
        (f.state
          ? taskColumn(t) === f.state
          : isActiveColumn(taskColumn(t)))) &&
      (!f.source || (f.source === "github") === Boolean(t.source)) &&
      (!f.ready || t.ready === (f.ready === "yes")) &&
      (!query ||
        [t.title, t.project.name, t.lead?.name, t.source?.repositoryName].some(
          (v) => v?.toLocaleLowerCase().includes(query),
        )),
  );
}
export const reasonLabels = {
  "project-paused": "Project paused",
  "project-lead-unconfigured": "Configure a project lead",
  "project-lead-revoked": "Project lead revoked",
  "task-unready": "Draft: not Ready",
  "task-not-open": "Task closed",
  "local-dependency": "Waiting on a task dependency",
  "imported-blockers-unknown": "GitHub dependencies unavailable",
  "imported-blockers-blocked": "Waiting on a GitHub dependency",
  "source-held": "Source requires review",
  "admission-blocked": "Admission held",
  question: "Question needs an answer",
  approval: "Approval needs a decision",
  "unresolved-result": "Result destination needs attention",
  "completion-rejected": "Completion requires review",
  "execution-uncertain": "Execution ownership is uncertain",
  "lead-review": "Allocation requires lead review",
} satisfies Record<string, string>;
export function taskReasons(task: TaskListSummary) {
  const terminal = task.state === "done" || task.state === "cancelled";
  const reasons: string[] = [
    ...task.attention.codes.map((code) => reasonLabels[code]),
    ...(terminal ? [] : task.admission.reasons).map(
      (r) => reasonLabels[r] ?? "Admission held",
    ),
  ];
  if (task.execution.holds.stop)
    reasons.unshift("Stop requested; effects may continue");
  if (
    task.execution.holds.uncertainty ||
    task.execution.reasonCodes.includes("runtime-unconfirmed")
  )
    reasons.unshift(reasonLabels["execution-uncertain"]);
  if (
    !terminal &&
    (task.capacity.globalUsage >= task.capacity.globalLimit ||
      task.capacity.projectUsage >= task.capacity.projectLimit)
  )
    reasons.push("Capacity currently full; admission rechecks usage");
  return [...new Set(reasons)];
}
const nextActions = [
  ["execution-uncertain", "inspect execution"],
  ["approval", "review material & decide"],
  ["question", "answer question"],
  ["unresolved-result", "resolve result destination"],
  ["completion-rejected", "review rejected completion"],
  ["lead-review", "review task"],
] as const;
/** Who acts next, from recorded facts only; an attention code always names the operator. */
export function taskNext(task: TaskListSummary) {
  const action = nextActions.find(([code]) =>
    task.attention.codes.includes(code),
  );
  if (action) return `Next: you · ${action[1]}`;
  const column = taskColumn(task);
  if (column === "Done") return "Next: none · no decision";
  if (column === "Cancelled") return "Next: none · history retained";
  return "No operator decision";
}
/** zod's url() also accepts javascript: and data:, so only https links become anchors. */
export function safeSourceUrl(url: string | null | undefined) {
  try {
    return url && new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
export function taskRouteSubtitle(
  kind: "overview" | "tasks" | "project",
  tasks: readonly TaskListSummary[] | undefined,
  workspace: {
    projects: readonly { id: string; leadProfileId: string | null }[];
    profiles: readonly { id: string; name: string | null }[];
  } | null,
  projectId?: string,
) {
  if (kind === "overview")
    return "Decisions first. Work and completed results stay separate.";
  if (!tasks) return undefined;
  const scoped = tasks.filter(
    (t) =>
      (kind === "tasks" || t.projectId === projectId) &&
      isActiveColumn(taskColumn(t)),
  );
  const count = plural(scoped.length, "active task");
  if (kind === "tasks")
    return `${count} · ${plural(workspace?.projects.length ?? new Set(tasks.map((t) => t.projectId)).size, "project")}`;
  const leadId = workspace?.projects.find(
    (p) => p.id === projectId,
  )?.leadProfileId;
  if (!leadId) return `${count} · no accountable lead`;
  const lead = workspace?.profiles.find((p) => p.id === leadId)?.name;
  return `${count} · accountable lead ${lead ?? "name unavailable"}`;
}
/** The one task the persistent attention summary names: uncertain ownership beats Stopping. */
export function attentionCandidate(tasks: readonly TaskListSummary[]) {
  const active = tasks.filter((t) => isActiveColumn(taskColumn(t)));
  const uncertain = active.find(
    (t) =>
      t.attention.codes.includes("execution-uncertain") ||
      taskColumn(t) === "Uncertain",
  );
  return uncertain ?? active.find((t) => taskColumn(t) === "Stopping") ?? null;
}
