import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  bbCli,
  fixtureGit,
  rpc,
  startBb,
  stopBb,
  waitFor,
  withFixture,
} from "./harness.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const taskId = "20000000-0000-4000-8000-000000000001";
const assignmentId = "20000000-0000-4000-8000-000000000002";

function command(name, args) {
  return `call_tool:${name} tool_args:${Buffer.from(JSON.stringify(args)).toString("base64url")}`;
}

async function execution(instance, operation, args) {
  return rpc(instance, "execution.run", { operation, args });
}

async function toolResults(instance) {
  const lines = await readFile(instance.env.SCRIPTED_ECHO_RECORD_PATH, "utf8");
  return lines
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === "t1/tool-result")
    .map((entry) => entry.params);
}

function returnedJson(record) {
  assert.equal(record.error, null);
  assert.equal(record.result.success, true, JSON.stringify(record));
  const content = record.result.contentItems.find(
    (item) => item.type === "inputText",
  );
  assert(content, "Production tool did not return text to the provider");
  return JSON.parse(content.text);
}

async function idle(instance, threadId) {
  await waitFor(
    async () =>
      (await execution(instance, "get", { threadId })).status === "idle",
    `prototype thread ${threadId} to become idle`,
  );
}

async function call(instance, threadId, name, args) {
  await idle(instance, threadId);
  const before = (await toolResults(instance)).length;
  await execution(instance, "send", {
    threadId,
    mode: "start",
    input: [{ type: "text", text: command(name, args), mentions: [] }],
  });
  const record = await waitFor(
    async () =>
      (await toolResults(instance))
        .slice(before)
        .find((entry) => entry.toolName === name),
    `production ${name} result`,
  );
  if (record.error === null) await idle(instance, threadId);
  else
    await waitFor(
      async () =>
        ["idle", "error"].includes(
          (await execution(instance, "get", { threadId })).status,
        ),
      "rejected production tool turn to settle",
    );
  return record;
}

function storedIdentity(instance, pluginId) {
  const db = new DatabaseSync(
    path.join(instance.env.BB_DATA_DIR, "plugins", pluginId, "data.db"),
    { readOnly: true },
  );
  try {
    const task = db
      .prepare("SELECT id, projectId FROM tasks WHERE id = ?")
      .get(taskId);
    const assignment = db
      .prepare(
        "SELECT id, taskId, projectId, state, result FROM assignments WHERE id = ?",
      )
      .get(assignmentId);
    assert(task);
    assert(assignment);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM project_host_bindings").get()
        .count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_bindings").get()
        .count,
      1,
    );
    return { task, assignment };
  } finally {
    db.close();
  }
}

test("production BB adapter creates, delegates, reports and preserves core identity across restart", async () => {
  await withFixture(async (instance) => {
    const fixture = await bbCli(
      instance,
      "plugin",
      "install",
      `path:${instance.fixtureDirectory}`,
      "--yes",
    );
    assert.equal(fixture.plugin.status, "running");
    const production = path.join(instance.root, "production");
    await mkdir(production);
    await cp(path.join(repositoryRoot, "src"), path.join(production, "src"), {
      recursive: true,
    });
    await cp(
      path.join(repositoryRoot, "package.json"),
      path.join(production, "package.json"),
    );
    await symlink(
      path.join(repositoryRoot, "node_modules"),
      path.join(production, "node_modules"),
      "dir",
    );
    const installed = await bbCli(
      instance,
      "plugin",
      "install",
      `path:${production}`,
      "--yes",
    );
    assert.equal(installed.plugin.status, "running");
    const pluginId = installed.plugin.id;

    const machine = (await bbCli(instance, "machine", "list")).find(
      (item) => item.status === "connected",
    );
    assert(machine);
    const root = path.join(instance.root, "prototype-repository");
    await mkdir(root);
    await writeFile(
      path.join(root, "README.md"),
      "Disposable prototype fixture\n",
    );
    await fixtureGit(instance, ["init", "-b", "main", root]);
    await fixtureGit(instance, ["-C", root, "add", "README.md"]);
    await fixtureGit(instance, [
      "-C",
      root,
      "-c",
      "user.name=Prototype Fixture",
      "-c",
      "user.email=prototype@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ]);
    const project = await bbCli(
      instance,
      "project",
      "create",
      "--name",
      "Prototype fixture",
      "--root",
      root,
      "--machine",
      machine.id,
    );
    const spawn = () =>
      execution(instance, "spawn", {
        projectId: project.id,
        prompt: "Prototype coordinator ready",
        providerId: "ensemble-scripted",
        model: "fixture-model",
        permissionMode: "accept-edits",
        environment: {
          type: "host",
          hostId: machine.id,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
      });
    const lead = await spawn();
    await idle(instance, lead.id);
    for (const [key, value] of Object.entries({
      project: project.id,
      coordinatorThread: lead.id,
      provider: "ensemble-scripted",
      model: "fixture-model",
      instructions: "Report the fixture result using the assignment brief.",
    }))
      await bbCli(instance, "plugin", "config", pluginId, "set", key, value);

    const created = returnedJson(
      await call(instance, lead.id, "ensemble_create_task", {
        id: taskId,
        title: "Portability fixture",
      }),
    );
    assert.equal(created.id, taskId);
    assert.equal(created.projectId, project.id);
    const brief = command("ensemble_report", {
      assignmentId,
      result: "portable result",
    });
    const delegated = returnedJson(
      await call(instance, lead.id, "ensemble_delegate", {
        id: assignmentId,
        taskId,
        brief,
      }),
    );
    assert.equal(delegated.id, assignmentId);
    assert.equal(delegated.projectId, project.id);
    assert.equal(typeof delegated.threadId, "string");
    const report = await waitFor(
      async () =>
        (await toolResults(instance)).find(
          (item) => item.toolName === "ensemble_report",
        ),
      "production worker report",
    );
    assert.equal(returnedJson(report).result, "portable result");
    await idle(instance, delegated.threadId);
    const rows = returnedJson(
      await call(instance, lead.id, "ensemble_assignments", {}),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "completed");
    assert.equal(rows[0].threadId, delegated.threadId);
    const stranger = await spawn();
    const denied = await call(instance, stranger.id, "ensemble_report", {
      assignmentId,
      result: "intruder",
    });
    assert(
      denied.error !== null || denied.result?.success === false,
      "Foreign conversation unexpectedly reported a result",
    );
    const threadIds = async () =>
      (
        await bbCli(
          instance,
          "thread",
          "list",
          "--project",
          project.id,
          "--include-hidden",
        )
      )
        .map((thread) => thread.id)
        .sort();
    const beforeThreads = await threadIds();
    assert.deepEqual(
      beforeThreads,
      [lead.id, delegated.threadId, stranger.id].sort(),
    );

    await stopBb(instance);
    const before = storedIdentity(instance, pluginId);
    assert.notEqual(before.task.projectId, project.id);
    assert.equal(before.assignment.projectId, before.task.projectId);
    assert.equal(before.assignment.result, "portable result");
    Object.assign(
      instance,
      await startBb(instance.root, instance.runtimeManifest),
    );
    const recovered = returnedJson(
      await call(instance, lead.id, "ensemble_assignments", {}),
    );
    assert.deepEqual(recovered, rows);
    const replay = returnedJson(
      await call(instance, lead.id, "ensemble_delegate", {
        id: assignmentId,
        taskId,
        brief,
      }),
    );
    assert.deepEqual(replay, rows[0]);
    assert.deepEqual(
      await threadIds(),
      beforeThreads,
      "Replay created another BB worker",
    );
    await stopBb(instance);
    assert.deepEqual(storedIdentity(instance, pluginId), before);
    instance.runtimeManifest.checks.productionPrototype = {
      status: "passed",
      realProductionEntry: true,
      taskId,
      assignmentId,
      independentProjectIdentity: true,
      foreignReportDenied: true,
      persistedAcrossRestart: true,
      replayedWithoutDuplicateAssignment: true,
    };
  });
});
