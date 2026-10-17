import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import { FakePushService, decryptPush } from "../fixtures/fake-push.js";
import {
  encryptPayload,
  PUSH_PLAINTEXT_LIMIT,
  fetchPushTransport,
  loadOrCreateVapidKeys,
  PushError,
  validatePushEndpoint,
  vapidAuthorization,
} from "../../src/standalone/web-push.js";

// RFC 8291 Appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const fixed = (salt = rfc.salt) => ({
  salt: Buffer.from(salt, "base64url"),
  ephemeralPrivateKey: Buffer.from(rfc.asPrivate, "base64url"),
});

test("RFC 8291 Appendix A body is reproduced exactly and a changed salt does not match", () => {
  const body = encryptPayload(
    { p256dh: rfc.uaPublic, auth: rfc.auth },
    rfc.plaintext,
    fixed(),
  );
  assert.equal(body.toString("base64url"), rfc.body);
  const flipped = Buffer.from(rfc.salt, "base64url");
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  assert.notEqual(
    encryptPayload(
      { p256dh: rfc.uaPublic, auth: rfc.auth },
      rfc.plaintext,
      fixed(flipped.toString("base64url")),
    ).toString("base64url"),
    rfc.body,
  );
});

test("a payload round trips through a random subscriber key", () => {
  const device = new FakePushService().device();
  const text = JSON.stringify({
    v: 1,
    title: "t",
    url: "/app/inbox",
    tag: "k",
  });
  const body = encryptPayload(device.keys, text);
  assert.equal(decryptPush(body, device), text);
  assert.equal(body.includes(Buffer.from("/app/inbox")), false);
  // Header, delimiter and tag come out of the 4096 bytes every push service accepts.
  assert.equal(
    encryptPayload(device.keys, "x".repeat(PUSH_PLAINTEXT_LIMIT)).length,
    4096,
  );
  assert.throws(
    () => encryptPayload(device.keys, "x".repeat(PUSH_PLAINTEXT_LIMIT + 1)),
    (e) => e instanceof PushError && e.code === "invalid-input",
  );
});

test("every payload gets a fresh salt and ephemeral key", () => {
  const device = new FakePushService().device();
  const [a, b] = [1, 2].map(() => encryptPayload(device.keys, "same text"));
  assert.ok(a && b);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "ephemeral key");
  assert.notDeepEqual(a.subarray(86), b.subarray(86), "ciphertext");
});

test("VAPID authorization carries a verifiable ES256 JWT for the endpoint origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-vapid-"));
  try {
    await chmod(directory, 0o700);
    const keys = await loadOrCreateVapidKeys(join(directory, "vapid.json"));
    const now = Date.UTC(2026, 9, 17, 12);
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      now,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      header,
    );
    assert.ok(match);
    const [, head, claims, signature, k] = match as unknown as string[];
    assert.equal(k, keys.publicKey);
    assert.deepEqual(
      JSON.parse(Buffer.from(head ?? "", "base64url").toString()),
      {
        typ: "JWT",
        alg: "ES256",
      },
    );
    const payload = JSON.parse(
      Buffer.from(claims ?? "", "base64url").toString(),
    );
    assert.equal(payload.aud, "https://fcm.googleapis.com");
    assert.ok(payload.exp > now / 1000 && payload.exp <= now / 1000 + 86_400);
    assert.match(payload.sub, /^mailto:/);
    const pub = Buffer.from(keys.publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    const verifies = (data: string) =>
      verify(
        "sha256",
        Buffer.from(data),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      );
    assert.equal(verifies(`${head}.${claims}`), true);
    assert.equal(verifies(`${head}.${claims}x`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const goodKeys = () => {
  const device = new FakePushService().device();
  return device.keys;
};
const input = (overrides: Record<string, unknown> = {}) => ({
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: goodKeys(),
  label: "Chrome on macOS",
  ...overrides,
});
const refuses = (value: unknown) =>
  assert.throws(
    () => validatePushEndpoint(value),
    (e) => e instanceof PushError && e.code === "invalid-input",
  );

test("endpoint validation accepts only vendor push hosts over plain https", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAb",
    "https://us-east-1.push.apple.com/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])
    assert.equal(validatePushEndpoint(input({ endpoint })).endpoint, endpoint);
  assert.equal(
    validatePushEndpoint(input({ endpoint: "https://FCM.googleapis.com/x" }))
      .host,
    "fcm.googleapis.com",
  );
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:443/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user@fcm.googleapis.com/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com/fcm/send/abc#frag",
    "https://fcm.googleapis.com@evil.test/fcm/send/abc",
    "https://evil.test\\@fcm.googleapis.com/x",
    "https://127.0.0.1/abc",
    "https://10.0.0.1/abc",
    "https://[::1]/abc",
    "https://[2001:db8::1]/abc",
    "https://localhost/abc",
    "https://127.0.0.1.nip.io/abc",
    "https://fcm.googleapis.com.evil.test/abc",
    "https://evilpush.apple.com/abc",
    "https://push.apple.com/abc",
    "https://evil.test/fcm.googleapis.com",
    "https://fcm.googleapis.com./abc",
    "//fcm.googleapis.com/abc",
    "ftp://fcm.googleapis.com/abc",
    `https://fcm.googleapis.com/${"a".repeat(2049 - "https://fcm.googleapis.com/".length)}`,
    // Hosts that do not fit DNS, so a stored host always fits the list's metadata.
    `https://${"a".repeat(64)}.push.apple.com/x`,
    `https://${`${"a".repeat(60)}.`.repeat(5)}push.apple.com/x`,
    "https://a..push.apple.com/x",
    // Normalisation that grows the address past the limit.
    `https://fcm.googleapis.com/x?${"'".repeat(700)}`,
  ])
    refuses(input({ endpoint }));
});

test("endpoint validation checks keys and labels", () => {
  const valid = goodKeys();
  const sized = (bytes: number) => randomBytes(bytes).toString("base64url");
  refuses(input({ keys: { ...valid, p256dh: sized(64) } }));
  refuses(input({ keys: { ...valid, p256dh: sized(66) } }));
  // 65 bytes with the uncompressed marker that are not a point on the curve.
  refuses(
    input({
      keys: {
        ...valid,
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString(
          "base64url",
        ),
      },
    }),
  );
  refuses(input({ keys: { ...valid, auth: sized(15) } }));
  refuses(input({ keys: { ...valid, auth: sized(17) } }));
  // Padding some browsers add is tolerated and stored without it.
  assert.equal(
    validatePushEndpoint(input({ keys: { ...valid, auth: `${valid.auth}==` } }))
      .auth,
    valid.auth,
  );
  assert.equal(
    validatePushEndpoint(
      input({ keys: { ...valid, p256dh: `${valid.p256dh}=` } }),
    ).p256dh,
    valid.p256dh,
  );
  refuses(input({ keys: { ...valid, auth: `${valid.auth}===` } }));
  refuses(input({ label: "" }));
  refuses(input({ label: "x".repeat(65) }));
  refuses(input({ label: "tab\there" }));
  refuses(input({ label: "line\nbreak" }));
  refuses(input({ extra: true }));
  refuses(input({ keys: { ...valid, extra: "x" } }));
  refuses(null);
  assert.equal(
    validatePushEndpoint(input({ label: "x".repeat(64) })).label.length,
    64,
  );
});

const unsafe = async (
  prepare: (file: string, directory: string) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-vapid-"));
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "vapid.json");
    await prepare(file, directory);
    await assert.rejects(
      loadOrCreateVapidKeys(file),
      (e) => e instanceof PushError && e.message === "unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("the VAPID key file is created owner-only and reused, including by concurrent callers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-vapid-"));
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "operator-push-vapid.json");
    const concurrent = await Promise.all([
      loadOrCreateVapidKeys(file),
      loadOrCreateVapidKeys(file),
      loadOrCreateVapidKeys(file),
    ]);
    assert.equal(new Set(concurrent.map((k) => k.publicKey)).size, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const again = await loadOrCreateVapidKeys(file);
    assert.equal(again.publicKey, concurrent[0]?.publicKey);
    assert.equal(again.keyId, concurrent[0]?.keyId);
    // No temporary file is left behind.
    assert.deepEqual(await readdir(directory), ["operator-push-vapid.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a private key with leading zero bytes is created, stored in full and loaded again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-vapid-"));
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "vapid.json");
    const scalar = Buffer.alloc(32, 0x11);
    scalar[0] = 0;
    scalar[1] = 0;
    const created = await loadOrCreateVapidKeys(file, () => scalar);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Buffer.from(stored.privateKey, "base64url").length, 32);
    // A second process reads what the first wrote.
    const loaded = await loadOrCreateVapidKeys(file);
    assert.equal(loaded.publicKey, created.publicKey);
    assert.equal(loaded.keyId, created.keyId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unsafe VAPID key file fails closed without revealing its contents", async () => {
  await unsafe(async (file) => {
    await loadOrCreateVapidKeys(file);
    await chmod(file, 0o644);
  });
  await unsafe(async (file, directory) => {
    await writeFile(join(directory, "target.json"), "{}", { mode: 0o600 });
    await symlink(join(directory, "target.json"), file);
  });
  await unsafe(async (file) => {
    // Valid but padded past the limit: only the size check stands between it and the parser.
    await loadOrCreateVapidKeys(`${file}.valid`);
    await writeFile(
      file,
      `${await readFile(`${file}.valid`, "utf8")}${" ".repeat(5000)}`,
      { mode: 0o600 },
    );
  });
  await unsafe(async (file) => {
    await writeFile(file, "SECRET-NOT-JSON", { mode: 0o600 });
  });
  await unsafe(async (file) => {
    await loadOrCreateVapidKeys(file);
    const record = JSON.parse(await readFile(file, "utf8"));
    // A public key that does not belong to the private key.
    record.publicKey = (await loadOrCreateVapidKeys(`${file}.other`)).publicKey;
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  });
  await unsafe(async (file, directory) => {
    await mkdir(file);
    assert.ok(directory);
  });
  // A relative path never resolves against the working directory.
  await assert.rejects(loadOrCreateVapidKeys("operator-push-vapid.json"));
});

test("the transport maps failures to fixed codes and never follows a redirect", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/SECRET-TOKEN";
  const request = { endpoint, headers: {}, body: Buffer.from("x") };
  const thrown = await fetchPushTransport(async () => {
    throw new Error(`connect ECONNREFUSED ${endpoint}`);
  })(request, new AbortController().signal);
  assert.deepEqual(thrown, { failure: "unavailable" });
  assert.equal(JSON.stringify(thrown).includes("SECRET-TOKEN"), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await fetchPushTransport(async () => {
      throw new Error(endpoint);
    })(request, aborted.signal),
    { failure: "timeout" },
  );
  let calls = 0;
  const redirected = await fetchPushTransport(async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.test/" },
    });
  })(request, new AbortController().signal);
  assert.equal(calls, 1);
  assert.ok(
    "status" in redirected &&
      redirected.status >= 300 &&
      redirected.status < 400,
  );
  assert.deepEqual(
    await fetchPushTransport(
      async () =>
        new Response("body", { status: 429, headers: { "retry-after": "90" } }),
    )(request, new AbortController().signal),
    { status: 429, retryAfterSeconds: 90 },
  );
});
