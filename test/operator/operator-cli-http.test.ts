import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CliError } from "../../src/cli/connections.js";
import { ServiceClient } from "../../src/cli/transport.js";
import { cliCapabilities } from "../../src/operator/contracts.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { tmpdir } from "../fixtures/temp.js";

const DAY = 24 * 60 * 60 * 1000;

test("command transport retains only validated source credential refusal metadata", async () => {
  const command = JSON.stringify({ type: "github.preview" });
  const client = (status: number, body: unknown) =>
    new ServiceClient(
      "https://service.test",
      "test-only-bearer",
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
  const rejected = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("Expected the command to be rejected.");
      },
      (error: unknown) => error,
    );
  const denied = await rejected(
    client(409, {
      error: {
        code: "conflict",
        message: "Actionable source guidance.",
        fieldPaths: ["credentialRef"],
        credentialReason: "gh-not-signed-in",
      },
    }).command(command, 1000),
  );
  assert.ok(denied instanceof CliError);
  assert.equal(denied.extra.status, 409);
  assert.equal(denied.extra.retryable, false);
  assert.equal(denied.extra.credentialReason, "gh-not-signed-in");
  assert.match(
    denied.message,
    /Actionable source guidance.*Fields: credentialRef/,
  );

  for (const [status, body, code, expectedReason] of [
    [
      409,
      {
        error: {
          code: "conflict",
          message: "Malformed metadata.",
          credentialReason: "gh-from-somewhere-else",
        },
      },
      "rejected",
      undefined,
    ],
    [
      409,
      { error: { code: "conflict", message: "Ordinary conflict." } },
      "conflict",
      undefined,
    ],
    [
      503,
      {
        error: {
          code: "conflict",
          message: "Ignored on server failure.",
          credentialReason: "gh-not-signed-in",
        },
      },
      "command-outcome-unknown",
      undefined,
    ],
  ] as const) {
    const error = await rejected(client(status, body).command(command, 1000));
    assert.ok(error instanceof CliError);
    assert.equal(error.code, code);
    assert.equal(error.extra.credentialReason, expectedReason);
  }
});

test("bearer credentials read through the service under server-side route authority", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ensemble-cli-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const s = await startCliService(t, { setup: { home } });
  const read = await s.issue("read", "laptop-ro");
  const write = await s.issue("read-write", "agent-rw");
  const taskPath = `/api/operator/tasks/${s.taskId}`;

  // 1. identity and task read equal the session read.
  let r = await s.bearer(read.token, "/api/operator/cli");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const identity = (await r.json()) as Record<string, unknown>;
  assert.equal(identity.apiVersion, 1);
  assert.deepEqual(identity.capabilities, [...cliCapabilities]);
  assert.deepEqual(identity.service, {
    installationId: s.f.service.operatorCredentials().installationId(),
    origin: s.authOrigin,
  });
  assert.equal((identity.credential as { scope: string }).scope, "read");
  assert.ok(!JSON.stringify(identity).includes(read.token));
  r = await s.bearer(read.token, taskPath);
  assert.equal(r.status, 200);
  const bearerTask = (await r.json()) as {
    data: { task: { version: number } };
  };
  const sessionTask = (await (await s.sessionGet(taskPath)).json()) as {
    data: unknown;
  };
  assert.deepEqual(bearerTask.data, sessionTask.data);
  const version = bearerTask.data.task.version;
  const configure = (expectedVersion: number, key = randomUUID()) => ({
    type: "task.configure",
    key,
    projectId: s.projectId,
    taskId: s.taskId,
    expectedVersion,
    title: "Renamed by CLI",
  });

  // 2. read scope cannot reach write routes.
  for (const [method, path, body] of [
    ["POST", "/api/operator/commands", configure(version)],
    ["POST", "/api/operator/source-refresh", {}],
    ["GET", `/api/operator/tasks/${s.taskId}/comparisons`, undefined],
  ] as const) {
    r = await s.bearer(read.token, path, { method, body });
    assert.equal(r.status, 403, path);
    assert.equal(
      ((await r.json()) as { error: { code: string } }).error.code,
      "insufficient-scope",
    );
  }

  // 3. session-only and legacy routes are denied for both scopes.
  const denied: [string, string, unknown?][] = [
    ["GET", "/api/operator/session"],
    ["POST", "/api/operator/login", { password: "fixture-password" }],
    ["POST", "/api/operator/logout", {}],
    ["POST", "/api/operator/setup/folders", { path: "" }],
    ["POST", "/api/operator/setup/verify-checkout", {}],
    ["GET", "/api/operator/setup/home"],
    ["GET", `/api/operator/tasks/${s.taskId}/review-draft`],
    ["GET", `/api/operator/tasks/${s.taskId}/local-reviews`],
    ["GET", `/api/operator/tasks/${s.taskId}/local-reviews/${randomUUID()}`],
    ["GET", `/api/operator/projects/${s.projectId}/private-values`],
    ["GET", `/api/operator/profiles/${randomUUID()}/private-values`],
    ["GET", "/api/operator/credentials"],
    ["POST", "/api/operator/credentials", { name: "x", scope: "read-write" }],
    ["POST", `/api/operator/credentials/${read.credential.id}/rotate`, {}],
    ["POST", `/api/operator/credentials/${read.credential.id}/revoke`, {}],
    ["GET", "/"],
    ["GET", `/task/${s.taskId}`],
    ["GET", "/app"],
    ["GET", "/assets/main.js"],
    ["POST", "/command", {}],
    ["POST", `/coordination/task/${s.taskId}`, {}],
  ];
  for (const token of [read.token, write.token])
    for (const [method, path, body] of denied) {
      r = await s.bearer(token, path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.headers.get("set-cookie"), null);
      assert.ok(!(await r.text()).includes(home), `${method} ${path}`);
    }
  assert.equal(
    s.f.service.operatorCredentials().list().length,
    2,
    "no credential created",
  );
  const unchanged = (await (await s.sessionGet(taskPath)).json()) as {
    data: { task: { version: number; title: string } };
  };
  assert.equal(unchanged.data.task.version, version);
  assert.equal(unchanged.data.task.title, "Inspect me");

  // 4. read-write writes use the same command path, conflicts and receipts.
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure(version + 5),
  });
  assert.equal(r.status, 409);
  const sessionConflict = await s.sessionPost(
    "/api/operator/commands",
    configure(version + 5),
  );
  assert.equal(sessionConflict.status, 409);
  assert.deepEqual(await r.json(), await sessionConflict.json());
  const command = configure(version);
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: command,
  });
  assert.equal(r.status, 200);
  const receipt = await r.json();
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: command,
  });
  assert.deepEqual(await r.json(), receipt);
  const after = (await (await s.sessionGet(taskPath)).json()) as {
    data: { task: { version: number; title: string } };
  };
  assert.equal(after.data.task.version, version + 1);
  assert.equal(after.data.task.title, "Renamed by CLI");

  // 5. credential failures are uniform.
  const expired = s.f.service
    .operatorCredentials()
    .issue(
      { name: "old", scope: "read", expiresInDays: 1 },
      Date.now() - 2 * DAY,
    );
  const revoked = await s.issue("read", "revoked");
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${revoked.credential.id}/revoke`,
        {},
      )
    ).status,
    200,
  );
  for (const authorization of [
    `Bearer ${expired.token}`,
    `Bearer ${revoked.token}`,
    `Bearer ${read.token.slice(0, -2)}xx`,
    "Bearer",
    "Bearer ",
    "Basic x",
    `Bearer ${read.token} ${write.token}`,
    read.token,
  ]) {
    r = await fetch(`${s.origin}/api/operator/cli`, {
      headers: { authorization },
    });
    assert.equal(r.status, 401, authorization.slice(0, 12));
    assert.deepEqual(await r.json(), {
      error: {
        code: "credential-invalid",
        message: "Operator credential is invalid.",
      },
    });
  }
  r = await s.bearer(read.token, "/api/operator/unknown");
  assert.equal(r.status, 404);
  r = await s.bearer(read.token, "/api/operator/workspace", { method: "PUT" });
  assert.equal(r.status, 405);

  // 6. a bearer request carrying a session cookie gets no cookie authority.
  r = await s.bearer(write.token, "/api/operator/credentials", {
    method: "POST",
    body: { name: "escalate", scope: "read-write" },
    headers: { cookie: s.cookie, origin: s.authOrigin },
  });
  assert.equal(r.status, 403);
  r = await fetch(`${s.origin}/api/operator/workspace`, {
    headers: { cookie: s.cookie, authorization: "Bearer nope" },
  });
  assert.equal(r.status, 401);

  // 7. browser protections still apply to session writes.
  assert.equal(
    (
      await s.sessionPost(
        "/api/operator/credentials",
        {
          name: "x",
          scope: "read",
        },
        { origin: "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await s.sessionPost(
        "/api/operator/credentials",
        {
          name: "x",
          scope: "read",
        },
        { "x-csrf-token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal((await s.sessionGet("/api/operator/workspace")).status, 200);
  assert.equal(
    (await fetch(`${s.origin}/api/operator/credentials`)).status,
    401,
  );
});

test("session credential endpoints reveal a token only when issued", async (t) => {
  const s = await startCliService(t);
  let r = await s.sessionPost("/api/operator/credentials", {
    name: "agent",
    scope: "read-write",
    expiresInDays: 30,
  });
  assert.equal(r.status, 200);
  const issued = (await r.json()) as {
    token: string;
    credential: { id: string; expiresAt: number; createdAt: number };
  };
  assert.equal(
    issued.credential.expiresAt - issued.credential.createdAt,
    30 * DAY,
  );
  for (const body of [
    { name: "", scope: "read" },
    { name: "x".repeat(65), scope: "read" },
    { name: "x", scope: "admin" },
    { name: "x", scope: "read", expiresInDays: 91 },
    { name: "x", scope: "read", token: "chosen" },
  ])
    assert.equal(
      (await s.sessionPost("/api/operator/credentials", body)).status,
      400,
    );
  let listText = await (await s.sessionGet("/api/operator/credentials")).text();
  assert.ok(!listText.includes(issued.token));
  assert.ok(!listText.includes('"token"'));
  r = await s.sessionPost(
    `/api/operator/credentials/${issued.credential.id}/rotate`,
    {},
  );
  assert.equal(r.status, 200);
  const rotated = (await r.json()) as {
    token: string;
    credential: { id: string; replacesId: string };
  };
  assert.equal(rotated.credential.replacesId, issued.credential.id);
  assert.equal((await s.bearer(issued.token, "/api/operator/cli")).status, 200);
  assert.equal(
    (await s.bearer(rotated.token, "/api/operator/cli")).status,
    200,
  );
  r = await s.sessionPost(
    `/api/operator/credentials/${issued.credential.id}/revoke`,
    {},
  );
  assert.equal(r.status, 200);
  assert.equal(
    ((await r.json()) as { credential: { state: string } }).credential.state,
    "revoked",
  );
  assert.equal((await s.bearer(issued.token, "/api/operator/cli")).status, 401);
  assert.equal(
    (await s.bearer(rotated.token, "/api/operator/cli")).status,
    200,
  );
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${issued.credential.id}/rotate`,
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${randomUUID()}/revoke`,
        {},
      )
    ).status,
    404,
  );
  listText = await (await s.sessionGet("/api/operator/credentials")).text();
  assert.ok(
    !listText.includes(issued.token) && !listText.includes(rotated.token),
  );
  const list = JSON.parse(listText) as {
    data: {
      credentials: { id: string; state: string; lastUsedAt: number | null }[];
    };
  };
  assert.deepEqual(
    list.data.credentials.map((c) => c.state),
    ["revoked", "active"],
  );
  assert.ok(list.data.credentials[1]?.lastUsedAt);
});

test("every known API route has an explicit authority", () => {
  const id = randomUUID();
  const representative = [
    "/api/operator/session",
    "/api/operator/runtime",
    "/api/operator/login",
    "/api/operator/logout",
    "/api/operator/workspace",
    "/api/operator/task-list",
    "/api/operator/inbox",
    "/api/operator/search",
    "/api/operator/commands",
    "/api/operator/source-refresh",
    "/api/operator/source-observations",
    "/api/operator/discovery",
    "/api/operator/claude-token",
    "/api/operator/readiness",
    "/api/operator/readiness/claude-token",
    "/api/operator/discovery/repositories",
    "/api/operator/discovery/branches",
    "/api/operator/discovery/projects",
    "/api/operator/discovery/project-fields",
    "/api/operator/setup/folders",
    "/api/operator/setup/verify-checkout",
    "/api/operator/setup/home",
    "/api/operator/cli",
    "/api/operator/credentials",
    `/api/operator/credentials/${id}/rotate`,
    `/api/operator/credentials/${id}/revoke`,
    "/api/operator/notifications",
    "/api/operator/notifications/subscriptions",
    `/api/operator/notifications/subscriptions/${id}/revoke`,
    `/api/operator/notifications/subscriptions/${id}/test`,
    `/api/operator/projects/${id}/configuration`,
    `/api/operator/profiles/${id}/configuration`,
    `/api/operator/projects/${id}`,
    `/api/operator/tasks/${id}`,
    `/api/operator/tasks/${id}/review`,
    `/api/operator/tasks/${id}/artifacts/${id}`,
    `/api/operator/tasks/${id}/files`,
    `/api/operator/tasks/${id}/preview`,
    `/api/operator/tasks/${id}/results/${id}/evidence`,
    `/api/operator/tasks/${id}/results/${id}/evidence/${id}`,
    `/api/operator/tasks/${id}/review-anchors/${id}`,
    `/api/operator/tasks/${id}/review-draft`,
    `/api/operator/tasks/${id}/local-reviews`,
    `/api/operator/tasks/${id}/local-reviews/${id}`,
    `/api/operator/projects/${id}/private-values`,
    `/api/operator/profiles/${id}/private-values`,
    `/api/operator/tasks/${id}/comparisons`,
    `/api/operator/tasks/${id}/questions/${id}`,
    `/api/operator/projects/${id}/composer-options`,
    `/api/operator/assignments/${id}/history`,
    `/api/operator/assignments/${id}/recovery`,
    `/api/operator/assignments/${id}/recovery-options`,
    `/api/operator/tasks/${id}/results`,
    `/api/operator/tasks/${id}/messages`,
    `/api/operator/assignments/${id}`,
    `/api/operator/assignments/${id}/instructions`,
    `/api/operator/projects/${id}/instructions`,
    `/api/operator/profiles/${id}/instructions`,
    "/api/operator/operations",
    `/api/operator/projects/${id}/impact`,
    `/api/operator/profiles/${id}/impact`,
    "/api/operator/executions",
    `/api/operator/executions/assignment:${id}:initial`,
    `/api/operator/executions/assignment:${id}:initial/inputs`,
    `/api/operator/executions/assignment:${id}:initial/events`,
  ];
  for (const path of [
    `/api/operator/tasks/${id}/results`,
    `/api/operator/tasks/${id}/messages`,
    `/api/operator/assignments/${id}`,
    `/api/operator/assignments/${id}/instructions`,
    `/api/operator/projects/${id}/instructions`,
    `/api/operator/profiles/${id}/instructions`,
    "/api/operator/operations",
    `/api/operator/projects/${id}/impact`,
    `/api/operator/profiles/${id}/impact`,
    "/api/operator/executions",
    `/api/operator/executions/assignment:${id}:initial`,
    `/api/operator/executions/assignment:${id}:initial/inputs`,
    `/api/operator/executions/assignment:${id}:initial/events`,
    `/api/operator/assignments/${id}/recovery-options`,
    "/api/operator/discovery/project-fields",
  ])
    assert.equal(operatorRouteAuthority("GET", path), "read", path);
  assert.equal(
    operatorRouteAuthority("POST", "/api/operator/discovery/project-fields"),
    undefined,
  );
  assert.equal(
    operatorRouteAuthority(
      "POST",
      `/api/operator/assignments/${id}/recovery-options`,
    ),
    undefined,
  );
  for (const path of representative) {
    assert.ok(
      operatorRouteAuthority("GET", path) ??
        operatorRouteAuthority("POST", path),
      path,
    );
  }
  // Browser push controls belong to the operator's browser session alone.
  for (const [method, path] of [
    ["GET", "/api/operator/notifications"],
    ["POST", "/api/operator/notifications/subscriptions"],
    ["POST", `/api/operator/notifications/subscriptions/${id}/revoke`],
    ["POST", `/api/operator/notifications/subscriptions/${id}/test`],
  ] as const)
    assert.equal(operatorRouteAuthority(method, path), "session-only", path);
  for (const [method, path] of [
    ["POST", "/api/operator/notifications"],
    ["GET", "/api/operator/notifications/subscriptions"],
    ["GET", `/api/operator/notifications/subscriptions/${id}/revoke`],
    ["DELETE", `/api/operator/notifications/subscriptions/${id}`],
    ["DELETE", "/api/operator/notifications"],
    ["POST", `/api/operator/notifications/subscriptions/${id}/other`],
  ] as const)
    assert.equal(operatorRouteAuthority(method, path), undefined, path);
  assert.equal(
    operatorRouteAuthority("GET", "/api/operator/future"),
    undefined,
  );
  assert.equal(
    operatorRouteAuthority("DELETE", `/api/operator/tasks/${id}`),
    undefined,
  );
  assert.equal(
    operatorRouteAuthority("POST", `/api/operator/tasks/${id}`),
    undefined,
  );
});

test("Stop and Resume are receipted commands under bearer scope; retained forms stay session-only", async (t) => {
  const s = await startCliService(t, {
    service: { supervisor: { observationMs: 50 } },
  });
  const read = await s.issue("read", "control-ro");
  const write = await s.issue("read-write", "control-rw");
  const command = (type: string, key = randomUUID()) => ({
    type,
    key,
    taskId: s.taskId,
  });
  const before = databaseDigest(s.f);
  for (const type of ["task.stop", "task.resume"]) {
    const r = await s.bearer(read.token, "/api/operator/commands", {
      method: "POST",
      body: command(type),
    });
    assert.equal(r.status, 403, type);
    assert.equal(
      ((await r.json()) as { error: { code: string } }).error.code,
      "insufficient-scope",
    );
  }
  for (const token of [read.token, write.token])
    for (const path of ["/runtime/control/stop", "/runtime/control/resume"]) {
      const r = await fetch(`${s.origin}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ taskId: s.taskId }).toString(),
      });
      assert.equal(r.status, 403, path);
    }
  assert.equal(databaseDigest(s.f), before);
  assert.equal(s.f.service.isTaskStopped(s.taskId), false);

  const stop = command("task.stop");
  let r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: stop,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    kind: "task-stop",
    key: stop.key,
    recorded: true,
    taskId: s.taskId,
    cancellationRequested: 0,
  });
  assert.equal(s.f.service.isTaskStopped(s.taskId), true);
  r = await s.sessionPost("/api/operator/commands", command("task.resume"));
  assert.equal(r.status, 200);
  const resumed = (await r.json()) as Record<string, unknown>;
  assert.equal(resumed.kind, "task-resume");
  assert.equal(resumed.stopCleared, true);
  assert.equal(s.f.service.isTaskStopped(s.taskId), false);
  // The retained session form still works and shares the hold.
  r = await s.sessionForm("/runtime/control/stop", { taskId: s.taskId });
  assert.equal(r.status, 303);
  assert.equal(s.f.service.isTaskStopped(s.taskId), true);
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: { ...stop, expectedVersion: 1 },
  });
  assert.equal(r.status, 409, "same key, other content");
});

test("task.stop on a finished task is a plain 409 and Resume still clears its Stop", async (t) => {
  const s = await startCliService(t, {
    service: { supervisor: { observationMs: 50 } },
  });
  const write = await s.issue("read-write", "finished-rw");
  const post = (type: string) =>
    s.bearer(write.token, "/api/operator/commands", {
      method: "POST",
      body: { type, key: randomUUID(), taskId: s.taskId },
    });
  for (const [state, label] of [
    ["done", "Done"],
    ["cancelled", "Cancelled"],
  ] as const) {
    s.f.seedPersistedState((db) => {
      db.prepare("UPDATE domain_tasks SET state = ? WHERE id = ?").run(
        state,
        s.taskId,
      );
    });
    const before = databaseDigest(s.f);
    const r = await post("task.stop");
    assert.equal(r.status, 409, state);
    const { error } = (await r.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(error.code, "conflict");
    assert.equal(
      error.message,
      `Only an open task can be stopped. This task is ${label}.`,
    );
    assert.equal(databaseDigest(s.f), before);
    s.f.seedPersistedState((db) => {
      db.prepare(
        "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
      ).run(s.taskId);
    });
    const resumed = await post("task.resume");
    assert.equal(resumed.status, 200, state);
    assert.equal(
      ((await resumed.json()) as { stopCleared: boolean }).stopCleared,
      true,
    );
  }
  s.f.seedPersistedState((db) => {
    db.prepare("UPDATE domain_tasks SET state = 'open' WHERE id = ?").run(
      s.taskId,
    );
  });
  assert.equal((await post("task.stop")).status, 200);
});

test("review commands need a browser review session: a bearer write token is forbidden, not unauthenticated", async (t) => {
  const s = await startCliService(t);
  const write = await s.issue("read-write", "review-rw");
  const base = { key: randomUUID(), taskId: s.taskId, expectedDraftVersion: 0 };
  for (const command of [
    { ...base, type: "review.draft.discard" },
    {
      ...base,
      type: "review.send",
      recipientAssignmentId: randomUUID(),
      expectedAssignmentVersion: 1,
    },
  ]) {
    const r = await s.bearer(write.token, "/api/operator/commands", {
      method: "POST",
      body: command,
    });
    assert.equal(r.status, 403, command.type);
    assert.equal(
      ((await r.json()) as { error: { code: string } }).error.code,
      "forbidden",
    );
  }
});
