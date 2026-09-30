import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorAuth } from "../src/standalone/operator-auth.js";

const password = "correct horse battery staple";
const origin = "http://127.0.0.1:8787";

function randomSource() {
  let value = 0;
  return (size: number) => Buffer.alloc(size, ++value);
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-auth-"));
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  const randomBytes = randomSource();
  await OperatorAuth.initialize(authFile, password, randomBytes);
  const now = { value: 1_000 };
  const options = {
    authFile,
    origin,
    now: () => now.value,
    randomBytes,
    idleTimeoutMs: 1_000,
    absoluteTimeoutMs: 2_000,
    loginFailureLimit: 5,
    loginLockoutMs: 10_000,
  };
  return {
    directory,
    authFile,
    now,
    options,
    auth: await OperatorAuth.open(options),
  };
}

test("operator credential provisioning stores only a private password verifier", async () => {
  const state = await fixture();
  try {
    const metadata = lstatSync(state.authFile);
    const persisted = readFileSync(state.authFile, "utf8");
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.ok(
      !persisted.includes(password),
      "auth file excludes plaintext password",
    );
    assert.ok(
      /"version"\s*:\s*1/.test(persisted),
      "auth verifier has a version",
    );
    await assert.rejects(
      OperatorAuth.initialize(state.authFile, "replacement password"),
    );
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("operator login rejects, throttles, and rotates the pre-login session", async () => {
  const state = await fixture();
  try {
    const preLogin = state.auth.createAnonymousSession();
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      failures.push(
        await state.auth.authenticate(preLogin.id, "wrong password"),
      );
    }
    assert.ok(failures.every((session) => session === undefined));
    assert.equal(state.auth.getSession(preLogin.id)?.authenticated, false);
    assert.equal(
      Boolean(await state.auth.authenticate(preLogin.id, password)),
      false,
      "valid credentials are throttled after repeated failed attempts",
    );

    state.now.value += 10_001;
    const freshPreLogin = state.auth.createAnonymousSession();
    const authenticated = await state.auth.authenticate(
      freshPreLogin.id,
      password,
    );
    assert.ok(authenticated);
    assert.equal(authenticated.authenticated, true);
    assert.ok(
      authenticated.id !== freshPreLogin.id,
      "login rotates session ID",
    );
    assert.ok(
      authenticated.csrfToken !== freshPreLogin.csrfToken,
      "login rotates CSRF token",
    );
    assert.equal(
      Boolean(state.auth.getSession(preLogin.id)),
      false,
      "login invalidates the anonymous session",
    );
    assert.equal(state.auth.getSession(authenticated.id)?.authenticated, true);
    assert.equal(
      state.auth.validateCsrf(authenticated.id, authenticated.csrfToken),
      true,
    );
    assert.equal(state.auth.validateCsrf(authenticated.id, "wrong"), false);
    assert.ok(
      !/wrong password|credentialRef|correct horse battery staple/i.test(
        JSON.stringify(failures),
      ),
      "failed login results do not include submitted credentials",
    );
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("operator sessions expire after idle or absolute lifetime and logout", async () => {
  const state = await fixture();
  try {
    const idlePreLogin = state.auth.createAnonymousSession();
    const idle = await state.auth.authenticate(idlePreLogin.id, password);
    assert.ok(idle);
    state.now.value += 900;
    assert.equal(state.auth.getSession(idle.id)?.authenticated, true);
    state.now.value += 1_001;
    assert.equal(
      Boolean(state.auth.getSession(idle.id)),
      false,
      "idle session expires",
    );

    const absolutePreLogin = state.auth.createAnonymousSession();
    const absolute = await state.auth.authenticate(
      absolutePreLogin.id,
      password,
    );
    assert.ok(absolute);
    state.now.value += 2_001;
    assert.equal(
      Boolean(state.auth.getSession(absolute.id)),
      false,
      "absolute session lifetime expires",
    );

    const logoutPreLogin = state.auth.createAnonymousSession();
    const loggedOut = await state.auth.authenticate(
      logoutPreLogin.id,
      password,
    );
    assert.ok(loggedOut);
    state.auth.logout(loggedOut.id);
    assert.equal(
      Boolean(state.auth.getSession(loggedOut.id)),
      false,
      "logout invalidates its session",
    );
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("reopening operator auth invalidates sessions from the previous process", async () => {
  const state = await fixture();
  try {
    const preLogin = state.auth.createAnonymousSession();
    const session = await state.auth.authenticate(preLogin.id, password);
    assert.ok(session);
    state.auth.close();

    const restarted = await OperatorAuth.open(state.options);
    try {
      assert.equal(
        Boolean(restarted.getSession(session.id)),
        false,
        "restart invalidates the previous process session",
      );
    } finally {
      restarted.close();
    }
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("operator auth refuses missing, linked, exposed, or malformed files", async () => {
  const state = await fixture();
  try {
    await assert.rejects(
      OperatorAuth.open({
        ...state.options,
        authFile: join(state.directory, "missing"),
      }),
      /operator authentication configuration is invalid/i,
    );

    const linked = join(state.directory, "linked-auth.json");
    symlinkSync(state.authFile, linked);
    await assert.rejects(
      OperatorAuth.open({ ...state.options, authFile: linked }),
      /operator authentication configuration is invalid/i,
    );

    chmodSync(state.authFile, 0o640);
    await assert.rejects(
      OperatorAuth.open(state.options),
      /operator authentication configuration is invalid/i,
    );

    const malformed = join(state.directory, "malformed-auth.json");
    writeFileSync(malformed, "not a verifier", { mode: 0o600 });
    await assert.rejects(
      OperatorAuth.open({ ...state.options, authFile: malformed }),
      /operator authentication configuration is invalid/i,
    );
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});
