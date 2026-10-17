import { useCallback, useEffect, useRef, useState } from "react";
import { inboxAlertKey } from "../../src/operator/attention.js";
import type {
  InboxItem,
  PushSubscriptionRecord,
} from "../../src/operator/contracts.js";
import {
  ActionOutcome,
  detailRows,
  type OutcomeTone,
} from "./action-feedback.js";
import { ClientError } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { When } from "./operator-credentials.js";
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
  type BrowserSubscription,
  type NotificationState,
} from "./notifications-model.js";
import { failureCause, type ReceiptDetails } from "./outcome-copy.js";
import { useOperatorResource } from "./resource.js";
import { Panel, useHeaderRefresh, type SettingsProps } from "./settings.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.js";

const WORKER_URL = "/app/service-worker.js";
const WORKER_SCOPE = "/app/";

interface Outcome {
  tone: OutcomeTone;
  message: string;
  details: ReceiptDetails;
}

const supported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** This browser's registration for the app scope, without registering one. */
async function registration() {
  return (
    (await navigator.serviceWorker.getRegistration(WORKER_SCOPE)) ?? undefined
  );
}

interface BrowserRead {
  environment: BrowserEnvironment;
  subscription: BrowserSubscription;
}

async function readBrowser(publicKey: string | null): Promise<BrowserRead> {
  const ok = supported();
  const environment: BrowserEnvironment = {
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    serviceWorker:
      typeof navigator !== "undefined" && "serviceWorker" in navigator,
    pushManager: typeof window !== "undefined" && "PushManager" in window,
    notification: typeof window !== "undefined" && "Notification" in window,
    permission: ok ? Notification.permission : "default",
  };
  let subscription: BrowserSubscription = null;
  if (ok) {
    try {
      const existing = await (
        await registration()
      )?.pushManager.getSubscription();
      if (existing) {
        const key = existing.options.applicationServerKey;
        subscription = {
          digest: await endpointDigestOf(existing.endpoint),
          keyMatches:
            publicKey === null ||
            (key !== null && bytesToBase64Url(key) === publicKey),
        };
      }
    } catch {
      subscription = null;
    }
  }
  return { environment, subscription };
}

/**
 * Closes this origin's notifications whose alert is no longer in the Inbox. Called after every
 * complete Inbox read, with the same alert keys the service tagged them with. Best effort: a
 * browser without notifications, or without a registration, has nothing to close.
 */
export async function closeResolvedNotifications(
  items: readonly InboxItem[],
  complete: boolean,
  readStartedAt: number,
): Promise<void> {
  if (!complete || !supported()) return;
  try {
    const open = await (await registration())?.getNotifications();
    if (open?.length)
      closeResolved(
        open.map((n) => ({
          tag: n.tag,
          // Chromium sets it; where a browser does not, the notification counts as older than the read.
          timestamp: (n as { timestamp?: number }).timestamp ?? 0,
          close: () => n.close(),
        })),
        new Set(items.map(inboxAlertKey)),
        complete,
        readStartedAt,
      );
  } catch {
    // Closing is a courtesy; the Inbox stays the source of truth.
  }
}

const cards: Record<
  Exclude<NotificationState["kind"], "off" | "on" | "turn-on-again">,
  {
    title: string;
    tone: "error" | "idle" | "warning";
    body: (host: string) => string;
  }
> = {
  blocked: {
    title: "Blocked in browser settings",
    tone: "error",
    body: (host) =>
      `Your browser is blocking notifications for this address. Allow notifications for ${host} in the browser's site settings, then choose Check again.`,
  },
  unsupported: {
    title: "Not supported here",
    tone: "idle",
    body: () =>
      "This browser can't receive notifications on this address. It needs service workers, Push and Notifications, and a secure address: https:// or http://127.0.0.1. Open Ensemble at its 127.0.0.1 address or over HTTPS.",
  },
  "service-unavailable": {
    title: "Unavailable on the service",
    tone: "warning",
    body: () =>
      "The service can't use its notification key, so no browser can turn notifications on. Everything else in Settings keeps working. The operations guide explains how to recreate the key.",
  },
};

/** Browser notifications for the operator: turn on and off for this browser, test, and revoke others. */
export function NotificationsSection(p: SettingsProps) {
  const csrf = p.session.csrfToken;
  const loader = useCallback(
    (signal: AbortSignal) => p.client.notifications(signal),
    [p.client],
  );
  const list = useOperatorResource(csrf, loader);
  useHeaderRefresh(p.refreshNonce, list.refresh);
  const read = list.state.data?.data;
  const rows = read?.subscriptions ?? [];
  const publicKey = read?.publicKey ?? null;
  const [browser, setBrowser] = useState<BrowserRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [revoking, setRevoking] = useState<PushSubscriptionRecord | null>(null);
  const [revokeOutcome, setRevokeOutcome] = useState<Outcome | null>(null);
  const turnOn = useRef<HTMLButtonElement>(null);
  const sendTest = useRef<HTMLButtonElement>(null);
  const browsers = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<"on" | "off" | null>(null);

  const refreshBrowser = useCallback(async () => {
    setBrowser(await readBrowser(publicKey));
  }, [publicKey]);
  useEffect(() => {
    if (read) void refreshBrowser();
  }, [read, refreshBrowser]);
  // Permission changed in the browser's own settings, or the tab came back to the front.
  useEffect(() => {
    const again = () => void refreshBrowser();
    addEventListener("focus", again);
    let status: PermissionStatus | undefined;
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        status = s;
        s.addEventListener("change", again);
      })
      .catch(() => undefined);
    return () => {
      removeEventListener("focus", again);
      status?.removeEventListener("change", again);
    };
  }, [refreshBrowser]);

  const state: NotificationState | null =
    read && browser
      ? notificationState({
          environment: browser.environment,
          available: read.available,
          subscription: browser.subscription,
          rows,
        })
      : null;
  // After Turn on or Turn off the pressed control is gone: focus the one that replaced it.
  useEffect(() => {
    if (busy || !state) return;
    if (focusNext.current === "on" && state.kind === "on") {
      sendTest.current?.focus();
      focusNext.current = null;
    }
    if (focusNext.current === "off" && state.kind === "off") {
      turnOn.current?.focus();
      focusNext.current = null;
    }
  }, [state, busy]);

  const fail = (error: unknown, did: string, resource?: string): Outcome => {
    const code =
      error instanceof ClientError
        ? error.code
        : error instanceof Error
          ? "browser-setup-failed"
          : "request-failed";
    const cause =
      code === "browser-push-failed"
        ? "this browser's push service refused it"
        : code === "browser-setup-failed"
          ? "the browser couldn't set up notifications"
          : code === "conflict" && did.startsWith("turn on")
            ? "20 browsers already receive notifications; revoke one first"
            : failureCause(code);
    return {
      tone: code === "command-outcome-unknown" ? "warning" : "error",
      message:
        code === "command-outcome-unknown"
          ? `We couldn't confirm ${did}. We're reloading the list below.`
          : `Couldn't ${did}: ${cause}. We're reloading the list below.`,
      details: { resource, code },
    };
  };

  const subscribe = async () => {
    focusNext.current = null;
    setBusy(true);
    setOutcome(null);
    setTest(null);
    let created: PushSubscription | undefined;
    try {
      if (!publicKey) throw new ClientError("unavailable", 503);
      // The permission prompt can only come from this press.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        await refreshBrowser();
        if (permission === "default")
          setOutcome({
            tone: "warning",
            message:
              "Notifications weren't turned on: the permission prompt was dismissed.",
            details: {},
          });
        return;
      }
      let ready: ServiceWorkerRegistration;
      try {
        await navigator.serviceWorker.register(WORKER_URL, {
          scope: WORKER_SCOPE,
          updateViaCache: "none",
        });
        ready = await navigator.serviceWorker.ready;
      } catch {
        throw new ClientError("browser-setup-failed", 0);
      }
      try {
        // A subscription made under another key, or one the service dropped, is replaced.
        if (state?.kind === "turn-on-again")
          await (await ready.pushManager.getSubscription())?.unsubscribe();
        created = await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        });
      } catch {
        throw new ClientError("browser-push-failed", 0);
      }
      const json = created.toJSON();
      await p.client.subscribeNotifications(
        {
          endpoint: created.endpoint,
          keys: {
            p256dh: json.keys?.p256dh ?? "",
            auth: json.keys?.auth ?? "",
          },
          label: browserLabel(navigator.userAgent),
        },
        csrf,
      );
      created = undefined;
      focusNext.current = "on";
    } catch (error) {
      setOutcome(fail(error, "turn on notifications"));
    } finally {
      // A subscription the service never recorded would only collect dead pushes.
      if (created) await created.unsubscribe().catch(() => undefined);
      list.refresh();
      await refreshBrowser();
      setBusy(false);
    }
  };

  const turnOff = async (id: string) => {
    focusNext.current = null;
    setBusy(true);
    setOutcome(null);
    setTest(null);
    try {
      await p.client.revokeNotification(id, csrf);
      // The service has already forgotten this browser; leaving the browser's own
      // subscription behind is shown as Turn on again, so a failure here is not reported.
      await (async () =>
        (
          await (await registration())?.pushManager.getSubscription()
        )?.unsubscribe())().catch(() => undefined);
      focusNext.current = "off";
    } catch (error) {
      setOutcome(fail(error, "turn off notifications", id));
    } finally {
      list.refresh();
      await refreshBrowser();
      setBusy(false);
    }
  };

  const sendTestNotification = async (id: string) => {
    setBusy(true);
    setOutcome(null);
    setTest(null);
    try {
      const r = await p.client.testNotification(id, csrf);
      setTest(testOutcomeText(r.outcome));
    } catch (error) {
      setOutcome(fail(error, "send the test notification", id));
    } finally {
      list.refresh();
      await refreshBrowser();
      setBusy(false);
    }
  };

  const revoke = async (target: PushSubscriptionRecord) => {
    setBusy(true);
    setRevokeOutcome(null);
    try {
      await p.client.revokeNotification(target.id, csrf);
      setRevoking(null);
      setOutcome({
        tone: "success",
        message: `Revoked ${target.label}.`,
        details: { resource: target.id },
      });
      focusNext.current = null;
      requestAnimationFrame(() => browsers.current?.focus());
    } catch (error) {
      setRevokeOutcome(fail(error, `revoke ${target.label}`, target.id));
    } finally {
      list.refresh();
      await refreshBrowser();
      setBusy(false);
    }
  };

  const active = rows.filter((r) => r.state === "active");
  const mine = state?.kind === "on" ? state.id : null;
  const host = typeof location === "undefined" ? "" : location.host;

  return (
    <Panel
      title="Notifications"
      description="Browser notifications when something needs you. Each browser is turned on separately."
    >
      <div className="settings-notify-info body muted">
        <p>
          <strong>What it says.</strong> Kind, project and waiting count, or
          which runtime is unavailable, with a link. No question text, task
          content or error details.
        </p>
        <p>
          <strong>What triggers one.</strong> A new question, approval, problem
          or runtime whose restarts ran out.
        </p>
        <p>
          <strong>What it opens.</strong> That request in the Inbox, after you
          sign in. A notification never answers or approves anything.
        </p>
      </div>
      {list.state.status === "error" && !read && (
        <p className="error-text metadata" role="alert">
          Notifications are unavailable.{" "}
          <Button type="button" variant="secondary" onClick={list.refresh}>
            Retry
          </Button>
        </p>
      )}
      {state && (
        <div className="settings-notify-state">
          {state.kind === "off" && (
            <>
              <div>
                <p className="settings-notify-title">
                  Notifications are off in this browser
                </p>
                <p className="metadata muted">
                  Your browser asks for permission when you turn them on.
                </p>
              </div>
              <Button
                ref={turnOn}
                type="button"
                disabled={busy}
                onClick={() => void subscribe()}
              >
                Turn on notifications
              </Button>
            </>
          )}
          {state.kind === "on" && (
            <>
              <div>
                <p className="settings-notify-title">
                  <StatusBadge tone="success">On</StatusBadge> Notifications are
                  on in this browser
                </p>
                <p className="metadata" role="status">
                  {test && (
                    <span
                      className={
                        test.ok ? "settings-notify-ok" : "settings-notify-fail"
                      }
                    >
                      {test.ok ? "✓ " : "✕ "}
                      {test.text}
                    </span>
                  )}
                </p>
              </div>
              <div className="settings-actions">
                <Button
                  ref={sendTest}
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void sendTestNotification(state.id)}
                >
                  Send test notification
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void turnOff(state.id)}
                >
                  Turn off for this browser
                </Button>
              </div>
            </>
          )}
          {(state.kind === "blocked" ||
            state.kind === "unsupported" ||
            state.kind === "service-unavailable") && (
            <>
              <div>
                <p className="settings-notify-title">
                  <StatusBadge tone={cards[state.kind].tone}>
                    {cards[state.kind].title}
                  </StatusBadge>
                </p>
                <p className="metadata muted">{cards[state.kind].body(host)}</p>
              </div>
              {state.kind === "blocked" && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void refreshBrowser()}
                >
                  Check again
                </Button>
              )}
            </>
          )}
          {state.kind === "turn-on-again" && (
            <>
              <div>
                <p className="settings-notify-title">
                  <StatusBadge tone="warning">Turn on again</StatusBadge>
                </p>
                <p className="metadata muted">
                  {state.why === "old-key"
                    ? "This browser was set up before the notification key changed and no longer receives anything. Turn notifications on again to use the current key."
                    : "This browser is no longer on the list below, so it receives nothing. Turn notifications on again to restore it."}
                </p>
              </div>
              <Button
                ref={turnOn}
                type="button"
                disabled={busy}
                onClick={() => void subscribe()}
              >
                Turn on again
              </Button>
            </>
          )}
        </div>
      )}
      {outcome && (
        <ActionOutcome
          tone={outcome.tone}
          message={outcome.message}
          details={detailRows(outcome.details)}
        />
      )}
      {read && (
        <>
          <div className="settings-panel-header">
            <div>
              <h3 className="small-heading" ref={browsers} tabIndex={-1}>
                Browsers
              </h3>
            </div>
            <span className="metadata muted">
              {rows.length === 0
                ? "0 browsers"
                : `${active.length} active · ${rows.length - active.length} revoked`}
            </span>
          </div>
          {rows.length === 0 && (
            <p className="metadata muted">No browsers receive notifications.</p>
          )}
          <ul
            className="settings-credentials-list"
            aria-label="Browsers that receive notifications, active first"
          >
            {rows.map((r) => (
              <li className="settings-row" key={r.id}>
                <div className="settings-row-heading">
                  <h4 className="small-heading">{r.label}</h4>
                  {r.state === "active" ? (
                    <StatusBadge tone="success">Active</StatusBadge>
                  ) : (
                    <StatusBadge
                      tone={r.revokedReason === "operator" ? "error" : "idle"}
                    >
                      {revokedLabel(r.revokedReason)}
                    </StatusBadge>
                  )}
                  {r.id === mine && <StatusBadge>This browser</StatusBadge>}
                  {r.state === "active" && r.id !== mine && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`Revoke ${r.label}`}
                      onClick={() => {
                        setOutcome(null);
                        setRevokeOutcome(null);
                        setRevoking(r);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
                <dl className="settings-facts metadata">
                  <div>
                    <dt>Push service</dt>
                    <dd className="mono">{r.serviceHost}</dd>
                  </div>
                  <div>
                    <dt>Added</dt>
                    <dd>
                      <When at={r.createdAt} />
                    </dd>
                  </div>
                  {r.state === "active" ? (
                    <div>
                      <dt>Last delivered</dt>
                      <dd>
                        {r.lastSuccessAt === null ? (
                          "never"
                        ) : (
                          <When at={r.lastSuccessAt} />
                        )}
                      </dd>
                    </div>
                  ) : (
                    r.revokedAt !== null && (
                      <div>
                        <dt>Revoked</dt>
                        <dd>
                          <When at={r.revokedAt} />
                        </dd>
                      </div>
                    )
                  )}
                </dl>
                {r.state === "active" && failureText(r.lastFailure) && (
                  <p className="metadata attention-text">
                    ▲ Last delivery failed: {failureText(r.lastFailure)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
      >
        <DialogContent>
          <DialogTitle>Revoke {revoking?.label}?</DialogTitle>
          <DialogDescription>
            That device stops receiving notifications now. It can turn them on
            again from its own Settings.
          </DialogDescription>
          {revokeOutcome && (
            <ActionOutcome
              tone={revokeOutcome.tone}
              message={revokeOutcome.message}
              details={detailRows(revokeOutcome.details)}
            />
          )}
          <div className="settings-actions">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => revoking && void revoke(revoking)}
            >
              Revoke device
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
