import {
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { PushClock } from "../../src/standalone/operator-push.js";
import type {
  PushRequest,
  PushResponse,
  PushTransport,
} from "../../src/standalone/web-push.js";

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** A browser's push subscription with the private half only the test holds. */
export type FakeDevice = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  readonly ecdh: ReturnType<typeof createECDH>;
  readonly authSecret: Buffer;
};

export type RecordedPush = {
  request: PushRequest;
  device: FakeDevice;
  /** The payload as the browser would decrypt it. */
  plaintext: string;
};

/** Decrypts an RFC 8291 `aes128gcm` body the way a user agent would. */
export function decryptPush(body: Buffer, device: FakeDevice): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const uaPublic = device.ecdh.getPublicKey();
  const ikm = hkdf(
    device.ecdh.computeSecret(asPublic),
    device.authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  const end = padded.lastIndexOf(2);
  if (end < 0) throw new Error("Missing record delimiter");
  return padded.subarray(0, end).toString("utf8");
}

/**
 * A push service in memory: records every request, decrypts it with the subscriber's private
 * key and answers from a per-device script. It never opens a socket.
 */
export class FakePushService {
  readonly requests: RecordedPush[] = [];
  readonly devices = new Map<string, FakeDevice>();
  /** Requests started and not yet answered, now and at the most. */
  inFlight = 0;
  maxInFlight = 0;
  private readonly scripts = new Map<
    string,
    (PushResponse | "hang" | Error)[]
  >();
  private readonly defaultResponse: PushResponse = { status: 201 };

  /** Makes a subscription on an allowlisted host with real P-256 keys. */
  device(label = "Test browser", host = "fcm.googleapis.com"): FakeDevice {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const authSecret = randomBytes(16);
    const device: FakeDevice = {
      endpoint: `https://${host}/fcm/send/${randomBytes(12).toString("base64url")}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: authSecret.toString("base64url"),
      },
      label,
      ecdh,
      authSecret,
    };
    this.devices.set(device.endpoint, device);
    return device;
  }

  /** Answers the device's next requests in order, then the default. */
  script(device: FakeDevice, ...responses: (PushResponse | "hang" | Error)[]) {
    this.scripts.set(device.endpoint, responses);
  }

  for(device: FakeDevice): RecordedPush[] {
    return this.requests.filter((push) => push.device === device);
  }

  /** The decoded payloads sent to a device. */
  payloads(device: FakeDevice) {
    return this.for(device).map((push) => JSON.parse(push.plaintext));
  }

  readonly transport: PushTransport = async (request, signal) => {
    const device = this.devices.get(request.endpoint);
    if (!device) throw new Error(`Unknown push endpoint ${request.endpoint}`);
    this.requests.push({
      request,
      device,
      plaintext: decryptPush(request.body, device),
    });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    let finished = false;
    const finish = () => {
      if (!finished) this.inFlight--;
      finished = true;
    };
    try {
      const next = this.scripts.get(device.endpoint)?.shift();
      if (next === "hang") {
        // Never answers, but a caller that gives up (abort) frees its slot.
        signal.addEventListener("abort", finish, { once: true });
        return await new Promise<PushResponse>(() => {});
      }
      if (next instanceof Error) throw next;
      return next ?? this.defaultResponse;
    } finally {
      finish();
    }
  };
}

/** Time and timers moved by hand: nothing fires until `advance`. */
export class ManualPushClock implements PushClock {
  private time = Date.UTC(2026, 9, 17, 12);
  private readonly timers = new Set<{ at: number; run(): void }>();

  now() {
    return this.time;
  }

  setTimer(action: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, run: action };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }

  /** Timers waiting to fire. */
  pending() {
    return this.timers.size;
  }

  /** Moves time forward, firing due timers in order, including ones they schedule. */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due);
      this.time = Math.max(this.time, due.at);
      due.run();
    }
    this.time = target;
  }
}
