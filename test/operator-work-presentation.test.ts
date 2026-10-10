import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  taskListSummarySchema,
  type InboxItem,
  type TaskListSummary,
} from "../src/operator/contracts.js";
import {
  activeColumns,
  attentionCandidate,
  columnCounts,
  columns,
  filterTasks,
  parseTaskFilters,
  safeSourceUrl,
  taskNext,
  taskRouteSubtitle,
  visibleColumns,
} from "../web/src/tasks.js";
import {
  interventionRequester,
  requestActionLabel,
  requestHref,
  requestKindLabel,
  requestMeta,
  requestTime,
} from "../web/src/request-presentation.js";

type Overrides = {
  title?: string;
  state?: "open" | "done" | "cancelled";
  ready?: boolean;
  projectId?: string;
  execution?: string;
  codes?: string[];
  paused?: boolean;
};
function summary(o: Overrides = {}): TaskListSummary {
  const projectId = o.projectId ?? randomUUID();
  return taskListSummarySchema.parse({
    id: randomUUID(),
    projectId,
    title: o.title ?? "Task",
    version: 1,
    state: o.state ?? "open",
    ready: o.ready ?? true,
    project: {
      id: projectId,
      name: "Project",
      version: 1,
      paused: o.paused ?? false,
      leadProfileId: null,
    },
    lead: null,
    execution: {
      state: o.execution ?? "idle",
      holds: {
        task: false,
        stop: false,
        uncertainty: false,
        writer: false,
        capacity: false,
      },
      reasonCodes: [],
    },
    admission: { eligible: true, reasons: [] },
    capacity: {
      globalUsage: 0,
      globalLimit: 10,
      projectUsage: 0,
      projectLimit: 10,
    },
    source: null,
    attention: { codes: o.codes ?? [], count: o.codes?.length ?? 0 },
  });
}

test("columns follow the design order and Active tasks hides only terminal work", () => {
  assert.deepEqual(
    [...columns],
    [
      "Ready",
      "Running",
      "Waiting",
      "Paused",
      "Stopping",
      "Uncertain",
      "Draft",
      "Done",
      "Cancelled",
    ],
  );
  assert.deepEqual([...activeColumns], columns.slice(0, 7));
  assert.deepEqual([...visibleColumns("")], [...activeColumns]);
  assert.deepEqual([...visibleColumns("all")], [...columns]);
  assert.deepEqual([...visibleColumns("Done")], [...activeColumns, "Done"]);
  assert.deepEqual([...visibleColumns("Stopping")], [...activeColumns]);
  const tasks = [
    summary(),
    summary({ execution: "running" }),
    summary({ state: "done" }),
    summary({ state: "cancelled" }),
    summary({ ready: false }),
  ];
  const counts = columnCounts(tasks);
  assert.equal(counts.Ready, 1);
  assert.equal(counts.Running, 1);
  assert.equal(counts.Draft, 1);
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    tasks.length,
  );
  assert.equal(filterTasks(tasks, parseTaskFilters("")).length, 3);
  assert.equal(filterTasks(tasks, parseTaskFilters("?state=all")).length, 5);
  assert.equal(filterTasks(tasks, parseTaskFilters("?state=Done")).length, 1);
});

test("the next actor is derived from recorded attention and state only", () => {
  const next = (o: Overrides) => taskNext(summary(o));
  assert.equal(next({ codes: ["question"] }), "Next: you · answer question");
  assert.equal(
    next({ codes: ["approval"] }),
    "Next: you · review material & decide",
  );
  assert.equal(
    next({ codes: ["question", "execution-uncertain"] }),
    "Next: you · inspect execution",
  );
  assert.equal(next({ codes: ["lead-review"] }), "Next: you · review task");
  assert.equal(next({ state: "done" }), "Next: none · no decision");
  assert.equal(next({ state: "cancelled" }), "Next: none · history retained");
  assert.equal(next({}), "No operator decision");
  // The Uncertain column alone (no attention code) reads the same in the row and the bar.
  const columnOnly = summary({ execution: "uncertain" });
  assert.equal(taskNext(columnOnly), "Next: you · inspect execution");
  assert.equal(attentionCandidate([summary(), columnOnly]), columnOnly);
});

test("only https source links become anchors", () => {
  assert.equal(
    safeSourceUrl("https://github.com/a/b/issues/1"),
    "https://github.com/a/b/issues/1",
  );
  for (const bad of [
    "javascript:alert(1)",
    "http://x",
    "data:text/html,x",
    "nope",
    "",
    null,
  ])
    assert.equal(safeSourceUrl(bad), null);
});

test("route subtitles count active tasks and name the accountable lead", () => {
  const a = randomUUID(),
    b = randomUUID(),
    lead = randomUUID();
  const workspace = {
    projects: [
      { id: a, leadProfileId: lead },
      { id: b, leadProfileId: null },
    ],
    profiles: [{ id: lead, name: "Mira Chen" }],
  };
  const tasks = [
    summary({ projectId: a }),
    summary({ projectId: a, execution: "running" }),
    summary({ projectId: b }),
    summary({ projectId: b, state: "done" }),
  ];
  assert.equal(
    taskRouteSubtitle("tasks", tasks, workspace),
    "3 active tasks · 2 projects",
  );
  assert.equal(
    taskRouteSubtitle("tasks", [tasks[0] as TaskListSummary], {
      ...workspace,
      projects: [workspace.projects[0] as never],
    }),
    "1 active task · 1 project",
  );
  assert.equal(
    taskRouteSubtitle("project", tasks, workspace, a),
    "2 active tasks · accountable lead Mira Chen",
  );
  assert.equal(
    taskRouteSubtitle("project", tasks, workspace, b),
    "1 active task · no accountable lead",
  );
  assert.equal(taskRouteSubtitle("tasks", undefined, workspace), undefined);
  assert.equal(
    taskRouteSubtitle("overview", undefined, null),
    "Decisions first. Work and completed results stay separate.",
  );
});

test("the attention summary prefers uncertain ownership, then Stopping, and ignores terminal work", () => {
  const stopping = summary({ execution: "stopping" }),
    uncertain = summary({
      codes: ["execution-uncertain"],
      execution: "stopping",
    });
  assert.equal(attentionCandidate([stopping, uncertain]), uncertain);
  assert.equal(attentionCandidate([summary(), stopping]), stopping);
  assert.equal(
    attentionCandidate([
      summary({ state: "done", codes: ["execution-uncertain"] }),
      summary({ state: "cancelled" }),
    ]),
    null,
  );
  assert.equal(attentionCandidate([]), null);
});

test("request wording is exhaustive and links match the Inbox selection", () => {
  const kinds: InboxItem["kind"][] = ["question", "approval", "intervention"];
  assert.deepEqual(kinds.map(requestKindLabel), [
    "Question",
    "Approval",
    "Intervention",
  ]);
  assert.deepEqual(kinds.map(requestActionLabel), [
    "Answer question",
    "Review material & decide",
    "Inspect execution",
  ]);
  const taskId = randomUUID();
  const item = (kind: InboxItem["kind"], rest: object = {}) => ({
    id: "interaction:1/x",
    kind,
    taskId,
    destination:
      kind === "approval"
        ? `/coordination/task/${taskId}#a`
        : `/app/tasks/${taskId}`,
    requesterName: "Jonas",
    createdAt: new Date(2026, 9, 9, 9, 5).getTime(),
    ...rest,
  });
  assert.equal(
    requestHref(item("question")),
    `/app/inbox?task=${taskId}&request=interaction%3A1%2Fx`,
  );
  assert.equal(requestHref(item("approval")), `/coordination/task/${taskId}#a`);
  assert.equal(requestHref(item("intervention")), `/app/tasks/${taskId}`);
  assert.equal(requestMeta(item("question")), "Question · Jonas · 09:05");
  assert.equal(
    requestMeta(item("intervention", { requesterName: null, createdAt: null })),
    "Intervention · Responsibility unknown · Age unknown",
  );
  assert.equal(requestTime(null), "Age unknown");
  // Only an intervention names who is responsible for execution; a question's requester does not.
  const other = { taskId, kind: "question", requesterName: "Nora" } as const;
  assert.equal(interventionRequester([other], taskId), null);
  assert.equal(
    interventionRequester(
      [other, { ...other, kind: "intervention", requesterName: "Jonas" }],
      taskId,
    ),
    "Jonas",
  );
  assert.equal(
    interventionRequester(
      [{ ...other, kind: "intervention", requesterName: null }],
      taskId,
    ),
    null,
  );
  assert.equal(
    interventionRequester(
      [{ ...other, kind: "intervention", taskId: randomUUID() }],
      taskId,
    ),
    null,
  );
});
