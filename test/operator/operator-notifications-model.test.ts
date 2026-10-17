import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base64UrlToBytes,
  browserLabel,
  bytesToBase64Url,
  closeResolved,
  endpointDigestOf,
  failureText,
  notificationState,
  revokedLabel,
  testOutcomeText,
  type BrowserEnvironment,
} from "../../web/src/notifications-model.js";

const environment = (overrides: Partial<BrowserEnvironment> = {}) => ({
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: "default" as const,
  ...overrides,
});
const row = (
  id: string,
  endpointDigest: string,
  state: "active" | "revoked" = "active",
) => ({ id, endpointDigest, state });

const state = (
  overrides: Partial<Parameters<typeof notificationState>[0]> = {},
) =>
  notificationState({
    environment: environment(),
    available: true,
    subscription: null,
    rows: [],
    ...overrides,
  });

test("a browser without service workers, Push, Notifications or a secure context is unsupported", () => {
  for (const missing of [
    "secureContext",
    "serviceWorker",
    "pushManager",
    "notification",
  ] as const)
    assert.deepEqual(
      state({ environment: environment({ [missing]: false }) }),
      { kind: "unsupported" },
      missing,
    );
  // Unsupported wins over every other fact.
  assert.deepEqual(
    state({
      environment: environment({ secureContext: false, permission: "denied" }),
      available: false,
    }),
    { kind: "unsupported" },
  );
});

test("a service without a usable key is unavailable whatever the browser holds", () => {
  assert.deepEqual(
    state({
      available: false,
      subscription: { digest: "a", keyMatches: true },
      rows: [row("1", "a")],
    }),
    { kind: "service-unavailable" },
  );
});

test("denied permission is blocked, and default or granted permission with no subscription is off", () => {
  assert.deepEqual(
    state({ environment: environment({ permission: "denied" }) }),
    {
      kind: "blocked",
    },
  );
  assert.deepEqual(state(), { kind: "off" });
  assert.deepEqual(
    state({ environment: environment({ permission: "granted" }) }),
    {
      kind: "off",
    },
  );
});

test("a subscription whose digest is an active row is on, and that row is this browser", () => {
  assert.deepEqual(
    state({
      environment: environment({ permission: "granted" }),
      subscription: { digest: "mine", keyMatches: true },
      rows: [row("other", "theirs"), row("this", "mine")],
    }),
    { kind: "on", id: "this" },
  );
});

test("a subscription that matches a revoked row or no row is turn on again", () => {
  const granted = environment({ permission: "granted" });
  assert.deepEqual(
    state({
      environment: granted,
      subscription: { digest: "mine", keyMatches: true },
      rows: [row("this", "mine", "revoked")],
    }),
    { kind: "turn-on-again", why: "revoked" },
  );
  assert.deepEqual(
    state({
      environment: granted,
      subscription: { digest: "mine", keyMatches: true },
      rows: [],
    }),
    { kind: "turn-on-again", why: "revoked" },
  );
});

test("a subscription made under another key is turn on again even when its row is active", () => {
  assert.deepEqual(
    state({
      environment: environment({ permission: "granted" }),
      subscription: { digest: "mine", keyMatches: false },
      rows: [row("this", "mine")],
    }),
    { kind: "turn-on-again", why: "old-key" },
  );
});

const READ_AT = 1_000_000;
const open = (tags: string[], timestamp = READ_AT - 1) => {
  const closed: string[] = [];
  return {
    closed,
    list: tags.map((tag) => ({
      tag,
      timestamp,
      close: () => closed.push(tag),
    })),
  };
};

test("closing keeps current alerts and closes only the resolved ones", () => {
  const n = open(["q1", "runtime:codex:S1", "runtime:codex:S0"]);
  assert.equal(
    closeResolved(n.list, new Set(["q1", "runtime:codex:S1"]), true, READ_AT),
    1,
  );
  assert.deepEqual(n.closed, ["runtime:codex:S0"]);
});

test("a recovered runtime's notification closes when no alert is current", () => {
  const n = open(["runtime:codex:S1"]);
  closeResolved(n.list, new Set(), true, READ_AT);
  assert.deepEqual(n.closed, ["runtime:codex:S1"]);
});

test("an incomplete read closes nothing", () => {
  const n = open(["q1", "runtime:codex:S1"]);
  assert.equal(closeResolved(n.list, new Set(), false, READ_AT), 0);
  assert.deepEqual(n.closed, []);
});

test("test notifications and untagged ones are never closed as resolved", () => {
  const n = open(["test:notification", ""]);
  closeResolved(n.list, new Set(), true, READ_AT);
  assert.deepEqual(n.closed, []);
});

test("a notification that arrived after the read began is kept, since the read may not have seen it", () => {
  const n = open(["q-new"], READ_AT);
  const later = open(["q-newer"], READ_AT + 5);
  closeResolved([...n.list, ...later.list], new Set(), true, READ_AT);
  assert.deepEqual([...n.closed, ...later.closed], []);
});

test("a browser label names the browser and system from the user agent", () => {
  const ua = {
    chromeMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    edgeWindows:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    firefoxLinux:
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    safariIphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    chromeAndroid:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    safariMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  };
  assert.equal(browserLabel(ua.chromeMac), "Chrome on macOS");
  assert.equal(browserLabel(ua.edgeWindows), "Edge on Windows");
  assert.equal(browserLabel(ua.firefoxLinux), "Firefox on Linux");
  assert.equal(browserLabel(ua.safariIphone), "Safari on iPhone");
  assert.equal(browserLabel(ua.chromeAndroid), "Chrome on Android");
  assert.equal(browserLabel(ua.safariMac), "Safari on macOS");
  assert.equal(browserLabel("curl/8"), "Browser");
});

test("base64url round trips key bytes and the endpoint digest is a SHA-256 hex", async () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 7) % 256);
  assert.deepEqual(base64UrlToBytes(bytesToBase64Url(bytes)), bytes);
  assert.equal(bytesToBase64Url(bytes).includes("="), false);
  const digest = await endpointDigestOf(
    "https://FCM.googleapis.com/fcm/send/abc",
  );
  assert.match(digest, /^[a-f0-9]{64}$/);
  // The service hashes the URL's normalised form, so a differently-cased host is the same device.
  assert.equal(
    digest,
    await endpointDigestOf("https://fcm.googleapis.com/fcm/send/abc"),
  );
});

test("row and test copy cover every reason, failure and outcome", () => {
  assert.equal(revokedLabel("operator"), "Revoked");
  assert.equal(revokedLabel("gone"), "Removed by the push service");
  assert.equal(revokedLabel("key-changed"), "Key changed — turn on again");
  assert.equal(failureText(null), null);
  assert.equal(failureText("unavailable"), "push service unavailable");
  assert.equal(failureText("rejected"), "push service rejected it");
  assert.equal(failureText("timeout"), "push service timed out");
  assert.deepEqual(testOutcomeText("sent"), {
    ok: true,
    text: "Test notification sent.",
  });
  for (const outcome of ["gone", "rejected", "unavailable", "timeout"] as const)
    assert.equal(testOutcomeText(outcome).ok, false, outcome);
});
