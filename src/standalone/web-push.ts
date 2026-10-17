import {
  createECDH,
  createHash,
  createPrivateKey,
  createCipheriv,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { pushSubscribeRequestSchema } from "../operator/contracts.js";

/** Web Push for the operator: RFC 8291 payload encryption and RFC 8292 VAPID on node:crypto. */

/** A fixed, content-free failure: callers map it to an API error without any detail. */
export class PushError extends Error {
  constructor(
    readonly code: "invalid-input" | "not-found" | "conflict" | "unavailable",
  ) {
    super(code);
  }
}

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
/** Push services must accept 4096 bytes in all: the header (salt, record size, key id, key), the delimiter and the tag come out of it. */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
export const PUSH_PLAINTEXT_LIMIT = 4096 - HEADER_LENGTH - 1 - TAG_LENGTH;
const MAX_ENDPOINT_LENGTH = 2048;
const KEY_FILE_FORMAT = "ensemble-operator-push-vapid";
const MAX_KEY_FILE_BYTES = 4_096;
const VAPID_SUBJECT = "mailto:operator@ensemble.invalid";
const VAPID_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Exact hosts of the browser vendors' push services, and the domains whose subdomains qualify. */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;
const PUSH_DOMAINS = ["push.apple.com", "notify.windows.com"] as const;

export const pushHostAllowed = (host: string) =>
  (PUSH_HOSTS as readonly string[]).includes(host) ||
  PUSH_DOMAINS.some((domain) => host.endsWith(`.${domain}`));

export const endpointDigest = (endpoint: string) =>
  createHash("sha256").update(endpoint, "utf8").digest("hex");

const b64 = (value: Buffer) => value.toString("base64url");

/** Strict base64url of an exact length; trailing padding some browsers add is tolerated. */
function decodeKey(value: string, length: number): Buffer {
  const text = value.replace(/={0,2}$/, "");
  const decoded = Buffer.from(text, "base64url");
  if (decoded.length !== length || b64(decoded) !== text)
    throw new PushError("invalid-input");
  return decoded;
}

export type ValidatedSubscription = {
  endpoint: string;
  host: string;
  p256dh: string;
  auth: string;
  label: string;
};

/**
 * The only door an endpoint passes through before it is stored and later fetched. https on a
 * vendor host, nothing else: no port, userinfo, fragment or IP literal. The raw text is matched
 * before URL parsing because parsing hides an explicit default port.
 */
export function validatePushEndpoint(input: unknown): ValidatedSubscription {
  const parsed = pushSubscribeRequestSchema.safeParse(input);
  if (!parsed.success) throw new PushError("invalid-input");
  const { endpoint, keys, label } = parsed.data;
  const shape =
    /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*)?(\?[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?$/.exec(
      endpoint,
    );
  if (!shape || endpoint.length > MAX_ENDPOINT_LENGTH)
    throw new PushError("invalid-input");
  // DNS limits, so a stored host always fits the metadata the list returns.
  const hostText = shape[1] ?? "";
  if (
    hostText.length > 253 ||
    hostText.split(".").some((label) => !label || label.length > 63)
  )
    throw new PushError("invalid-input");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError("invalid-input");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.href.length > MAX_ENDPOINT_LENGTH ||
    host !== (shape[1] ?? "").toLowerCase() ||
    !pushHostAllowed(host)
  )
    throw new PushError("invalid-input");
  const p256dh = decodeKey(keys.p256dh, 65);
  const auth = decodeKey(keys.auth, 16);
  if (p256dh[0] !== 4) throw new PushError("invalid-input");
  try {
    // A trial agreement proves the bytes are a point on the curve.
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(p256dh);
  } catch {
    throw new PushError("invalid-input");
  }
  return {
    endpoint: url.href,
    host,
    p256dh: b64(p256dh),
    auth: b64(auth),
    label,
  };
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * RFC 8291 `aes128gcm`: ECDH P-256 against the subscription, HKDF-SHA-256, one 4096-byte record.
 * The salt and the ephemeral key are injectable only for the RFC's test vector.
 */
export function encryptPayload(
  subscription: Pick<ValidatedSubscription, "p256dh" | "auth">,
  plaintext: Buffer | string,
  fixed: { salt?: Buffer; ephemeralPrivateKey?: Buffer } = {},
): Buffer {
  const data = Buffer.from(plaintext);
  if (data.length > PUSH_PLAINTEXT_LIMIT) throw new PushError("invalid-input");
  const uaPublic = decodeKey(subscription.p256dh, 65);
  const authSecret = decodeKey(subscription.auth, 16);
  const ephemeral = createECDH("prime256v1");
  if (fixed.ephemeralPrivateKey)
    ephemeral.setPrivateKey(fixed.ephemeralPrivateKey);
  else ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);
  const shared = ephemeral.computeSecret(uaPublic);
  const ikm = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([data, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type VapidKeys = {
  /** The uncompressed P-256 public key, base64url. */
  publicKey: string;
  /** SHA-256 of the public key, to tell subscriptions made under another key. */
  keyId: string;
  sign(data: Buffer): Buffer;
};

const keyFileSchema = z
  .object({
    format: z.literal(KEY_FILE_FORMAT),
    version: z.literal(1),
    privateKey: z.string().length(43),
    publicKey: z.string().length(87),
  })
  .strict();

function vapidKeysFrom(privateKey: Buffer, publicKey?: string): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const pub = ecdh.getPublicKey();
  if (publicKey !== undefined && b64(pub) !== publicKey)
    throw new PushError("unavailable");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64(pub.subarray(1, 33)),
      y: b64(pub.subarray(33, 65)),
      d: b64(privateKey),
    },
    format: "jwk",
  });
  return {
    publicKey: b64(pub),
    keyId: createHash("sha256").update(pub).digest("hex"),
    sign: (data) => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }),
  };
}

/** Reads the key file only when it is a regular, owner-only file this user owns; undefined when absent. */
async function readKeyFile(file: string): Promise<string | undefined> {
  const owner = process.getuid?.();
  if (owner === undefined) throw new PushError("unavailable");
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PushError("unavailable");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== owner ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > MAX_KEY_FILE_BYTES
  )
    throw new PushError("unavailable");
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.uid !== owner ||
      (actual.mode & 0o777) !== 0o600 ||
      actual.size > MAX_KEY_FILE_BYTES
    )
      throw new PushError("unavailable");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/** The link() step creates the final name without replacing a file a racing creator made. */
async function createKeyFile(
  file: string,
  privateKeySource: () => Buffer,
): Promise<void> {
  // The full 32-byte scalar is kept as generated: ECDH.getPrivateKey() drops leading zero bytes.
  const privateKey = privateKeySource();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const contents = `${JSON.stringify({
    format: KEY_FILE_FORMAT,
    version: 1,
    privateKey: b64(privateKey),
    publicKey: b64(ecdh.getPublicKey()),
  })}\n`;
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  // Every path removes the temporary file, so a failed write never leaves key material behind.
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * The VAPID key pair for this service. It lives only in this owner-only file; an unsafe, corrupt
 * or unreadable file fails closed with a fixed error that names neither its contents nor a key.
 */
export async function loadOrCreateVapidKeys(
  file: string,
  privateKeySource: () => Buffer = () => randomBytes(32),
): Promise<VapidKeys> {
  try {
    if (!isAbsolute(file)) throw new PushError("unavailable");
    let contents = await readKeyFile(file);
    if (contents === undefined) {
      await createKeyFile(file, privateKeySource);
      contents = await readKeyFile(file);
    }
    if (contents === undefined) throw new PushError("unavailable");
    const record = keyFileSchema.parse(JSON.parse(contents));
    return vapidKeysFrom(decodeKey(record.privateKey, 32), record.publicKey);
  } catch {
    throw new PushError("unavailable");
  }
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for the endpoint's origin. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: number,
): string {
  const encode = (value: object) =>
    b64(Buffer.from(JSON.stringify(value), "utf8"));
  const input = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor((now + VAPID_LIFETIME_MS) / 1000),
    sub: VAPID_SUBJECT,
  })}`;
  return `vapid t=${input}.${b64(keys.sign(Buffer.from(input)))}, k=${keys.publicKey}`;
}

export type PushRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
};
/** A push service's answer, or a fixed failure code; never an error message. */
export type PushResponse =
  | { status: number; retryAfterSeconds?: number }
  | { failure: "unavailable" | "timeout" };
export type PushTransport = (
  request: PushRequest,
  signal: AbortSignal,
) => Promise<PushResponse>;

/**
 * Posts the encrypted body once. Redirects are never followed, the response body is discarded,
 * and a raw fetch error (which can carry the endpoint URL) becomes a fixed code.
 */
export function fetchPushTransport(
  fetcher: typeof fetch = fetch,
): PushTransport {
  return async (request, signal) => {
    try {
      const response = await fetcher(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: new Uint8Array(request.body),
        redirect: "manual",
        signal,
      });
      await response.body?.cancel().catch(() => undefined);
      const retryAfter = /^[0-9]{1,9}$/.test(
        response.headers.get("retry-after") ?? "",
      )
        ? Number(response.headers.get("retry-after"))
        : undefined;
      return {
        // A browser-style opaque redirect has status 0; either way it is a refusal.
        status: response.type === "opaqueredirect" ? 302 : response.status,
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      };
    } catch {
      return { failure: signal.aborted ? "timeout" : "unavailable" };
    }
  };
}

/** Headers for one encrypted push to an endpoint. */
export function pushHeaders(authorization: string): Record<string, string> {
  return {
    authorization,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: "86400",
  };
}
