import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile, symlink, unlink } from "node:fs/promises";
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
import { seedReviewTask } from "./fixtures/task-review.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { createControlledPasswordDeriver } from "./fixtures/operator-auth-concurrency.js";
test("one guarded listener serves shell and authenticated JSON with rotated CSRF", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const bundlePath = join(f.directory, "bundle");
  await mkdir(join(bundlePath, "assets"), { recursive: true });
  await writeFile(
    join(bundlePath, "index.html"),
    '<html><link rel="stylesheet" href="/assets/main.css"><script src="/assets/main.js"></script></html>',
  );
  await writeFile(join(bundlePath, "assets/main.js"), 'console.log("static");');
  await writeFile(
    join(bundlePath, "assets/main.css"),
    "body { color: white; }",
  );
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
  const bundle = await OperatorWebBundle.open(bundlePath);
  assert.deepEqual(bundle.stylesheets, ["/assets/main.css"]);
  const http = new LocalOperatorHttp(
    new LocalOperatorUi(f.service.domain()),
    auth,
    {
      web: new OperatorWebBoundary(
        bundle,
        new OperatorApi(f.service, [f.directory]),
      ),
    },
  );
  const port = await http.start();
  t.after(() => http.stop());
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${origin}/app`)).status, 200);
  const loginPage = await fetch(`${origin}/runtime`);
  const loginHtml = await loginPage.text();
  assert.equal(loginPage.status, 200);
  assert.match(loginHtml, /<body class="legacy-operator">/);
  assert.match(loginHtml, /<link rel="stylesheet" href="\/assets\/main\.css">/);
  const stylesheet = await fetch(`${origin}/assets/main.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  assert.equal(await stylesheet.text(), "body { color: white; }");
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

test("JSON login settles concurrent, duplicate, and stale attempts with generic responses", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const bundlePath = join(f.directory, "auth-concurrency-bundle");
  await mkdir(join(bundlePath, "assets"), { recursive: true });
  await writeFile(join(bundlePath, "index.html"), "<html></html>");
  const authFile = join(f.directory, "auth-concurrency.json");
  const configuredOrigin = "https://ensemble.fixture.ts.net";
  const correctPassword = "JSON-PASSWORD-SENTINEL";
  await OperatorAuth.initialize(authFile, correctPassword);
  const record = JSON.parse(await readFile(authFile, "utf8")) as {
    verifier: string;
  };
  const deriver = createControlledPasswordDeriver(
    correctPassword,
    Buffer.from(record.verifier, "base64url"),
  );
  let now = 1_000;
  const auth = await OperatorAuth.open({
    authFile,
    origin: configuredOrigin,
    now: () => now,
    idleTimeoutMs: 1_000,
    absoluteTimeoutMs: 5_000,
    loginFailureLimit: 1,
    loginLockoutMs: 1_000,
    derivePassword: deriver.derivePassword,
  });
  const bundle = await OperatorWebBundle.open(bundlePath);
  const http = new LocalOperatorHttp(
    new LocalOperatorUi(f.service.domain()),
    auth,
    {
      web: new OperatorWebBoundary(
        bundle,
        new OperatorApi(f.service, [f.directory]),
      ),
    },
  );
  const pendingRequests: Promise<Response>[] = [];
  try {
    const port = await http.start();
    const localOrigin = `http://127.0.0.1:${port}`;
    const anonymous = async () => {
      const response = await fetch(`${localOrigin}/api/operator/session`);
      assert.equal(response.status, 200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Secure/);
      assert.doesNotMatch(setCookie, /Domain=/i);
      const session = (await response.json()) as { csrfToken: string };
      return {
        cookie: setCookie.split(";", 1)[0] ?? "",
        csrfToken: session.csrfToken,
      };
    };
    const postLogin = (
      session: { cookie: string; csrfToken: string },
      password: string,
      requestOrigin: string | null = configuredOrigin,
      csrfToken: string = session.csrfToken,
    ) => {
      const headers: Record<string, string> = {
        cookie: session.cookie,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      };
      if (requestOrigin !== null) headers.origin = requestOrigin;
      const request = fetch(`${localOrigin}/api/operator/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(10_000),
      });
      pendingRequests.push(request);
      return request;
    };
    const assertGenericFailure = async (response: Response) => {
      assert.equal(response.status, 401);
      const body = await response.text();
      assert.match(body, /unauthenticated/);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.doesNotMatch(body, /JSON-PASSWORD-SENTINEL|WRONG-JSON-PASSWORD/);
      assert.doesNotMatch(body, new RegExp(record.verifier));
      return body;
    };

    const guarded = await anonymous();
    for (const [requestOrigin, csrfToken] of [
      ["https://foreign.fixture.ts.net", guarded.csrfToken],
      [configuredOrigin, "wrong-csrf-sentinel"],
    ] as const) {
      const denied = await postLogin(
        guarded,
        "JSON-PASSWORD-SENTINEL",
        requestOrigin,
        csrfToken,
      );
      assert.equal(denied.status, 403);
      await denied.text();
      assert.equal(deriver.calls.length, 0, "guards run before derivation");
    }

    const wrong = await anonymous();
    const correct = await anonymous();
    const wrongResponse = postLogin(wrong, "WRONG-JSON-PASSWORD");
    await deriver.waitForCalls(1);
    const correctResponse = postLogin(correct, correctPassword);
    await deriver.waitForCalls(2);
    deriver.release(0);
    await assertGenericFailure(await wrongResponse);
    deriver.release(1);
    await assertGenericFailure(await correctResponse);

    now += 1_001;
    const duplicate = await anonymous();
    const first = postLogin(duplicate, correctPassword);
    await deriver.waitForCalls(3);
    await assertGenericFailure(await postLogin(duplicate, correctPassword));
    assert.equal(deriver.calls.length, 3, "same-cookie duplicate is rejected");
    deriver.release(2);
    const success = await first;
    assert.equal(success.status, 200);
    const rotatedCookie = success.headers.get("set-cookie") ?? "";
    assert.match(rotatedCookie, /HttpOnly/);
    assert.match(rotatedCookie, /SameSite=Strict/);
    assert.match(rotatedCookie, /Secure/);
    assert.doesNotMatch(rotatedCookie, /Domain=/i);
    const session = (await success.json()) as {
      authenticated: boolean;
      csrfToken: string;
    };
    assert.equal(session.authenticated, true);
    assert.notEqual(session.csrfToken, duplicate.csrfToken);
    const rotatedPair = rotatedCookie.split(";", 1)[0] ?? "";
    const rotatedId = rotatedPair.split("=", 2)[1] ?? "";
    const oldId = duplicate.cookie.split("=", 2)[1] ?? "";
    assert.notEqual(rotatedPair, duplicate.cookie);
    assert.equal(auth.getSession(rotatedId)?.authenticated, true);
    assert.equal(auth.getSession(oldId), undefined);
    const replay = await postLogin(duplicate, correctPassword);
    assert.equal(replay.status, 403);
    await replay.text();
    assert.equal(deriver.calls.length, 3, "rotated session cannot replay");

    const loggedOut = await anonymous();
    const logoutPending = postLogin(loggedOut, correctPassword);
    await deriver.waitForCalls(4);
    auth.logout(loggedOut.cookie.split("=", 2)[1] ?? "");
    deriver.release(3);
    await assertGenericFailure(await logoutPending);

    const expired = await anonymous();
    const expiryPending = postLogin(expired, correctPassword);
    await deriver.waitForCalls(5);
    now += 1_001;
    deriver.release(4);
    await assertGenericFailure(await expiryPending);

    const closed = await anonymous();
    const closePending = postLogin(closed, correctPassword);
    await deriver.waitForCalls(6);
    auth.close();
    deriver.release(5);
    await assertGenericFailure(await closePending);
  } finally {
    deriver.releaseAll();
    await Promise.allSettled(pendingRequests);
    await http.stop();
    auth.close();
  }
});

async function webLogin(web: { origin: string; password: string }) {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anon = (await anonymous.json()) as { csrfToken: string };
  const response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: anonymous.headers.get("set-cookie")!.split(";")[0]!,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrfToken: ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
async function webLogout(
  web: { origin: string },
  session: { cookie: string; csrfToken: string },
) {
  const response = await fetch(`${web.origin}/api/operator/logout`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
}

test("every shared curated publication rechecks exact session after actual private reads on logout and expiry", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(
    f,
    "Session projection",
    "Retained session private title",
  );
  const result = a.result("Retained private result");
  const web = await f.startWeb();
  const routes = [
    `/api/operator/tasks/${a.taskId}`,
    `/api/operator/tasks/${a.taskId}/review?resultId=${result.resultId}`,
    `/api/operator/assignments/${a.assignmentId}/history`,
    `/api/operator/task-list`,
    `/api/operator/projects/${a.projectId}/composer-options`,
    `/api/operator/runtime`,
  ];
  const original = OperatorWebBoundary.prototype.read;
  t.after(() => {
    OperatorWebBoundary.prototype.read = original;
  });
  for (const route of routes)
    for (const mode of ["logout", "expiry"]) {
      const session = await webLogin(web);
      const valid = await fetch(web.origin + route, {
        headers: { cookie: session.cookie },
      });
      assert.equal(valid.status, 200);
      await valid.arrayBuffer();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        arrival = new Promise<void>((r) => (entered = r));
      OperatorWebBoundary.prototype.read = async function (path, query) {
        const data = await original.call(this, path, query);
        entered();
        await gate;
        return data;
      };
      const pending = fetch(web.origin + route, {
        headers: { cookie: session.cookie },
      });
      try {
        await arrival;
        if (mode === "logout") await webLogout(web, session);
        else f.advanceClock(60000);
        release();
        const response = await pending;
        assert.equal(response.status, 401, route);
        const body = await response.text();
        assert.match(body, /unauthenticated/);
        assert.doesNotMatch(
          body,
          /Retained session private title|Retained private result|sourceId|assignmentId/,
        );
      } finally {
        release();
        await pending;
        OperatorWebBoundary.prototype.read = original;
      }
    }
});

test("private command acknowledgement withholds its receipt after logout without replaying a recorded effect", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const result = a.result("Exact retained result");
  const web = await f.startWeb();
  const session = await webLogin(web);
  const command = {
    type: "review.view",
    key: randomUUID(),
    taskId: a.taskId,
    sourceId: a.source.sourceId,
    resultIds: [result.resultId],
  };
  const original = OperatorApi.prototype.execute;
  t.after(() => {
    OperatorApi.prototype.execute = original;
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    arrival = new Promise<void>((r) => (entered = r));
  OperatorApi.prototype.execute = async function (body) {
    const receipt = await original.call(this, body);
    entered();
    await gate;
    return receipt;
  };
  const pending = fetch(`${web.origin}/api/operator/commands`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
    body: JSON.stringify(command),
  });
  let saved: unknown;
  try {
    await arrival;
    saved = f.service.taskReview().read(a.taskId).viewed;
    assert.ok(saved);
    await webLogout(web, session);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), new RegExp(command.key));
  } finally {
    release();
    await pending;
    OperatorApi.prototype.execute = original;
  }
  const current = await webLogin(web);
  const replay = await fetch(`${web.origin}/api/operator/commands`, {
    method: "POST",
    headers: {
      cookie: current.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": current.csrfToken,
    },
    body: JSON.stringify(command),
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { key: string }).key, command.key);
  assert.deepEqual(f.service.taskReview().read(a.taskId).viewed, saved);
});

test("source refresh acknowledgement rechecks exact session after completed actual service refresh", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  await seedReviewTask(f);
  const web = await f.startWeb();
  const original = OperatorApi.prototype.refreshSources;
  t.after(() => {
    OperatorApi.prototype.refreshSources = original;
  });
  for (const mode of ["logout", "expiry"]) {
    const session = await webLogin(web);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      arrival = new Promise<void>((r) => (entered = r));
    OperatorApi.prototype.refreshSources = async function () {
      const data = await original.call(this);
      entered();
      await gate;
      return data;
    };
    const pending = fetch(`${web.origin}/api/operator/source-refresh`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: "{}",
    });
    try {
      await arrival;
      if (mode === "logout") await webLogout(web, session);
      else f.advanceClock(60000);
      release();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.match(await response.text(), /unauthenticated/);
    } finally {
      release();
      await pending;
      OperatorApi.prototype.refreshSources = original;
    }
  }
});
