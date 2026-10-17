import type { PushSubscriptionRecord } from "../../src/operator/contracts.js";

/** What this browser can do about push, read once from the page. */
export interface BrowserEnvironment {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: "default" | "granted" | "denied";
}

/** This browser's own push subscription, if any: the digest of its endpoint and whether it used the served key. */
export type BrowserSubscription = {
  digest: string;
  keyMatches: boolean;
} | null;

export type NotificationState =
  | { kind: "unsupported" }
  | { kind: "service-unavailable" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; id: string }
  | { kind: "turn-on-again"; why: "revoked" | "old-key" };

/**
 * The one answer to "what does this browser's Notifications section show": derived from the
 * browser and the service's list, and never stored. A subscription the service no longer lists
 * as active (revoked elsewhere, removed by the push service, or never recorded) and one made
 * under another key both end in Turn on again.
 */
export function notificationState(input: {
  environment: BrowserEnvironment;
  available: boolean;
  subscription: BrowserSubscription;
  rows: readonly Pick<
    PushSubscriptionRecord,
    "id" | "endpointDigest" | "state"
  >[];
}): NotificationState {
  const { environment: e, subscription } = input;
  if (!e.secureContext || !e.serviceWorker || !e.pushManager || !e.notification)
    return { kind: "unsupported" };
  if (!input.available) return { kind: "service-unavailable" };
  if (e.permission === "denied") return { kind: "blocked" };
  if (!subscription) return { kind: "off" };
  if (!subscription.keyMatches)
    return { kind: "turn-on-again", why: "old-key" };
  const row = input.rows.find(
    (r) => r.state === "active" && r.endpointDigest === subscription.digest,
  );
  return row
    ? { kind: "on", id: row.id }
    : { kind: "turn-on-again", why: "revoked" };
}

/** The tag prefix of a test notification, which is not an Inbox alert and is never auto-closed. */
export const TEST_TAG_PREFIX = "test:";

export interface OpenNotification {
  tag: string;
  /** Milliseconds since the epoch at which the browser created it. */
  timestamp: number;
  close(): void;
}

/**
 * Closes the notifications whose alert is no longer in the Inbox. Only a complete read can say a
 * request is gone, so a partial read closes nothing, and a notification newer than the read's
 * start may be about an alert the read never saw, so it stays. Test notifications and ones
 * without a tag are not alerts and stay.
 */
export function closeResolved(
  open: readonly OpenNotification[],
  current: ReadonlySet<string>,
  complete: boolean,
  readStartedAt: number,
): number {
  if (!complete) return 0;
  let closed = 0;
  for (const notification of open) {
    if (!notification.tag || notification.tag.startsWith(TEST_TAG_PREFIX))
      continue;
    if (notification.timestamp >= readStartedAt) continue;
    if (!current.has(notification.tag)) {
      notification.close();
      closed++;
    }
  }
  return closed;
}

/** "Chrome on macOS": a label the operator recognises, from the user agent alone. */
export function browserLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(userAgent)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Macintosh|Mac OS X/.test(userAgent)
          ? "macOS"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux|X11/.test(userAgent)
              ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hex of the endpoint as the service stores it (the URL's normalised form). */
export async function endpointDigestOf(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(new URL(endpoint).href),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The state of a revoked row, as the operator reads it. */
export function revokedLabel(reason: PushSubscriptionRecord["revokedReason"]) {
  switch (reason) {
    case "gone":
      return "Removed by the push service";
    case "key-changed":
      return "Key changed — turn on again";
    default:
      return "Revoked";
  }
}

export function failureText(failure: PushSubscriptionRecord["lastFailure"]) {
  switch (failure) {
    case "rejected":
      return "push service rejected it";
    case "timeout":
      return "push service timed out";
    case "unavailable":
      return "push service unavailable";
    case null:
      return null;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** The line a test notification leaves behind, by the service's outcome. */
export function testOutcomeText(
  outcome: "sent" | "gone" | "rejected" | "unavailable" | "timeout",
): { ok: boolean; text: string } {
  switch (outcome) {
    case "sent":
      return { ok: true, text: "Test notification sent." };
    case "gone":
      return {
        ok: false,
        text: "The push service no longer knows this browser. Turn notifications on again.",
      };
    case "rejected":
      return {
        ok: false,
        text: "The push service rejected the test notification.",
      };
    case "timeout":
      return {
        ok: false,
        text: "The push service didn't answer in time. Try again.",
      };
    case "unavailable":
      return { ok: false, text: "The push service is unavailable. Try again." };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
