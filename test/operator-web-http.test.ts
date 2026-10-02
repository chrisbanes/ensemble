import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  OperatorWebBundle,
  OperatorWebBoundary,
} from "../src/standalone/operator-web.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
test("one guarded listener serves shell and authenticated JSON with rotated CSRF", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const bundlePath = join(f.directory, "bundle");
  await mkdir(join(bundlePath, "assets"), { recursive: true });
  await writeFile(
    join(bundlePath, "index.html"),
    '<html><script src="/assets/main.js"></script></html>',
  );
  await writeFile(join(bundlePath, "assets/main.js"), 'console.log("static");');
  const authFile = join(f.directory, "auth");
  await OperatorAuth.initialize(authFile, "fixture-password");
  let now = 100;
  const auth = await OperatorAuth.open({
    authFile,
    origin: "http://127.0.0.1:8787",
    now: () => now,
    idleTimeoutMs: 1000,
    absoluteTimeoutMs: 3000,
  });
  t.after(() => auth.close());
  const http = new LocalOperatorHttp(
    new LocalOperatorUi(f.service.domain()),
    auth,
    {
      web: new OperatorWebBoundary(
        await OperatorWebBundle.open(bundlePath),
        new OperatorApi(f.service, [f.directory]),
      ),
    },
  );
  const port = await http.start();
  t.after(() => http.stop());
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${origin}/app`)).status, 200);
  assert.equal((await fetch(`${origin}/api/operator/workspace`)).status, 401);
  for (const path of [
    "/api/operator/task-list",
    `/api/operator/projects/${randomUUID()}/composer-options`,
  ])
    assert.equal((await fetch(origin + path)).status, 401);
  let r = await fetch(`${origin}/api/operator/session`);
  let cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  let session = (await r.json()) as { csrfToken: string };
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://127.0.0.1:8787",
        "x-csrf-token": session.csrfToken,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/api/operator/login", { password: "wrong" })).status,
    401,
  );
  const oldCookie = cookie;
  const oldToken = session.csrfToken;
  r = await post("/api/operator/login", { password: "fixture-password" });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  assert.notEqual(cookie, oldCookie);
  assert.notEqual(session.csrfToken, oldToken);
  assert.equal(
    (await fetch(`${origin}/api/operator/workspace`, { headers: { cookie } }))
      .status,
    200,
  );
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Private project",
    leadProfileId: null,
  });
  const create = {
    type: "task.create",
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Task",
    outcome: "Complete",
    ready: false,
  };
  const receipt = await (await post("/api/operator/commands", create)).json();
  const reads = [
    "/api/operator/task-list",
    `/api/operator/projects/${projectId}/composer-options`,
  ];
  for (const path of reads)
    assert.equal(
      (await fetch(origin + path, { headers: { cookie } })).status,
      200,
    );
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1&limit=2",
    "authority=agent",
    "cursor=bad",
  ])
    assert.equal(
      (
        await fetch(`${origin}/api/operator/task-list?${query}`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
  const enriched = {
    ...create,
    key: randomUUID(),
    taskId: randomUUID(),
    blockerTaskIds: [create.taskId],
  };
  for (const body of [
    { ...enriched, actor: "operator" },
    { ...enriched, repositoryAccess: true },
    {
      ...enriched,
      initialAssignment: {
        assignmentId: randomUUID(),
        profileId: randomUUID(),
        resultDestination: "operator",
      },
    },
  ])
    assert.equal((await post("/api/operator/commands", body)).status, 400);
  assert.deepEqual(
    await (await post("/api/operator/commands", create)).json(),
    receipt,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/operator/workspace`, {
        method: "PUT",
        headers: { cookie },
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/operator/workspace`, {
        headers: { cookie: oldCookie },
      })
    ).status,
    401,
  );
  for (const originValue of ["null", "http://foreign.test", ""])
    assert.equal(
      (await post("/api/operator/commands", enriched, { origin: originValue }))
        .status,
      403,
    );
  assert.equal(
    (
      await fetch(`${origin}/api/operator/commands`, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://127.0.0.1:8787",
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: '{"unterminated"',
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("/api/operator/commands", { text: "x".repeat(66000) })).status,
    413,
  );
  const spoof = await new Promise<number>((resolve) => {
    const req = httpRequest(
      `${origin}/api/operator/workspace`,
      {
        headers: {
          host: "evil.test",
          "x-forwarded-host": "127.0.0.1:8787",
          "x-forwarded-proto": "http",
        },
      },
      (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      },
    );
    req.end();
  });
  assert.equal(spoof, 403);
  assert.equal(f.service.domain().tasks(projectId).length, 1);
  assert.equal(
    (
      await post("/api/operator/commands", enriched, {
        "x-csrf-token": "wrong",
      })
    ).status,
    403,
  );

  assert.equal(
    (await post("/api/operator/commands", {}, { origin: "null" })).status,
    403,
  );
  assert.equal(
    (await post("/api/operator/commands", {}, { "x-csrf-token": "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (await post("/api/operator/commands", {}, { "content-type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await post("/api/operator/commands", { actor: "agent" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/operator/commands`, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://127.0.0.1:8787",
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: Buffer.from([0x7b, 0xc3, 0x28]),
      })
    ).status,
    400,
  );
  for (const path of [
    "/assets/no.js",
    "/assets/main.js/extra",
    "/app/unknown",
    "/api/not-real",
  ])
    assert.equal(
      (await fetch(`${origin}${path}`, { headers: { cookie } })).status,
      404,
    );
  now += 1001;
  for (const path of reads)
    assert.equal(
      (await fetch(origin + path, { headers: { cookie } })).status,
      401,
    );
  assert.equal(
    (await fetch(`${origin}/api/operator/workspace`, { headers: { cookie } }))
      .status,
    401,
  );
  assert.equal((await post("/api/operator/commands", create)).status, 401);
  r = await fetch(`${origin}/api/operator/session`);
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  r = await post("/api/operator/login", { password: "fixture-password" });
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  assert.equal((await post("/api/operator/logout", {})).status, 200);
  assert.equal(
    (await fetch(`${origin}/api/operator/workspace`, { headers: { cookie } }))
      .status,
    401,
  );
});
test("bundle denies symlinks, unsupported assets and missing emitted references", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const path = join(f.directory, "bundle");
  await mkdir(join(path, "assets"), { recursive: true });
  await writeFile(
    join(path, "index.html"),
    '<script src="/assets/missing.js"></script>',
  );
  await assert.rejects(OperatorWebBundle.open(path));
  await writeFile(join(path, "index.html"), "<html></html>");
  await writeFile(join(path, "assets/source.map"), "sensitive");
  await assert.rejects(OperatorWebBundle.open(path));
  await unlink(join(path, "assets/source.map"));
  await writeFile(join(f.directory, "private.txt"), "FIXTURE SECRET");
  await symlink(
    join(f.directory, "private.txt"),
    join(path, "assets/linked.js"),
  );
  await assert.rejects(OperatorWebBundle.open(path));
});
test("HTTPS configured origin retains Secure host-only cookie and rejects loopback Origin", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const path = join(f.directory, "https-bundle");
  await mkdir(join(path, "assets"), { recursive: true });
  await writeFile(join(path, "index.html"), "<html></html>");
  const authFile = join(f.directory, "https-auth");
  await OperatorAuth.initialize(authFile, "fixture password");
  const configured = "https://ensemble.fixture.ts.net";
  const auth = await OperatorAuth.open({ authFile, origin: configured });
  t.after(() => auth.close());
  const http = new LocalOperatorHttp(
    new LocalOperatorUi(f.service.domain()),
    auth,
    {
      web: new OperatorWebBoundary(
        await OperatorWebBundle.open(path),
        new OperatorApi(f.service, [f.directory]),
      ),
    },
  );
  const port = await http.start();
  t.after(() => http.stop());
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/operator/session`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /Domain=/);
  const session = (await response.json()) as { csrfToken: string };
  for (const requestOrigin of [origin, configured]) {
    const login = await fetch(`${origin}/api/operator/login`, {
      method: "POST",
      headers: {
        cookie: setCookie.split(";")[0] ?? "",
        origin: requestOrigin,
        "x-csrf-token": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "fixture password" }),
    });
    assert.equal(login.status, requestOrigin === configured ? 200 : 403);
  }
});
