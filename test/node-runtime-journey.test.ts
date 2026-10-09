import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";

test(`service and operator journey on ${process.version}: start, login, graceful shutdown`, {
  timeout: 60000,
}, async () => {
  const where = `Node ${process.version}`;
  const f = await createOperatorFixture();
  let closed = false;
  try {
    const web = await f.startWeb();
    const get = (path: string, cookie = "") =>
      fetch(`${web.origin}${path}`, { headers: cookie ? { cookie } : {} });

    let r = await get("/api/operator/session");
    let cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = (await r.json()) as { csrfToken: string };
    assert.ok(cookie && session.csrfToken, `${where}: session cookie`);
    assert.equal((await get("/api/operator/workspace")).status, 401, where);

    r = await fetch(`${web.origin}/api/operator/login`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "x-csrf-token": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: web.password }),
    });
    assert.equal(r.status, 200, `${where}: login`);
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.equal(
      (await get("/api/operator/workspace", cookie)).status,
      200,
      where,
    );
    assert.equal((await get("/app")).status, 200, where);

    await f.close();
    closed = true;
    await assert.rejects(fetch(web.origin), /./, `${where}: listener`);
    await assert.rejects(
      stat(f.directory),
      { code: "ENOENT" },
      `${where}: private data removed`,
    );
    const cleanup = f.lifecycle.steps.filter((s) => s.phase === "cleanup");
    assert.ok(cleanup.length > 0, where);
    assert.ok(
      cleanup.every((s) => s.status === "completed"),
      `${where}: cleanup steps`,
    );
    assert.equal(f.runtime.turns, 0, `${where}: fake runtime, no turn`);
  } finally {
    if (!closed) await f.close();
  }
});
