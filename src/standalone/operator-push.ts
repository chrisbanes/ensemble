import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Database, transaction } from "../core/store.js";
import {
  inboxAlertKey,
  inboxSelectionHref,
  kindLabels,
} from "../operator/attention.js";
import {
  type InboxItem,
  type PushSubscriptionRecord,
  pushFailureSchema,
  pushRevokedReasonSchema,
  type pushTestOutcomeSchema,
  type inboxReadSchema,
} from "../operator/contracts.js";
import { runtimeInboxHeadline } from "../operator/runtime-restart-copy.js";
import {
  encryptPayload,
  endpointDigest,
  fetchPushTransport,
  loadOrCreateVapidKeys,
  PushError,
  pushHostAllowed,
  type PushResponse,
  type PushTransport,
  pushHeaders,
  type ValidatedSubscription,
  type VapidKeys,
  validatePushEndpoint,
  vapidAuthorization,
} from "./web-push.js";

/** The poll interval matches the Inbox page's own read. */
export const PUSH_POLL_INTERVAL_MS = 15_000;
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** At most this many sends run at once across every subscription. */
export const MAX_CONCURRENT_SENDS = 4;
export const MAX_ACTIVE_SUBSCRIPTIONS = 20;
export const MAX_REVOKED_SUBSCRIPTIONS = 20;
export const MAX_PENDING_DELIVERIES = 500;
const RETRY_DELAYS_MS = [30_000, 120_000] as const;
const MAX_RETRY_AFTER_MS = 600_000;
const MAX_INBOX_PAGES = 100;
/** Partial Inbox reads in a row that still end the silent baseline (45 s at the poll interval). */
const MAX_PARTIAL_BASELINE_READS = 3;
const PROJECT_NAME_LIMIT = 64;

export type PushOutcome = z.infer<typeof pushTestOutcomeSchema>;
export type InboxRead = z.infer<typeof inboxReadSchema>;
export type PushPayload = { v: 1; title: string; url: string; tag: string };

/** The one plaintext a push carries: a title, an Inbox link and the alert key; no task content. */
export function pushPayload(
  item: InboxItem,
  items: readonly InboxItem[],
): PushPayload {
  const tag = inboxAlertKey(item);
  switch (item.kind) {
    case "question":
    case "approval":
    case "intervention": {
      const project =
        [
          ...(item.projectName ?? "").replace(
            /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
            " ",
          ),
        ]
          .slice(0, PROJECT_NAME_LIMIT)
          .join("")
          .trim() || "a project";
      const waiting = items.filter(
        (other) =>
          other.kind !== "runtime" && other.projectId === item.projectId,
      ).length;
      return {
        v: 1,
        title: `${kindLabels[item.kind]} in ${project}: ${waiting} waiting`,
        url: inboxSelectionHref(item),
        tag,
      };
    }
    case "runtime":
      return {
        v: 1,
        title: runtimeInboxHeadline(item.harness),
        url: inboxSelectionHref(item),
        tag,
      };
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

const rowSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    serviceHost: z.string(),
    endpoint: z.string().nullable(),
    p256dh: z.string().nullable(),
    auth: z.string().nullable(),
    endpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
    vapidKeyId: z.string(),
    createdAt: z.number().int(),
    lastSuccessAt: z.number().int().nullable(),
    lastFailure: pushFailureSchema.nullable(),
    revokedAt: z.number().int().nullable(),
    revokedReason: pushRevokedReasonSchema.nullable(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** Metadata only; the endpoint and its keys never leave the store through this projection. */
function metadata(row: Row): PushSubscriptionRecord {
  return {
    id: row.id,
    label: row.label,
    serviceHost: row.serviceHost,
    endpointDigest: row.endpointDigest,
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailure: row.lastFailure,
    state: row.revokedAt === null ? "active" : "revoked",
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  };
}

/** Browser push subscriptions and the ledger of alerts already pushed. */
export class OperatorPushStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_push_subscriptions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        serviceHost TEXT NOT NULL,
        endpoint TEXT,
        p256dh TEXT,
        auth TEXT,
        endpointDigest TEXT NOT NULL,
        vapidKeyId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        lastSuccessAt INTEGER,
        lastFailure TEXT,
        revokedAt INTEGER,
        revokedReason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS operator_push_active_endpoint
        ON operator_push_subscriptions(endpointDigest) WHERE revokedAt IS NULL;
      CREATE TABLE IF NOT EXISTS operator_push_alerts (
        key TEXT PRIMARY KEY CHECK(length(key) <= 256)
      );
      CREATE TABLE IF NOT EXISTS operator_push_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        baselined INTEGER NOT NULL,
        partialReads INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO operator_push_state(singleton, baselined) VALUES (1, 0);
    `);
  }

  /** Active rows first, oldest first, then the revoked rows, newest first. */
  list(): PushSubscriptionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM operator_push_subscriptions")
      .all()
      .map((row) => rowSchema.parse({ ...(row as object) }));
    const active = rows
      .filter((row) => row.revokedAt === null)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const revoked = rows
      .filter((row) => row.revokedAt !== null)
      .sort(
        (a, b) =>
          (b.revokedAt ?? 0) - (a.revokedAt ?? 0) || a.id.localeCompare(b.id),
      );
    return [...active, ...revoked].map(metadata);
  }

  activeIds(): string[] {
    return this.db
      .prepare(
        "SELECT id FROM operator_push_subscriptions WHERE revokedAt IS NULL ORDER BY createdAt, id",
      )
      .all()
      .map(
        (row) => z.object({ id: z.string() }).parse({ ...(row as object) }).id,
      );
  }

  get(id: string): PushSubscriptionRecord | undefined {
    const row = this.row(id);
    return row && metadata(row);
  }

  /** The endpoint and keys of an active row; undefined once it is revoked. */
  target(id: string): PushTarget | undefined {
    const row = this.row(id);
    return row &&
      row.revokedAt === null &&
      row.endpoint &&
      row.p256dh &&
      row.auth
      ? { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }
      : undefined;
  }

  /** The same endpoint again replaces its active row; a 21st active device is a conflict. */
  subscribe(
    input: ValidatedSubscription,
    keyId: string,
    now: number,
  ): PushSubscriptionRecord {
    return transaction(this.db, () => {
      const digest = endpointDigest(input.endpoint);
      const existing = this.db
        .prepare(
          "SELECT id FROM operator_push_subscriptions WHERE endpointDigest = ? AND revokedAt IS NULL",
        )
        .get(digest) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            "UPDATE operator_push_subscriptions SET label = ?, serviceHost = ?, endpoint = ?, p256dh = ?, auth = ?, vapidKeyId = ?, createdAt = ?, lastSuccessAt = NULL, lastFailure = NULL WHERE id = ?",
          )
          .run(
            input.label,
            input.host,
            input.endpoint,
            input.p256dh,
            input.auth,
            keyId,
            now,
            existing.id,
          );
        return metadata(this.row(existing.id) as Row);
      }
      const active = this.activeIds().length;
      if (active >= MAX_ACTIVE_SUBSCRIPTIONS) throw new PushError("conflict");
      // The first device starts a fresh baseline: what the Inbox holds now is never a burst.
      if (active === 0) this.resetLedger();
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO operator_push_subscriptions (id, label, serviceHost, endpoint, p256dh, auth, endpointDigest, vapidKeyId, createdAt, lastSuccessAt, lastFailure, revokedAt, revokedReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
        )
        .run(
          id,
          input.label,
          input.host,
          input.endpoint,
          input.p256dh,
          input.auth,
          digest,
          keyId,
          now,
        );
      return metadata(this.row(id) as Row);
    });
  }

  /** Clears the endpoint and keys. Idempotent: revoking a revoked row changes nothing. */
  revoke(
    id: string,
    reason: z.infer<typeof pushRevokedReasonSchema>,
    now: number,
  ): PushSubscriptionRecord {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) throw new PushError("not-found");
      if (row.revokedAt !== null) return metadata(row);
      this.db
        .prepare(
          "UPDATE operator_push_subscriptions SET revokedAt = ?, revokedReason = ?, endpoint = NULL, p256dh = NULL, auth = NULL WHERE id = ?",
        )
        .run(now, reason, id);
      if (this.activeIds().length === 0) this.resetLedger();
      const revoked = metadata(this.row(id) as Row);
      this.db
        .prepare(
          `DELETE FROM operator_push_subscriptions WHERE revokedAt IS NOT NULL AND id NOT IN (
             SELECT id FROM operator_push_subscriptions WHERE revokedAt IS NOT NULL
             ORDER BY revokedAt DESC, id DESC LIMIT ${MAX_REVOKED_SUBSCRIPTIONS})`,
        )
        .run();
      return revoked;
    });
  }

  /** Subscriptions made under another VAPID key can never be sent to, so they are revoked. */
  revokeOtherKeys(keyId: string, now: number): void {
    const stale = this.db
      .prepare(
        "SELECT id FROM operator_push_subscriptions WHERE revokedAt IS NULL AND vapidKeyId != ?",
      )
      .all(keyId)
      .map(
        (row) => z.object({ id: z.string() }).parse({ ...(row as object) }).id,
      );
    for (const id of stale) this.revoke(id, "key-changed", now);
  }

  recordSuccess(id: string, now: number): void {
    this.db
      .prepare(
        "UPDATE operator_push_subscriptions SET lastSuccessAt = ?, lastFailure = NULL WHERE id = ? AND revokedAt IS NULL",
      )
      .run(now, id);
  }

  recordFailure(id: string, failure: z.infer<typeof pushFailureSchema>): void {
    this.db
      .prepare(
        "UPDATE operator_push_subscriptions SET lastFailure = ? WHERE id = ? AND revokedAt IS NULL",
      )
      .run(failure, id);
  }

  /**
   * Folds one read of the Inbox into the ledger and returns the alert keys that are new. The
   * first read after the first device subscribes only records. A key leaves the ledger only when
   * a complete read no longer holds it. Committed before any send: a crash loses a push rather
   * than repeating it.
   */
  applyRead(current: readonly string[], complete: boolean): string[] {
    return transaction(this.db, () => {
      if (this.activeIds().length === 0) return [];
      const known = new Set(
        this.db
          .prepare("SELECT key FROM operator_push_alerts")
          .all()
          .map(
            (row) =>
              z.object({ key: z.string() }).parse({ ...(row as object) }).key,
          ),
      );
      const state = z
        .object({ baselined: z.number(), partialReads: z.number() })
        .parse({
          ...(this.db
            .prepare("SELECT baselined, partialReads FROM operator_push_state")
            .get() as object),
        });
      const baselined = state.baselined === 1;
      const fresh = [...new Set(current)].filter((key) => !known.has(key));
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO operator_push_alerts(key) VALUES (?)",
      );
      for (const key of fresh) insert.run(key);
      // A partial first read records what it saw without ending the baseline, so a task it could
      // not read is not announced later. shortcut: after MAX_PARTIAL_BASELINE_READS partial reads
      // in a row the baseline ends anyway, so a task that never reads cannot silence every alert.
      if (!baselined) {
        const partial = complete ? 0 : state.partialReads + 1;
        const ends = complete || partial >= MAX_PARTIAL_BASELINE_READS;
        this.db
          .prepare(
            "UPDATE operator_push_state SET baselined = ?, partialReads = ?",
          )
          .run(ends ? 1 : 0, partial);
        return [];
      }
      if (complete) {
        const present = new Set(current);
        const drop = this.db.prepare(
          "DELETE FROM operator_push_alerts WHERE key = ?",
        );
        for (const key of known) if (!present.has(key)) drop.run(key);
      }
      return fresh;
    });
  }

  private resetLedger(): void {
    this.db.exec(
      "DELETE FROM operator_push_alerts; UPDATE operator_push_state SET baselined = 0, partialReads = 0",
    );
  }

  private row(id: string): Row | undefined {
    const row = this.db
      .prepare("SELECT * FROM operator_push_subscriptions WHERE id = ?")
      .get(id);
    return row ? rowSchema.parse({ ...(row as object) }) : undefined;
  }
}

/** Timers and time, injectable so tests move neither with the wall clock. */
export type PushClock = {
  now(): number;
  setTimer(action: () => void, delayMs: number): () => void;
};
export const systemPushClock: PushClock = {
  now: () => Date.now(),
  setTimer(action, delayMs) {
    const timer = setTimeout(action, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export type OperatorPushOptions = {
  store: OperatorPushStore;
  /** The owner-only VAPID key file beside the operator auth file. */
  keyFile: string;
  /** The unfiltered Inbox read: no `project` and no `kind`, so runtime items are included. */
  readInbox: (query: URLSearchParams) => Promise<InboxRead>;
  transport?: PushTransport;
  clock?: PushClock;
  /** Null leaves ticking to the caller, for tests. */
  intervalMs?: number | null;
  timeoutMs?: number;
};

type Delivery = {
  subscriptionId: string;
  plaintext: string;
  attempt: number;
  /** A one-off send (the test notification): no retry, and the caller awaits its outcome. */
  done?: (outcome: PushOutcome) => void;
};

/**
 * Opt-in Web Push for the operator. Watches the derived Inbox, never stores it: each alert key
 * is pushed once to every active subscription, and the Inbox stays the source of truth.
 */
export class OperatorPush {
  private readonly store: OperatorPushStore;
  private readonly readInbox: OperatorPushOptions["readInbox"];
  private readonly transport: PushTransport;
  private readonly clock: PushClock;
  private readonly intervalMs: number | null;
  private readonly timeoutMs: number;
  private readonly queue: Delivery[] = [];
  private readonly retries = new Set<() => void>();
  private readonly running = new Set<Promise<void>>();
  private readonly aborts = new Set<AbortController>();
  private ticking: Promise<void> | undefined;
  private cancelNext: (() => void) | undefined;
  private stopped = false;
  private started = false;

  private constructor(
    options: OperatorPushOptions,
    private readonly keys: VapidKeys | undefined,
  ) {
    this.store = options.store;
    this.readInbox = options.readInbox;
    this.transport = options.transport ?? fetchPushTransport();
    this.clock = options.clock ?? systemPushClock;
    this.intervalMs =
      options.intervalMs === undefined
        ? PUSH_POLL_INTERVAL_MS
        : options.intervalMs;
    this.timeoutMs = options.timeoutMs ?? PUSH_SEND_TIMEOUT_MS;
  }

  /** An unusable key file leaves push unavailable and everything else running. */
  static async open(options: OperatorPushOptions): Promise<OperatorPush> {
    let keys: VapidKeys | undefined;
    try {
      keys = await loadOrCreateVapidKeys(options.keyFile);
      options.store.revokeOtherKeys(
        keys.keyId,
        (options.clock ?? systemPushClock).now(),
      );
    } catch {
      keys = undefined;
    }
    return new OperatorPush(options, keys);
  }

  read() {
    return {
      available: this.keys !== undefined,
      publicKey: this.keys?.publicKey ?? null,
      subscriptions: this.store.list(),
    };
  }

  subscribe(input: unknown): PushSubscriptionRecord {
    if (!this.keys) throw new PushError("unavailable");
    return this.store.subscribe(
      validatePushEndpoint(input),
      this.keys.keyId,
      this.clock.now(),
    );
  }

  revoke(id: string): PushSubscriptionRecord {
    return this.store.revoke(id, "operator", this.clock.now());
  }

  /** One test push with no retry. A 404 or 410 revokes the row like any other push. */
  async test(id: string): Promise<PushOutcome> {
    if (!this.keys) throw new PushError("unavailable");
    const row = this.store.get(id);
    if (!row) throw new PushError("not-found");
    if (row.state !== "active") throw new PushError("conflict");
    return new Promise<PushOutcome>((resolve) =>
      this.enqueue({
        subscriptionId: id,
        plaintext: JSON.stringify({
          v: 1,
          title: "Test notification from Ensemble",
          url: "/app/settings#notifications",
          tag: "test:notification",
        } satisfies PushPayload),
        attempt: 1,
        done: resolve,
      }),
    );
  }

  start(): void {
    if (this.started || this.stopped || this.intervalMs === null) return;
    this.started = true;
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelNext?.();
    this.cancelNext = undefined;
    for (const cancel of [...this.retries]) cancel();
    this.retries.clear();
    for (const delivery of this.queue.splice(0)) delivery.done?.("unavailable");
    for (const controller of this.aborts) controller.abort();
    await this.ticking;
    await this.settle();
  }

  /** Resolves once every queued and running send has finished; scheduled retries are not waited for. */
  async settle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** One poll of the Inbox. Never overlaps itself and never throws. */
  tick(): Promise<void> {
    if (this.stopped || !this.keys) return Promise.resolve();
    this.ticking ??= this.runTick()
      .catch(() => undefined)
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private scheduleTick(): void {
    if (this.stopped || this.intervalMs === null) return;
    this.cancelNext = this.clock.setTimer(() => {
      this.cancelNext = undefined;
      void this.tick().finally(() => this.scheduleTick());
    }, this.intervalMs);
  }

  private async runTick(): Promise<void> {
    // No device, no reads: a ledger left from a former device is cleared when it is revoked.
    if (this.store.activeIds().length === 0) return;
    const read = await this.readAll();
    const byKey = new Map<string, InboxItem>();
    for (const item of read.items) byKey.set(inboxAlertKey(item), item);
    // Alerts are only recorded when they can still be sent: a stop in mid-read drops nothing.
    if (this.stopped) return;
    const fresh = this.store.applyRead([...byKey.keys()], read.complete);
    if (!fresh.length) return;
    const devices = this.store.activeIds();
    for (const key of fresh) {
      const item = byKey.get(key);
      if (!item) continue;
      const plaintext = JSON.stringify(pushPayload(item, read.items));
      for (const subscriptionId of devices)
        this.enqueue({ subscriptionId, plaintext, attempt: 1 });
    }
  }

  /** Pages through the whole Inbox; a failed page fails the tick with no change. */
  private async readAll() {
    const items: InboxItem[] = [];
    let unavailable = false;
    let query = new URLSearchParams();
    for (let page = 0; page < MAX_INBOX_PAGES; page++) {
      const { data } = await this.readInbox(query);
      items.push(...data.items);
      unavailable ||= data.unavailable;
      if (!data.nextCursor) return { items, complete: !unavailable };
      query = new URLSearchParams({ cursor: data.nextCursor });
    }
    return { items, complete: false };
  }

  private enqueue(delivery: Delivery): void {
    if (this.stopped) {
      delivery.done?.("unavailable");
      return;
    }
    if (this.queue.length + this.retries.size >= MAX_PENDING_DELIVERIES) {
      // The oldest waiting push is dropped; the Inbox still holds what it announced.
      const dropped = this.queue.shift() ?? delivery;
      this.store.recordFailure(dropped.subscriptionId, "unavailable");
      dropped.done?.("unavailable");
      if (dropped === delivery) return;
    }
    this.queue.push(delivery);
    this.pump();
  }

  private pump(): void {
    while (
      !this.stopped &&
      this.running.size < MAX_CONCURRENT_SENDS &&
      this.queue.length
    ) {
      const delivery = this.queue.shift() as Delivery;
      const run: Promise<void> = this.attempt(delivery)
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(run);
          this.pump();
        });
      this.running.add(run);
    }
  }

  private async attempt(delivery: Delivery): Promise<void> {
    const keys = this.keys;
    const target = this.store.target(delivery.subscriptionId);
    // A stored endpoint is checked again at send time, so a changed database cannot widen it.
    if (
      target &&
      !(
        URL.canParse(target.endpoint) &&
        pushHostAllowed(new URL(target.endpoint).hostname)
      )
    ) {
      this.store.recordFailure(delivery.subscriptionId, "rejected");
      delivery.done?.("rejected");
      return;
    }
    if (!keys || !target) {
      delivery.done?.("gone");
      return;
    }
    const controller = new AbortController();
    this.aborts.add(controller);
    let cancelTimeout = () => {};
    let timedOut = false;
    let response: PushResponse;
    try {
      const request = {
        endpoint: target.endpoint,
        headers: pushHeaders(
          vapidAuthorization(target.endpoint, keys, this.clock.now()),
        ),
        body: encryptPayload(target, delivery.plaintext),
      };
      // The timer and a stop both abort; a transport that ignores the signal cannot hold either up.
      const aborted = new Promise<PushResponse>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => resolve({ failure: timedOut ? "timeout" : "unavailable" }),
          { once: true },
        );
        cancelTimeout = this.clock.setTimer(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);
      });
      response = await Promise.race([
        // A transport that throws (its message can carry the endpoint) is just unavailable.
        this.transport(request, controller.signal).catch(
          (): PushResponse => ({ failure: "unavailable" }),
        ),
        aborted,
      ]);
    } catch {
      response = { status: 400 };
    } finally {
      cancelTimeout();
      this.aborts.delete(controller);
    }
    if (this.stopped) {
      delivery.done?.("unavailable");
      return;
    }
    this.settleAttempt(delivery, response);
  }

  private settleAttempt(delivery: Delivery, response: PushResponse): void {
    const id = delivery.subscriptionId;
    const finish = (outcome: PushOutcome) => delivery.done?.(outcome);
    if ("status" in response) {
      const { status } = response;
      if (status >= 200 && status < 300) {
        this.store.recordSuccess(id, this.clock.now());
        finish("sent");
        return;
      }
      if (status === 404 || status === 410) {
        this.store.revoke(id, "gone", this.clock.now());
        finish("gone");
        return;
      }
      if (status !== 429 && status < 500) {
        // A rejected request is not a reason to drop a device: a bad token would wipe them all.
        this.store.recordFailure(id, "rejected");
        finish("rejected");
        return;
      }
    }
    const failure = "failure" in response ? response.failure : "unavailable";
    const delay = RETRY_DELAYS_MS[delivery.attempt - 1];
    if (delivery.done || delay === undefined || this.stopped) {
      this.store.recordFailure(id, failure);
      finish(failure);
      return;
    }
    const retryAfter =
      "retryAfterSeconds" in response && response.retryAfterSeconds
        ? response.retryAfterSeconds * 1000
        : 0;
    const wait = Math.min(Math.max(delay, retryAfter), MAX_RETRY_AFTER_MS);
    const cancel = this.clock.setTimer(() => {
      this.retries.delete(cancel);
      this.enqueue({ ...delivery, attempt: delivery.attempt + 1 });
    }, wait);
    this.retries.add(cancel);
  }
}
