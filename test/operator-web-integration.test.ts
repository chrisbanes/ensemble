import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
test("built React assets, JSON and retained routes share one service listener and receipts survive restart", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const web = await f.startWeb();
  const projectId = randomUUID();
  f.service
    .domain()
    .execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Real project",
      leadProfileId: null,
    });
  let r = await fetch(`${web.origin}/api/operator/session`);
  let cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  let session = (await r.json()) as { csrfToken: string };
  const post = (path: string, body: unknown) =>
    fetch(`${web.origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "x-csrf-token": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  r = await post("/api/operator/login", { password: web.password });
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  assert.equal(r.status, 200);
  const shell = await (await fetch(`${web.origin}/app`)).text();
  const assets = [...shell.matchAll(/(?:src|href)="([^\"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(assets.length >= 2);
  for (const asset of assets)
    assert.equal((await fetch(`${web.origin}${asset}`)).status, 200);
  for (const path of [
    `/project/${projectId}`,
    "/runtime",
    "/coordination",
    "/app",
    `/app/projects/${projectId}`,
    "/api/operator/workspace",
  ])
    assert.equal(
      (await fetch(`${web.origin}${path}`, { headers: { cookie } })).status,
      200,
    );
  const c = {
    type: "task.create",
    key: randomUUID(),
    taskId: randomUUID(),
    projectId,
    title: "Persisted",
    outcome: "Finish",
    ready: true,
  };
  const receipt = await (await post("/api/operator/commands", c)).json();
  assert.deepEqual(
    await (await post("/api/operator/commands", c)).json(),
    receipt,
  );
  await web.close();
  await f.service.stop();
  await f.service.start();
  const reopened = await f.startWeb();
  assert.equal(
    (
      await fetch(`${reopened.origin}/api/operator/workspace`, {
        headers: { cookie },
      })
    ).status,
    401,
  );
  r = await fetch(`${reopened.origin}/api/operator/session`);
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  r = await fetch(`${reopened.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: reopened.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: reopened.password }),
  });
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await r.json()) as { csrfToken: string };
  const replay = await fetch(`${reopened.origin}/api/operator/commands`, {
    method: "POST",
    headers: {
      cookie,
      origin: reopened.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(c),
  });
  assert.deepEqual(await replay.json(), receipt);
  assert.equal(f.service.domain().tasks(projectId).length, 1);
  assert.equal(f.runtime.turns, 0);
});
