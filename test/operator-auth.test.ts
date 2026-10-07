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
import { createControlledPasswordDeriver } from "./fixtures/operator-auth-concurrency.js";

const password = "correct horse battery staple";
const origin = "http://127.0.0.1:8787";
type AuthAttempt = ReturnType<OperatorAuth["authenticate"]>;

function randomSource() {
  let value = 0;
  return (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++value);
    return bytes;
  };
}

async function authFileFixture(
  overrides: {
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
    loginFailureLimit?: number;
    loginLockoutMs?: number;
  } = {},
) {
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
    idleTimeoutMs: overrides.idleTimeoutMs ?? 1_000,
    absoluteTimeoutMs: overrides.absoluteTimeoutMs ?? 2_000,
    loginFailureLimit: overrides.loginFailureLimit ?? 5,
    loginLockoutMs: overrides.loginLockoutMs ?? 10_000,
  };
  return {
    directory,
    authFile,
    now,
    options,
  };
}

async function fixture(overrides: Parameters<typeof authFileFixture>[0] = {}) {
  const state = await authFileFixture(overrides);
  return { ...state, auth: await OperatorAuth.open(state.options) };
}

async function controlledFixture(
  overrides: Parameters<typeof authFileFixture>[0] = {},
) {
  const state = await authFileFixture(overrides);
  const record = JSON.parse(readFileSync(state.authFile, "utf8")) as {
    verifier: string;
  };
  const deriver = createControlledPasswordDeriver(
    password,
    Buffer.from(record.verifier, "base64url"),
  );
  const auth = await OperatorAuth.open({
    ...state.options,
    derivePassword: deriver.derivePassword,
  });
  return { ...state, auth, deriver };
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
    const verifier = (
      JSON.parse(readFileSync(state.authFile, "utf8")) as { verifier: string }
    ).verifier;
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
      ) && !JSON.stringify(failures).includes(verifier),
      "failed login results do not include submitted credentials",
    );
  } finally {
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("operator login admits at most four derivations without queueing and reuses released capacity", async () => {
  const state = await controlledFixture();
  const pending: AuthAttempt[] = [];
  try {
    const sessions = Array.from({ length: 5 }, () =>
      state.auth.createAnonymousSession(),
    );
    for (const session of sessions.slice(0, 4))
      pending.push(state.auth.authenticate(session.id, password));
    await state.deriver.waitForCalls(4);

    assert.equal(
      await state.auth.authenticate(sessions[4]!.id, password),
      undefined,
      "the fifth derivation is rejected while all slots are occupied",
    );
    assert.equal(state.deriver.calls.length, 4);

    state.deriver.release(0);
    assert.equal((await pending[0]!)?.authenticated, true);
    assert.equal(
      state.deriver.calls.length,
      4,
      "releasing does not start a queue",
    );

    const laterSession = state.auth.createAnonymousSession();
    const laterAttempt = state.auth.authenticate(laterSession.id, password);
    pending.push(laterAttempt);
    await state.deriver.waitForCalls(5);
    assert.equal(state.deriver.calls.length, 5);
    state.deriver.release(4);
    assert.equal((await laterAttempt)?.authenticated, true);
  } finally {
    state.deriver.releaseAll();
    await Promise.allSettled(pending);
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("one anonymous session has one in-flight login and one successful rotation", async () => {
  const state = await controlledFixture();
  let pending: AuthAttempt | undefined;
  try {
    const anonymous = state.auth.createAnonymousSession();
    pending = state.auth.authenticate(anonymous.id, password);
    await state.deriver.waitForCalls(1);

    assert.equal(
      await state.auth.authenticate(anonymous.id, password),
      undefined,
    );
    assert.equal(state.deriver.calls.length, 1);

    state.deriver.release(0);
    const authenticated = await pending;
    assert.ok(authenticated && authenticated.authenticated);
    assert.notEqual(authenticated.id, anonymous.id);
    assert.notEqual(authenticated.csrfToken, anonymous.csrfToken);
    assert.equal(state.auth.getSession(anonymous.id), undefined);
    assert.equal(
      state.auth.validateCsrf(anonymous.id, anonymous.csrfToken),
      false,
    );
    assert.equal(
      await state.auth.authenticate(anonymous.id, password),
      undefined,
    );
    assert.equal(
      state.deriver.calls.length,
      1,
      "the rotated ID cannot be replayed",
    );
    assert.equal(state.auth.getSession(authenticated.id)?.authenticated, true);
  } finally {
    state.deriver.releaseAll();
    if (pending) await Promise.allSettled([pending]);
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("lockout follows derivation settlement order", async () => {
  const wrongFirst = await controlledFixture({ loginFailureLimit: 2 });
  const pendingWrongFirst: AuthAttempt[] = [];
  try {
    const prior = wrongFirst.auth.createAnonymousSession();
    const priorAttempt = wrongFirst.auth.authenticate(
      prior.id,
      "wrong sentinel",
    );
    pendingWrongFirst.push(priorAttempt);
    await wrongFirst.deriver.waitForCalls(1);
    wrongFirst.deriver.release(0);
    assert.equal(await priorAttempt, undefined);

    const wrong = wrongFirst.auth.createAnonymousSession();
    const correct = wrongFirst.auth.createAnonymousSession();
    const wrongAttempt = wrongFirst.auth.authenticate(
      wrong.id,
      "wrong sentinel",
    );
    pendingWrongFirst.push(wrongAttempt);
    await wrongFirst.deriver.waitForCalls(2);
    const correctAttempt = wrongFirst.auth.authenticate(correct.id, password);
    pendingWrongFirst.push(correctAttempt);
    await wrongFirst.deriver.waitForCalls(3);
    wrongFirst.deriver.release(1);
    assert.equal(await wrongAttempt, undefined);
    wrongFirst.deriver.release(2);
    assert.equal(await correctAttempt, undefined);
    assert.equal(
      await wrongFirst.auth.authenticate(
        wrongFirst.auth.createAnonymousSession().id,
        password,
      ),
      undefined,
      "the lockout remains active after the later correct result settles",
    );
    assert.equal(wrongFirst.deriver.calls.length, 3);
  } finally {
    wrongFirst.deriver.releaseAll();
    await Promise.allSettled(pendingWrongFirst);
    wrongFirst.auth.close();
    rmSync(wrongFirst.directory, { recursive: true, force: true });
  }

  const correctFirst = await controlledFixture({ loginFailureLimit: 2 });
  const pendingCorrectFirst: AuthAttempt[] = [];
  try {
    const prior = correctFirst.auth.createAnonymousSession();
    const priorAttempt = correctFirst.auth.authenticate(
      prior.id,
      "wrong sentinel",
    );
    pendingCorrectFirst.push(priorAttempt);
    await correctFirst.deriver.waitForCalls(1);
    correctFirst.deriver.release(0);
    assert.equal(await priorAttempt, undefined);

    const wrong = correctFirst.auth.createAnonymousSession();
    const correct = correctFirst.auth.createAnonymousSession();
    const wrongAttempt = correctFirst.auth.authenticate(
      wrong.id,
      "wrong sentinel",
    );
    pendingCorrectFirst.push(wrongAttempt);
    await correctFirst.deriver.waitForCalls(2);
    const correctAttempt = correctFirst.auth.authenticate(correct.id, password);
    pendingCorrectFirst.push(correctAttempt);
    await correctFirst.deriver.waitForCalls(3);
    correctFirst.deriver.release(2);
    assert.equal((await correctAttempt)?.authenticated, true);
    correctFirst.deriver.release(1);
    assert.equal(await wrongAttempt, undefined);

    const afterSettlement = correctFirst.auth.createAnonymousSession();
    const nextCorrect = correctFirst.auth.authenticate(
      afterSettlement.id,
      password,
    );
    pendingCorrectFirst.push(nextCorrect);
    await correctFirst.deriver.waitForCalls(4);
    correctFirst.deriver.release(3);
    assert.equal((await nextCorrect)?.authenticated, true);
  } finally {
    correctFirst.deriver.releaseAll();
    await Promise.allSettled(pendingCorrectFirst);
    correctFirst.auth.close();
    rmSync(correctFirst.directory, { recursive: true, force: true });
  }
});

test("stale and closed anonymous records cannot be revived by a held correct login", async () => {
  for (const scenario of [
    "logout",
    "idle",
    "absolute",
    "eviction",
    "close",
  ] as const) {
    const state = await controlledFixture();
    let pending: AuthAttempt | undefined;
    try {
      const anonymous = state.auth.createAnonymousSession();
      pending = state.auth.authenticate(anonymous.id, password);
      await state.deriver.waitForCalls(1);

      if (scenario === "logout") state.auth.logout(anonymous.id);
      if (scenario === "idle") state.now.value += 1_000;
      if (scenario === "absolute") {
        for (let interval = 0; interval < 4; interval += 1) {
          state.now.value += 500;
          if (interval < 3)
            assert.equal(
              state.auth.getSession(anonymous.id)?.authenticated,
              false,
            );
        }
      }
      if (scenario === "eviction")
        for (let count = 0; count < 256; count += 1)
          state.auth.createAnonymousSession();
      if (scenario === "close") state.auth.close();

      state.deriver.release(0);
      assert.equal(await pending, undefined, `${scenario} result is discarded`);
      assert.equal(state.auth.getSession(anonymous.id), undefined);
    } finally {
      state.deriver.releaseAll();
      if (pending) await Promise.allSettled([pending]);
      state.auth.close();
      rmSync(state.directory, { recursive: true, force: true });
    }
  }
});

test("close discards an admitted wrong result without settling lockout state", async () => {
  const state = await controlledFixture({ loginFailureLimit: 1 });
  let pending: AuthAttempt | undefined;
  try {
    const anonymous = state.auth.createAnonymousSession();
    pending = state.auth.authenticate(anonymous.id, "wrong sentinel");
    await state.deriver.waitForCalls(1);
    const lockout = state.auth as unknown as {
      failedLogins: number;
      lockedUntil: number;
    };

    state.auth.close();
    assert.equal(lockout.failedLogins, 0);
    assert.equal(lockout.lockedUntil, 0);
    state.deriver.release(0);
    assert.equal(await pending, undefined);
    assert.equal(lockout.failedLogins, 0);
    assert.equal(lockout.lockedUntil, 0);
  } finally {
    state.deriver.releaseAll();
    if (pending) await Promise.allSettled([pending]);
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("invalidated wrong results count once and derivation failures release capacity safely", async () => {
  const state = await controlledFixture({ loginFailureLimit: 1 });
  const pending: AuthAttempt[] = [];
  try {
    const invalidated = state.auth.createAnonymousSession();
    const wrongAttempt = state.auth.authenticate(
      invalidated.id,
      "wrong sentinel",
    );
    pending.push(wrongAttempt);
    await state.deriver.waitForCalls(1);
    state.auth.logout(invalidated.id);
    state.deriver.release(0);
    assert.equal(await wrongAttempt, undefined);

    const afterWrong = state.auth.createAnonymousSession();
    assert.equal(
      await state.auth.authenticate(afterWrong.id, password),
      undefined,
      "an admitted wrong result still reaches the lockout after logout",
    );
    assert.equal(state.deriver.calls.length, 1);

    state.now.value += 10_001;
    const rejected = state.auth.createAnonymousSession();
    const rejectedAttempt = state.auth.authenticate(rejected.id, password);
    pending.push(rejectedAttempt);
    await state.deriver.waitForCalls(2);
    state.deriver.reject(1, new Error("wrong sentinel and verifier sentinel"));
    assert.equal(await rejectedAttempt, undefined);

    const recovered = state.auth.createAnonymousSession();
    const recoveredAttempt = state.auth.authenticate(recovered.id, password);
    pending.push(recoveredAttempt);
    await state.deriver.waitForCalls(3);
    state.deriver.release(2);
    assert.equal((await recoveredAttempt)?.authenticated, true);
  } finally {
    state.deriver.releaseAll();
    await Promise.allSettled(pending);
    state.auth.close();
    rmSync(state.directory, { recursive: true, force: true });
  }

  const malformed = await authFileFixture();
  const malformedAuth = await OperatorAuth.open({
    ...malformed.options,
    derivePassword: async () => Buffer.alloc(1),
  });
  try {
    const session = malformedAuth.createAnonymousSession();
    await assert.doesNotReject(
      malformedAuth.authenticate(session.id, "wrong sentinel"),
    );
    assert.equal(
      await malformedAuth.authenticate(session.id, password),
      undefined,
    );
  } finally {
    malformedAuth.close();
    rmSync(malformed.directory, { recursive: true, force: true });
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
