import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import type { Runtime } from "../src/standalone/codex.js";
import {
  OperatorAuth,
  type OperatorSession,
} from "../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
import { OperatorRouteRegistry } from "../src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import { StandaloneService } from "../src/standalone/service.js";
import { createControlledPasswordDeriver } from "./fixtures/operator-auth-concurrency.js";

const password = "test operator password";

function fakeRuntime(): Runtime {
  return {
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed";
    },
  };
}

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
    const loginMarkup = await loginPage.text();
    assert.doesNotMatch(loginMarkup, /legacy-operator|rel="stylesheet"/);
    assert.match(loginMarkup, /<main>/);
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

    const loginCsrf = csrfFrom(loginMarkup);
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
    const profileCount = domain.profiles().length;
    const malformedPayload = "NEVER-ECHO-MALFORMED-FORM-SECRET";
    for (const [description, component] of [
      ["invalid single-byte value", "name=%FF"],
      ["invalid multi-byte value", "name=%E2%82"],
      ["invalid UTF-8 key", `name=Safe&%FF=${malformedPayload}`],
      ["invalid percent escape", "name=%ZZ"],
      ["duplicate decoded key", "name=First&%6Eame=Second"],
    ] as const) {
      const response = await fetch(`${origin}/command`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: [
          "type=profile.create",
          `key=${randomUUID()}`,
          `profileId=${randomUUID()}`,
          `instructions=${encodeURIComponent(malformedPayload)}`,
          "capabilities=test",
          component,
          `csrfToken=${encodeURIComponent(protectedCsrf)}`,
        ].join("&"),
        redirect: "manual",
      });
      assert.equal(response.status, 400, description);
      const responseBody = await response.text();
      assert.doesNotMatch(
        responseBody,
        /NEVER-ECHO-MALFORMED-FORM-SECRET|%FF|%E2%82|%ZZ|\uFFFD/i,
        description,
      );
      assert.equal(domain.profiles().length, profileCount, description);
    }

    const oversizedForm = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: [
        "type=profile.create",
        `key=${randomUUID()}`,
        `profileId=${randomUUID()}`,
        "name=Too+large",
        `instructions=${"x".repeat(70 * 1024)}`,
        "capabilities=test",
        `csrfToken=${encodeURIComponent(protectedCsrf)}`,
      ].join("&"),
      redirect: "manual",
    });
    assert.equal(oversizedForm.status, 413);
    assert.equal(domain.profiles().length, profileCount);

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

test("HTML login settles concurrent and stale attempts through the shared auth boundary", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-auth-concurrency-"),
  );
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  const db = new DatabaseSync(":memory:");
  let auth: OperatorAuth | undefined;
  let http: LocalOperatorHttp | undefined;
  let deriver: ReturnType<typeof createControlledPasswordDeriver> | undefined;
  const pendingResponses: Promise<Response>[] = [];
  let now = 1_000;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const configuredOrigin = "https://ensemble.fixture.ts.net";
    const localPort = await unusedPort();
    const localOrigin = `http://127.0.0.1:${localPort}`;
    await OperatorAuth.initialize(authFile, password);
    const verifier = (
      JSON.parse(readFileSync(authFile, "utf8")) as { verifier: string }
    ).verifier;
    deriver = createControlledPasswordDeriver(
      "HTML-PASSWORD-SENTINEL",
      Buffer.from(verifier, "base64url"),
    );
    const openedAuth = await OperatorAuth.open({
      authFile,
      origin: configuredOrigin,
      now: () => now,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
      loginFailureLimit: 1,
      loginLockoutMs: 1_000,
      derivePassword: deriver.derivePassword,
    });
    auth = openedAuth;
    http = new LocalOperatorHttp(new LocalOperatorUi(domain), openedAuth);
    await http.start(localPort);

    const anonymous = async () => {
      const response = await fetch(`${localOrigin}/login`);
      assert.equal(response.status, 200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Secure/);
      assert.doesNotMatch(setCookie, /Domain=/i);
      const body = await response.text();
      return {
        cookie: cookiePair(response),
        csrfToken: csrfFrom(body),
      };
    };
    const postLogin = (
      session: { cookie: string; csrfToken: string },
      submittedPassword: string,
      requestOrigin: string | null = configuredOrigin,
      csrfToken: string = session.csrfToken,
    ) => {
      const headers: Record<string, string> = {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      };
      if (requestOrigin !== null) headers.origin = requestOrigin;
      const request = fetch(`${localOrigin}/login`, {
        method: "POST",
        headers,
        body: new URLSearchParams({
          password: submittedPassword,
          csrfToken,
        }),
        redirect: "manual",
      });
      pendingResponses.push(request);
      return request;
    };
    const assertGenericFailure = async (response: Response) => {
      assert.equal(response.status, 401);
      const body = await response.text();
      assert.match(body, /Sign in failed/);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.doesNotMatch(
        body,
        /HTML-PASSWORD-SENTINEL|WRONG-HTML-PASSWORD-SENTINEL/,
      );
      assert.doesNotMatch(body, new RegExp(verifier));
      return body;
    };

    const guarded = await anonymous();
    for (const [requestOrigin, csrfToken] of [
      ["https://foreign.fixture.ts.net", guarded.csrfToken],
      [null, guarded.csrfToken],
      [configuredOrigin, "wrong-csrf-sentinel"],
    ] as const) {
      const denied = await postLogin(
        guarded,
        "HTML-PASSWORD-SENTINEL",
        requestOrigin,
        csrfToken,
      );
      assert.equal(denied.status, 403);
      await denied.text();
      assert.equal(deriver.calls.length, 0, "guards run before derivation");
    }

    const wrong = await anonymous();
    const correct = await anonymous();
    const wrongResponse = postLogin(wrong, "WRONG-HTML-PASSWORD-SENTINEL");
    const correctResponse = postLogin(correct, "HTML-PASSWORD-SENTINEL");
    await deriver.waitForCalls(2);
    deriver.release(0);
    await assertGenericFailure(await wrongResponse);
    deriver.release(1);
    const correctFailure = await correctResponse;
    await assertGenericFailure(correctFailure);

    now += 1_001;
    const duplicate = await anonymous();
    const first = postLogin(duplicate, "HTML-PASSWORD-SENTINEL");
    await deriver.waitForCalls(3);
    await assertGenericFailure(
      await postLogin(duplicate, "HTML-PASSWORD-SENTINEL"),
    );
    assert.equal(deriver.calls.length, 3, "same-cookie duplicate is rejected");
    deriver.release(2);
    const success = await first;
    assert.equal(success.status, 303);
    assert.equal(success.headers.get("location"), "/");
    const rotatedCookie = success.headers.get("set-cookie") ?? "";
    assert.match(rotatedCookie, /HttpOnly/);
    assert.match(rotatedCookie, /SameSite=Strict/);
    assert.match(rotatedCookie, /Secure/);
    assert.doesNotMatch(rotatedCookie, /Domain=/i);
    const authenticatedPair = cookiePair(success);
    assert.notEqual(authenticatedPair, duplicate.cookie);
    const authenticatedId = authenticatedPair.split("=", 2)[1] ?? "";
    assert.equal(openedAuth.getSession(authenticatedId)?.authenticated, true);
    assert.equal(
      openedAuth.getSession(duplicate.cookie.split("=", 2)[1] ?? ""),
      undefined,
    );

    const afterLogout = await anonymous();
    const logoutPending = postLogin(afterLogout, "HTML-PASSWORD-SENTINEL");
    await deriver.waitForCalls(4);
    openedAuth.logout(afterLogout.cookie.split("=", 2)[1] ?? "");
    deriver.release(3);
    await assertGenericFailure(await logoutPending);

    const afterExpiry = await anonymous();
    const expiryPending = postLogin(afterExpiry, "HTML-PASSWORD-SENTINEL");
    await deriver.waitForCalls(5);
    now += 1_001;
    deriver.release(4);
    await assertGenericFailure(await expiryPending);
  } finally {
    deriver?.releaseAll();
    await Promise.allSettled(pendingResponses);
    if (http) await http.stop();
    auth?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real runtime and coordination routes inherit HTTP guards and persist capacity", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-real-operator-routes-"),
  );
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  const service = new StandaloneService(directory, fakeRuntime, undefined, {
    routingClient: null,
    power: { enabled: false },
  });
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  try {
    await service.start();
    const domain = service.domain();
    const profileId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    domain.execute({
      key: randomUUID(),
      actor: "operator",
      type: "profile.create",
      profileId,
      name: "PRIVATE-OPERATOR-PROFILE",
      instructions: "PRIVATE-OPERATOR-INSTRUCTIONS",
      capabilities: "coordinate",
    });
    domain.execute({
      key: randomUUID(),
      actor: "operator",
      type: "project.create",
      projectId,
      name: "PRIVATE-OPERATOR-PROJECT",
      leadProfileId: profileId,
    });
    domain.execute({
      key: randomUUID(),
      actor: "operator",
      type: "task.create",
      projectId,
      taskId,
      title: "PRIVATE-OPERATOR-TASK",
      outcome: "PRIVATE-OPERATOR-OUTCOME",
      ready: false,
    });
    const assignment = domain.ensureLeadAssignment(taskId);
    assert.ok(assignment);
    const assignmentId = String(assignment.id);

    const runtimeRoutes = runtimeOperatorRoutes(service);
    const coordinationRoutes = coordinationOperatorRoutes(
      service.coordinationView(),
      domain,
      (projectId) => service.routingAvailability(projectId),
    );
    const routes = new OperatorRouteRegistry();
    routes.registerSlot("runtime", runtimeRoutes);
    routes.registerSlot("coordination", coordinationRoutes);
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open({ authFile, origin });
    http = new LocalOperatorHttp(new LocalOperatorUi(domain), auth, { routes });
    await http.start(port);

    const pathFor = (path: string) =>
      path.replace(":taskId", taskId).replace(":assignmentId", assignmentId);
    const getPaths = [...runtimeRoutes, ...coordinationRoutes]
      .filter((route) => route.method === "GET")
      .map((route) => pathFor(route.path));
    const postPaths = [...runtimeRoutes, ...coordinationRoutes]
      .filter((route) => route.method === "POST")
      .map((route) => route.path);

    for (const path of getPaths) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, `pre-login GET ${path}`);
      assert.match(await response.text(), /Sign in/);
    }
    for (const path of postPaths) {
      const response = await fetch(`${origin}${pathFor(path)}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ attempted: "unauthenticated" }),
        redirect: "manual",
      });
      assert.equal(response.status, 401, `unauthenticated POST ${path}`);
      assert.doesNotMatch(await response.text(), /PRIVATE-OPERATOR/);
    }

    const loginPage = await fetch(`${origin}/login`);
    const anonymousCookie = cookiePair(loginPage);
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin,
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        password,
        csrfToken: csrfFrom(await loginPage.text()),
      }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const sessionCookie = cookiePair(login);
    const authenticatedHome = await fetch(origin, {
      headers: { cookie: sessionCookie },
    });
    const protectedCsrf = csrfFrom(await authenticatedHome.text());

    for (const path of postPaths) {
      for (const attempt of [
        { origin: "https://elsewhere.example", csrfToken: protectedCsrf },
        { origin, csrfToken: "wrong" },
        { origin: "", csrfToken: protectedCsrf },
      ]) {
        const headers: Record<string, string> = {
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        };
        if (attempt.origin) headers.origin = attempt.origin;
        const response = await fetch(`${origin}${pathFor(path)}`, {
          method: "POST",
          headers,
          body: new URLSearchParams({ csrfToken: attempt.csrfToken }),
          redirect: "manual",
        });
        assert.equal(response.status, 403, `guarded POST ${path}`);
      }
      const malformed = await fetch(`${origin}${pathFor(path)}`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrfToken: protectedCsrf }),
        redirect: "manual",
      });
      assert.equal(malformed.status, 400, `malformed POST ${path}`);
      assert.doesNotMatch(await malformed.text(), /PRIVATE-OPERATOR/);
    }

    const duplicateField = await fetch(`${origin}/runtime/control/capacity`, {
      method: "POST",
      headers: {
        origin,
        cookie: sessionCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: [
        `csrfToken=${encodeURIComponent(protectedCsrf)}`,
        "key=00000000-0000-4000-8000-000000000001",
        "globalLimit=3",
        "%67lobalLimit=4",
        "projectId=",
        "projectLimit=",
      ].join("&"),
      redirect: "manual",
    });
    assert.equal(duplicateField.status, 400);
    assert.equal(service.capacityLimits([projectId]).globalLimit, 4);

    const replayKey = randomUUID();
    const capacityForm = new URLSearchParams({
      csrfToken: protectedCsrf,
      key: replayKey,
      globalLimit: "3",
      projectId,
      projectLimit: "1",
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${origin}/runtime/control/capacity`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: capacityForm,
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/runtime");
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.ok(response.headers.get("content-security-policy"));
    }
    assert.equal(service.capacityLimits([projectId]).globalLimit, 3);
    assert.equal(
      service.capacityLimits([projectId]).projectOverrides[projectId],
      1,
    );
  } finally {
    await http?.stop();
    auth?.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy awaited slots and extension publications reject expired or logged-out exact sessions while admitted writes remain once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ui04-session-publication-"));
  const db = new DatabaseSync(":memory:");
  let auth: OperatorAuth | undefined, http: LocalOperatorHttp | undefined;
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Private retained legacy marker",
      leadProfileId: null,
    });
    const ui = new LocalOperatorUi(domain),
      port = await unusedPort(),
      origin = `http://127.0.0.1:${port}`,
      authFile = join(directory, "auth");
    let now = 100;
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open({
      authFile,
      origin,
      now: () => now,
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 10000,
    });
    let gate: Promise<void> | undefined,
      entered: () => void = () => {};
    const handler = async ({ csrfToken }: { csrfToken: string }) => {
      const body = ui.home(csrfToken);
      if (gate) {
        entered();
        await gate;
      }
      return { kind: "html" as const, body };
    };
    const routes = new OperatorRouteRegistry();
    routes.registerSlot("runtime", [
      { method: "GET", path: "/runtime", handler },
    ]);
    routes.registerSlot("coordination", [
      { method: "GET", path: "/coordination", handler },
    ]);
    routes.register({ method: "GET", path: "/extension/private", handler });
    const profileId = randomUUID();
    routes.register({
      method: "POST",
      path: "/extension/write",
      handler: async ({ fields, csrfToken }) => {
        domain.execute({
          type: "profile.create",
          actor: "operator",
          key: fields.key!,
          profileId,
          name: "Admitted exact mutation",
          instructions: "Fixture instruction",
          capabilities: "fixture",
        });
        return handler({ csrfToken });
      },
    });
    http = new LocalOperatorHttp(ui, auth, { routes });
    await http.start(port);
    const login = async () => {
      assert.ok(auth);
      const anon = auth.createAnonymousSession();
      const current = await auth.authenticate(anon.id, password);
      assert.ok(current);
      return {
        cookie: `ensemble_operator_session=${current.id}`,
        csrfToken: current.csrfToken,
      };
    };
    const logout = async (session: { cookie: string; csrfToken: string }) => {
      const response = await fetch(`${origin}/logout`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrfToken: session.csrfToken }),
        redirect: "manual",
      });
      assert.equal(response.status, 303);
    };
    for (const path of ["/runtime", "/coordination", "/extension/private"])
      for (const mode of ["logout", "expiry"]) {
        const session = await login();
        let response = await fetch(origin + path, {
          headers: { cookie: session.cookie },
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Private retained legacy marker/);
        let release!: () => void;
        gate = new Promise<void>((r) => (release = r));
        const arrival = new Promise<void>((r) => (entered = r));
        const pending = fetch(origin + path, {
          headers: { cookie: session.cookie },
        });
        try {
          await arrival;
          if (mode === "logout") await logout(session);
          else now += 1000;
          release();
          response = await pending;
          assert.equal(response.status, 401);
          assert.doesNotMatch(
            await response.text(),
            /Private retained legacy marker/,
          );
        } finally {
          release();
          await pending;
          gate = undefined;
        }
      }
    const synchronous = await login();
    const originalSession = auth.getSession.bind(auth);
    let revokeAtAuthorization = true;
    auth.getSession = (id) => {
      const captured = originalSession(id);
      if (revokeAtAuthorization) {
        revokeAtAuthorization = false;
        queueMicrotask(() => auth?.logout(id));
      }
      return captured;
    };
    const revoked = await fetch(`${origin}/project/${projectId}`, {
      headers: { cookie: synchronous.cookie },
    });
    assert.equal(revoked.status, 401);
    assert.doesNotMatch(await revoked.text(), /Private retained legacy marker/);
    auth.getSession = originalSession;
    const session = await login(),
      key = randomUUID();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const arrival = new Promise<void>((r) => (entered = r));
    const send = (session: { cookie: string; csrfToken: string }) =>
      fetch(`${origin}/extension/write`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ key, csrfToken: session.csrfToken }),
      });
    const pending = send(session);
    try {
      await arrival;
      assert.equal(
        domain.profiles().filter((p) => p.id === profileId).length,
        1,
      );
      await logout(session);
      release();
      assert.equal((await pending).status, 401);
    } finally {
      release();
      await pending;
      gate = undefined;
    }
    const replay = await send(await login());
    assert.equal(replay.status, 200);
    await replay.text();
    assert.equal(domain.profiles().filter((p) => p.id === profileId).length, 1);
  } finally {
    await http?.stop();
    auth?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
