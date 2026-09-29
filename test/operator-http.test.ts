import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import {
  OperatorAuth,
  type OperatorSession,
} from "../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorRouteRegistry } from "../src/standalone/operator-routes.js";

const password = "test operator password";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function getWithForgedHost(
  port: number,
  path = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: {
          host: "attacker.example",
          "x-forwarded-host": `127.0.0.1:${port}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "response sets an operator session cookie");
  return value.split(";", 1)[0] ?? "";
}

function csrfFrom(html: string): string {
  const value = html.match(/name="csrfToken"[^>]*value="([^"]+)"/)?.[1];
  assert.ok(value, "rendered form has a CSRF token");
  return value;
}

function commandForm(
  fields: Record<string, string>,
  csrfToken: string,
): URLSearchParams {
  return new URLSearchParams({ ...fields, csrfToken });
}

test("operator route registry rejects collisions and reserves private paths", () => {
  const handler = () => ({ kind: "html" as const, body: "<p>Extension</p>" });
  const routes = new OperatorRouteRegistry();
  routes.register({ method: "GET", path: "/extension/:itemId", handler });
  assert.throws(() =>
    routes.register({ method: "GET", path: "/extension/:itemId", handler }),
  );
  for (const path of [
    "/",
    "/login",
    "/logout",
    "/command",
    "/project/:id",
    "/task/:id",
    "/profile/:id",
    "/assignment/:id",
    "/runtime",
    "/runtime/control",
    "/coordination",
  ]) {
    assert.throws(() => routes.register({ method: "GET", path, handler }));
  }
  for (const path of ["/:root", "/:root/:itemId"]) {
    assert.throws(() => routes.register({ method: "GET", path, handler }));
  }
  assert.throws(() =>
    routes.register({ method: "POST", path: "/extension/:bad-id", handler }),
  );
});

test("operator route registry exposes runtime and coordination only through named slots", () => {
  const handler = () => ({ kind: "html" as const, body: "slot" });
  const routes = new OperatorRouteRegistry();
  routes.registerSlot("runtime", [
    { method: "GET", path: "/runtime", handler },
    { method: "POST", path: "/runtime/control", handler },
  ]);
  routes.registerSlot("coordination", [
    { method: "GET", path: "/coordination", handler },
    { method: "POST", path: "/coordination/control/:id", handler },
  ]);

  assert.equal(
    routes.matchSlot("runtime", "GET", "/runtime")?.handler,
    handler,
  );
  assert.equal(
    routes.matchSlot("runtime", "POST", "/runtime/control")?.handler,
    handler,
  );
  assert.equal(
    routes.matchSlot("coordination", "POST", "/coordination/control/item")
      ?.params.id,
    "item",
  );
  assert.equal(routes.match("GET", "/runtime"), undefined);
  assert.throws(
    () => new OperatorRouteRegistry().registerSlot("runtime", []),
    /contain routes/i,
  );
  assert.throws(
    () => routes.registerSlot("runtime", []),
    /already registered/i,
  );
  const wrongSlot = new OperatorRouteRegistry();
  assert.throws(() =>
    wrongSlot.registerSlot("runtime", [
      { method: "GET", path: "/coordination", handler },
    ]),
  );
  assert.throws(
    () =>
      routes.registerSlot("coordination", [
        { method: "POST", path: "/coordination/control/:other", handler },
      ]),
    /already registered/i,
  );
  assert.throws(() =>
    routes.register({ method: "GET", path: "/runtime", handler }),
  );
  routes.mount();
  assert.throws(() =>
    routes.registerSlot("coordination", [
      { method: "GET", path: "/coordination/status", handler },
    ]),
  );
});

test("all operator and extension routes inherit login, origin, and CSRF guards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-http-"));
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  const db = new DatabaseSync(":memory:");
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const ui = new LocalOperatorUi(domain);
    const profile = (await ui.submit({
      key: randomUUID(),
      type: "profile.create",
      name: "PRIVATE-PROFILE-MARKER",
      instructions: "PRIVATE-INSTRUCTIONS-MARKER",
      capabilities: "operator ui",
    })) as { id: string };
    const project = (await ui.submit({
      key: randomUUID(),
      type: "project.create",
      name: "PRIVATE-PROJECT-MARKER",
      leadProfileId: profile.id,
    })) as { id: string };
    const task = (await ui.submit({
      key: randomUUID(),
      type: "task.create",
      projectId: project.id,
      title: "PRIVATE-TASK-MARKER",
      outcome: "PRIVATE-OUTCOME-MARKER",
    })) as { id: string };
    await ui.submit({
      key: randomUUID(),
      type: "routing.configure",
      projectId: project.id,
      expectedVersion: "1",
      enabled: "1",
      guidance: "route safely",
      credentialRef: "env:PRIVATE_CREDENTIAL_REFERENCE",
      candidateProfileIds: JSON.stringify([profile.id]),
    });

    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open({ authFile, origin });
    let extensionReads = 0;
    let extensionWrites = 0;
    let runtimeReads = 0;
    let runtimeWrites = 0;
    let coordinationReads = 0;
    let coordinationWrites = 0;
    const routes = new OperatorRouteRegistry();
    routes.registerSlot("runtime", [
      {
        method: "GET",
        path: "/runtime",
        handler: () => {
          runtimeReads += 1;
          return { kind: "html", body: "<main><h1>Runtime slot</h1></main>" };
        },
      },
      {
        method: "POST",
        path: "/runtime/control",
        handler: () => {
          runtimeWrites += 1;
          return { kind: "redirect", location: "/runtime" };
        },
      },
    ]);
    routes.registerSlot("coordination", [
      {
        method: "GET",
        path: "/coordination",
        handler: () => {
          coordinationReads += 1;
          return {
            kind: "html",
            body: "<main><h1>Coordination slot</h1></main>",
          };
        },
      },
      {
        method: "POST",
        path: "/coordination/control/:operation",
        handler: () => {
          coordinationWrites += 1;
          return { kind: "redirect", location: "/coordination" };
        },
      },
    ]);
    routes.register({
      method: "GET",
      path: "/extension/:itemId",
      handler: ({ params }) => {
        extensionReads += 1;
        return {
          kind: "html",
          body: `<main><h1>Extension ${params.itemId}</h1></main>`,
        };
      },
    });
    routes.register({
      method: "POST",
      path: "/extension/:itemId",
      handler: ({ fields }) => {
        extensionWrites += 1;
        assert.equal(fields.payload, "accepted");
        return { kind: "redirect", location: "/" };
      },
    });
    http = new LocalOperatorHttp(ui, auth, { routes });
    assert.equal(await http.start(port), port);

    const privatePaths = [
      "/",
      `/project/${project.id}`,
      `/task/${task.id}`,
      `/profile/${profile.id}`,
      "/assignment/not-a-public-run",
      "/runtime",
      "/runtime/control",
      "/coordination",
      "/coordination/control/start",
      "/extension/private-marker",
    ];
    for (const path of privatePaths) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, `pre-login GET ${path}`);
      assert.ok(response.headers.get("set-cookie"));
      const body = await response.text();
      assert.ok(/Sign in/.test(body), `protected GET ${path} renders login`);
      assert.ok(
        !/PRIVATE-(?:PROFILE|INSTRUCTIONS|PROJECT|TASK|OUTCOME|CREDENTIAL)/.test(
          body,
        ),
        `protected GET ${path} excludes private content`,
      );
    }
    assert.equal(extensionReads, 0);
    assert.equal(runtimeReads, 0);
    assert.equal(coordinationReads, 0);

    for (const [path, body] of [
      ["/command", new URLSearchParams({ type: "project.create" })],
      [
        "/extension/private-marker",
        new URLSearchParams({ payload: "accepted" }),
      ],
      ["/runtime/control", new URLSearchParams({ action: "start" })],
      ["/coordination/control/start", new URLSearchParams({ action: "start" })],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
      });
      assert.equal(response.status, 401, `unauthenticated POST ${path}`);
      assert.ok(!(await response.text()).includes("PRIVATE-"));
    }
    assert.equal(domain.projects().length, 1);
    assert.equal(extensionWrites, 0);
    assert.equal(runtimeWrites, 0);
    assert.equal(coordinationWrites, 0);

    const loginPage = await fetch(`${origin}/login`);
    assert.equal(loginPage.status, 200);
    const anonymousCookie = cookiePair(loginPage);
    const anonymousSession = auth.getSession(
      anonymousCookie.split("=", 2)[1] ?? "",
    );
    assert.equal(anonymousSession?.authenticated, false);
    const anonymousSetCookie = loginPage.headers.get("set-cookie") ?? "";
    assert.ok(
      /HttpOnly/.test(anonymousSetCookie),
      "session cookie is HttpOnly",
    );
    assert.ok(
      /SameSite=Strict/.test(anonymousSetCookie),
      "cookie is SameSite Strict",
    );
    assert.ok(/Path=\//.test(anonymousSetCookie), "cookie path is root");
    assert.ok(!/Domain=/i.test(anonymousSetCookie), "cookie is host-only");
    assert.match(loginPage.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(loginPage.headers.get("x-content-type-options"), "nosniff");
    assert.ok(loginPage.headers.get("content-security-policy"));

    const loginHtml = await loginPage.text();
    const loginCsrf = csrfFrom(loginHtml);
    const wrongCsrf = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin,
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: "wrong" }),
      redirect: "manual",
    });
    assert.equal(wrongCsrf.status, 403);
    const missingOrigin = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(missingOrigin.status, 403);
    const foreignOrigin = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin: "https://elsewhere.example",
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(foreignOrigin.status, 403);
    const opaqueOrigin = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin: "null",
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(opaqueOrigin.status, 403);
    assert.equal(domain.projects().length, 1);

    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin,
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const sessionCookie = cookiePair(login);
    assert.ok(sessionCookie !== anonymousCookie, "login rotates the cookie");
    const sessionId = sessionCookie.split("=", 2)[1] ?? "";
    const session = auth.getSession(sessionId) as OperatorSession | undefined;
    assert.equal(session?.authenticated, true);

    const home = await fetch(origin, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.ok(homeHtml.includes("PRIVATE-PROJECT-MARKER"));
    assert.ok(homeHtml.includes('href="/runtime"'));
    assert.ok(homeHtml.includes('href="/coordination"'));
    assert.ok(!homeHtml.includes("PRIVATE-CREDENTIAL-REFERENCE"));
    assert.ok(!homeHtml.includes("TYPESAFE_KEY"));

    const extensionGet = await fetch(`${origin}/extension/from-694`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(extensionGet.status, 200);
    assert.ok((await extensionGet.text()).includes("Extension from-694"));
    assert.equal(extensionReads, 1);

    const runtimePage = await fetch(`${origin}/runtime`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(runtimePage.status, 200);
    assert.match(await runtimePage.text(), /Runtime slot/);
    assert.equal(runtimeReads, 1);
    const coordinationPage = await fetch(`${origin}/coordination`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(coordinationPage.status, 200);
    assert.match(await coordinationPage.text(), /Coordination slot/);
    assert.equal(coordinationReads, 1);

    const protectedCsrf = csrfFrom(homeHtml);
    for (const attempt of [
      { origin, token: "wrong", status: 403 },
      { origin, token: protectedCsrf, cookie: "", status: 401 },
      {
        origin: "https://elsewhere.example",
        token: protectedCsrf,
        status: 403,
      },
      { origin: "null", token: protectedCsrf, status: 403 },
      { origin: "", token: protectedCsrf, status: 403 },
    ]) {
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (attempt.origin) headers.origin = attempt.origin;
      if (attempt.cookie !== "") headers.cookie = sessionCookie;
      const response = await fetch(`${origin}/extension/from-694`, {
        method: "POST",
        headers,
        body: commandForm({ payload: "accepted" }, attempt.token),
        redirect: "manual",
      });
      assert.equal(response.status, attempt.status);
    }
    assert.equal(extensionWrites, 0);
    for (const [path, target] of [
      ["/runtime/control", "runtime"],
      ["/coordination/control/start", "coordination"],
    ] as const) {
      const wrongOrigin = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          origin: "https://elsewhere.example",
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: commandForm({ action: "start" }, protectedCsrf),
        redirect: "manual",
      });
      assert.equal(wrongOrigin.status, 403, `${target} exact-Origin guard`);
      const wrongCsrf = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: commandForm({ action: "start" }, "wrong"),
        redirect: "manual",
      });
      assert.equal(wrongCsrf.status, 403, `${target} CSRF guard`);
      const accepted = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: commandForm({ action: "start" }, protectedCsrf),
        redirect: "manual",
      });
      assert.equal(accepted.status, 303, `${target} authenticated POST`);
    }
    assert.equal(runtimeWrites, 1);
    assert.equal(coordinationWrites, 1);
    const credentialSentinel = "NEVER-ECHO-THIS-CREDENTIAL";
    const invalidCredentialReference = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: commandForm(
        {
          type: "routing.configure",
          key: randomUUID(),
          projectId: project.id,
          expectedVersion: String(domain.routing(project.id).version),
          enabled: "1",
          guidance: "test validation",
          credentialRef: credentialSentinel,
          candidateProfileIds: JSON.stringify([profile.id]),
        },
        protectedCsrf,
      ),
      redirect: "manual",
    });
    assert.equal(invalidCredentialReference.status, 400);
    assert.ok(
      !(await invalidCredentialReference.text()).includes(credentialSentinel),
    );
    assert.equal(domain.routing(project.id).version, 2);
    const extensionPost = await fetch(`${origin}/extension/from-694`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: commandForm({ payload: "accepted" }, protectedCsrf),
      redirect: "manual",
    });
    assert.equal(extensionPost.status, 303);
    assert.equal(extensionWrites, 1);
    assert.equal(domain.projects().length, 1);

    const deniedCommands = [
      "assignment.create",
      "assignment.apply",
      "dependency.add",
      "dependency.remove",
      "imported-blockers.set",
    ];
    for (const type of deniedCommands) {
      const response = await fetch(`${origin}/command`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: commandForm({ type, key: randomUUID() }, protectedCsrf),
        redirect: "manual",
      });
      assert.equal(response.status, 400, `${type} is not a web command`);
      const body = await response.text();
      assert.ok(!/PRIVATE-CREDENTIAL|password/i.test(body));
    }
    assert.equal(domain.assignments(task.id).length, 0);
    assert.deepEqual(domain.dependencies(task.id), []);

    const versionConflict = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: commandForm(
        {
          type: "profile.configure",
          key: randomUUID(),
          profileId: profile.id,
          expectedVersion: "999",
          name: "Must not be persisted",
          instructions: "Version conflict private detail",
          capabilities: "test",
        },
        protectedCsrf,
      ),
      redirect: "manual",
    });
    assert.equal(versionConflict.status, 409);
    const versionConflictBody = await versionConflict.text();
    assert.match(versionConflictBody, /reload/i);
    assert.doesNotMatch(
      versionConflictBody,
      /Version conflict|private detail/i,
    );
    assert.equal(domain.profile(profile.id).name, "PRIVATE-PROFILE-MARKER");

    const replayKey = randomUUID();
    const replayProjectId = randomUUID();
    const firstReplayCommand = {
      type: "project.create",
      key: replayKey,
      projectId: replayProjectId,
      name: "Idempotent project",
    };
    const firstReplay = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: commandForm(firstReplayCommand, protectedCsrf),
      redirect: "manual",
    });
    assert.equal(firstReplay.status, 303);
    const changedReplay = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: commandForm(
        { ...firstReplayCommand, name: "NEVER-ECHO-THIS-REPLAY" },
        protectedCsrf,
      ),
      redirect: "manual",
    });
    assert.equal(changedReplay.status, 409);
    const changedReplayBody = await changedReplay.text();
    assert.match(changedReplayBody, /reload/i);
    assert.doesNotMatch(
      changedReplayBody,
      /NEVER-ECHO-THIS-REPLAY|Command key already used/i,
    );
    assert.equal(
      domain.projects().filter((p) => p.id === replayProjectId).length,
      1,
    );

    const forgedHost = await getWithForgedHost(port);
    assert.equal(forgedHost.status, 403);
    assert.ok(!forgedHost.body.includes("PRIVATE-"));
    const forgedRuntimeHost = await getWithForgedHost(port, "/runtime");
    assert.equal(forgedRuntimeHost.status, 403);
    assert.ok(!forgedRuntimeHost.body.includes("Runtime slot"));
    const forgedCoordinationHost = await getWithForgedHost(
      port,
      "/coordination",
    );
    assert.equal(forgedCoordinationHost.status, 403);
    assert.ok(!forgedCoordinationHost.body.includes("Coordination slot"));
  } finally {
    await http?.stop();
    auth?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
