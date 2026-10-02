import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
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
  f.service
    .domain()
    .execute({
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
      (await post("/api/operator/commands", create, { origin: originValue }))
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
});
