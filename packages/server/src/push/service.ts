import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { localize, type Localized } from "@gamehearth/sdk/platform";
import { transaction } from "../db";
import { defaultUiLanguage, isUiLanguage, type UiLanguage } from "../languages";
import { decodeAuthSecret, decodePublicKey, encryptPayload, generateVapidKeys, vapidAuthorization, type VapidKeys } from "./webpush";

export type PushErrorCode = "bad-subscription" | "push-host-not-allowed" | "push-off" | "rate-limited" | "invalid-language";

export class PushError extends Error {
  readonly code: PushErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: PushErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type PushKind = "turn" | "finished" | "test";

export interface PushMessage {
  kind: PushKind;
  room?: string;
  game?: Localized;
  languages?: readonly string[];
}

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
}

export interface PushResponse {
  status: number;
  retryAfter?: string | null;
}

export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

export interface PushLimits {
  maxPerUser: number;
  timeoutMs: number;
  concurrency: number;
  queueSize: number;
  ttlSeconds: number;
  coalesceMs: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  failuresBeforeRemoval: number;
  failingMsBeforeRemoval: number;
  testIntervalMs: number;
  maxEndpointLength: number;
}

export const defaultPushLimits: PushLimits = {
  maxPerUser: 10,
  timeoutMs: 10_000,
  concurrency: 8,
  queueSize: 1000,
  ttlSeconds: 12 * 60 * 60,
  coalesceMs: 30_000,
  retryDelayMs: 30_000,
  maxRetryDelayMs: 5 * 60_000,
  failuresBeforeRemoval: 5,
  failingMsBeforeRemoval: 24 * 60 * 60 * 1000,
  testIntervalMs: 60_000,
  maxEndpointLength: 2000,
};

export const defaultPushHosts: readonly string[] = ["fcm.googleapis.com", "*.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];

export interface PushOptions {
  contact?: string | undefined;
  hosts?: readonly string[];
  clock?: () => number;
  log?: (message: string) => void;
  transport?: PushTransport;
  limits?: Partial<PushLimits>;
}

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string;
  failures: number;
  failing_since: number | null;
}

interface LanguageRow {
  id: number;
  device_language: string | null;
  user_language: string | null;
}

interface Job {
  subscription: number;
  payload: string;
  topic: string;
  urgency: "high" | "normal";
  attempt: number;
  due?: () => boolean;
  slot?: { key: string; seq: number };
}

interface Pending {
  message: PushMessage;
  due: () => boolean;
}

interface Slot {
  last: number;
  seq: number;
  pending?: Pending | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

const vapidSetting = "vapid";
const topicSetting = "push-topic";
const fallbackContact = "mailto:gamehearth@invalid";
const maxGameNameLength = 80;
const tokenReuseMs = 60 * 60 * 1000;

export const fetchTransport: PushTransport = async (request) => {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, retryAfter: response.headers.get("retry-after") };
};

export function validPushHost(entry: string): boolean {
  if (/^https?:\/\//.test(entry)) {
    try {
      const url = new URL(entry);
      return url.origin === entry.replace(/\/$/, "") && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }
  return /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(entry);
}

export function validContact(value: string): boolean {
  return /^mailto:[^\s@]+@[^\s@]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value);
}

export function hostAllowed(endpoint: URL, hosts: readonly string[]): boolean {
  if (endpoint.username !== "" || endpoint.password !== "") {
    return false;
  }
  const host = endpoint.hostname.toLowerCase();
  return hosts.some((entry) => {
    if (/^https?:\/\//.test(entry)) {
      return endpoint.origin === entry.replace(/\/$/, "").toLowerCase();
    }
    if (endpoint.protocol !== "https:" || endpoint.port !== "") {
      return false;
    }
    const pattern = entry.toLowerCase();
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;
  });
}

export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function pushLanguage(userLanguage: string | null, deviceLanguage: string | null): UiLanguage {
  return isUiLanguage(userLanguage) ? userLanguage : isUiLanguage(deviceLanguage) ? deviceLanguage : defaultUiLanguage;
}

function payloadFor(message: PushMessage, row: LanguageRow): string {
  const lang = pushLanguage(row.user_language, row.device_language);
  return JSON.stringify({
    kind: message.kind,
    ...(message.room === undefined ? {} : { room: message.room }),
    ...(message.game === undefined ? {} : { game: localize(message.game, lang, message.languages ?? []).slice(0, maxGameNameLength) }),
    lang,
  });
}

export function topicFor(secret: Buffer, subscription: number, room: string): string {
  return createHmac("sha256", secret).update(`${subscription}:${room}`).digest("base64url").slice(0, 32);
}

export class PushService {
  readonly #db: DatabaseSync;
  readonly #keys: VapidKeys;
  readonly #topicSecret: Buffer;
  readonly #tokens = new Map<string, { header: string; createdAt: number }>();
  readonly #contact: string | undefined;
  readonly #hosts: readonly string[];
  readonly #clock: () => number;
  readonly #log: (message: string) => void;
  readonly #transport: PushTransport;
  readonly #limits: PushLimits;
  readonly #queue: Job[] = [];
  readonly #slots = new Map<string, Slot>();
  readonly #tests = new Map<number, number>();
  readonly #retries = new Set<ReturnType<typeof setTimeout>>();
  readonly #idle: (() => void)[] = [];
  #active = 0;
  #seq = 0;
  #droppedAt = -Infinity;
  #closed = false;

  constructor(db: DatabaseSync, options: PushOptions = {}) {
    this.#db = db;
    this.#contact = options.contact;
    this.#hosts = [...defaultPushHosts, ...(options.hosts ?? [])];
    this.#clock = options.clock ?? Date.now;
    this.#log = options.log ?? console.error;
    this.#transport = options.transport ?? fetchTransport;
    this.#limits = { ...defaultPushLimits, ...options.limits };
    this.#keys = this.#loadKeys();
    this.#topicSecret = this.#loadTopicSecret();
  }

  publicKey(): string {
    return this.#keys.publicKey;
  }

  subscribe(sessionId: number, input: unknown, origin: string, language?: unknown): void {
    const subscription = this.#parse(input);
    if (language !== undefined && language !== null && !isUiLanguage(language)) {
      throw new PushError("invalid-language", 'language must be the language of the UI on this device, "en" or "de"');
    }
    const now = this.#clock();
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM push_subscriptions WHERE session_id = ? OR endpoint = ?").run(sessionId, subscription.endpoint);
      this.#db
        .prepare("INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth, origin, created_at, language) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, subscription.endpoint, subscription.p256dh, subscription.auth, origin, now, language ?? null);
      const surplus = this.#db
        .prepare(
          `SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id
           WHERE s.user_id = (SELECT user_id FROM sessions WHERE id = ?) ORDER BY p.created_at DESC, p.id DESC LIMIT -1 OFFSET ?`,
        )
        .all(sessionId, this.#limits.maxPerUser) as unknown as { id: number }[];
      for (const row of surplus) {
        this.#db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
      }
    });
  }

  renew(sessionId: number, oldEndpoint: unknown, input: unknown): boolean {
    if (typeof oldEndpoint !== "string" || oldEndpoint.length > this.#limits.maxEndpointLength) {
      throw new PushError("bad-subscription", "oldEndpoint is missing or too long");
    }
    const subscription = this.#parse(input);
    return transaction(this.#db, () => {
      const row = this.#db.prepare("SELECT id FROM push_subscriptions WHERE session_id = ? AND endpoint = ?").get(sessionId, oldEndpoint) as
        | { id: number }
        | undefined;
      if (row === undefined) {
        return false;
      }
      this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND id != ?").run(subscription.endpoint, row.id);
      this.#db
        .prepare("UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, failures = 0, failing_since = NULL WHERE id = ?")
        .run(subscription.endpoint, subscription.p256dh, subscription.auth, row.id);
      return true;
    });
  }

  unsubscribe(sessionId: number): void {
    this.#db.prepare("DELETE FROM push_subscriptions WHERE session_id = ?").run(sessionId);
  }

  enabled(sessionId: number): boolean {
    return this.#db.prepare("SELECT 1 FROM push_subscriptions WHERE session_id = ?").get(sessionId) !== undefined;
  }

  sessionsWithPush(userId: number): Set<number> {
    const rows = this.#db
      .prepare("SELECT p.session_id FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id WHERE s.user_id = ?")
      .all(userId) as unknown as { session_id: number }[];
    return new Set(rows.map((row) => row.session_id));
  }

  count(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number }).count;
  }

  sendTest(sessionId: number): void {
    const row = this.#db
      .prepare(
        `SELECT p.id, p.language AS device_language, u.language AS user_language FROM push_subscriptions p
         JOIN sessions s ON s.id = p.session_id JOIN users u ON u.id = s.user_id WHERE p.session_id = ?`,
      )
      .get(sessionId) as LanguageRow | undefined;
    if (row === undefined) {
      throw new PushError("push-off", "Notifications are not turned on on this device");
    }
    const now = this.#clock();
    const last = this.#tests.get(sessionId);
    if (last !== undefined && now - last < this.#limits.testIntervalMs) {
      throw new PushError("rate-limited", "One test message per minute is enough", this.#limits.testIntervalMs - (now - last));
    }
    this.#tests.set(sessionId, now);
    if (this.#tests.size > 10_000) {
      this.#tests.clear();
    }
    this.#enqueue({ subscription: row.id, payload: payloadFor({ kind: "test" }, row), topic: "test", urgency: "normal", attempt: 1 });
  }

  notify(userId: number, room: string, message: PushMessage, due: () => boolean): void {
    if (this.#closed) {
      return;
    }
    const key = `${userId}:${room}`;
    const now = this.#clock();
    const slot = this.#slots.get(key);
    if (slot === undefined || (slot.timer === undefined && now - slot.last >= this.#limits.coalesceMs)) {
      if (this.#dispatch(key, userId, room, { message, due })) {
        this.#sweepSlots(now);
      }
      return;
    }
    slot.pending = { message, due };
    if (slot.timer === undefined) {
      slot.timer = setTimeout(() => this.#fire(key, userId, room), Math.max(0, slot.last + this.#limits.coalesceMs - now));
      slot.timer.unref?.();
    }
  }

  idle(): Promise<void> {
    if (this.#queue.length === 0 && this.#active === 0 && this.#retries.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) {
      if (slot.timer !== undefined) {
        clearTimeout(slot.timer);
      }
    }
    this.#slots.clear();
    for (const timer of this.#retries) {
      clearTimeout(timer);
    }
    this.#retries.clear();
    this.#queue.length = 0;
    for (const resolve of this.#idle.splice(0)) {
      resolve();
    }
  }

  #fire(key: string, userId: number, room: string): void {
    const slot = this.#slots.get(key);
    if (slot === undefined) {
      return;
    }
    slot.timer = undefined;
    const pending = slot.pending;
    slot.pending = undefined;
    if (pending !== undefined) {
      this.#dispatch(key, userId, room, pending);
    }
  }

  #dispatch(key: string, userId: number, room: string, pending: Pending): boolean {
    if (!pending.due()) {
      return false;
    }
    const now = this.#clock();
    const rows = this.#db
      .prepare(
        `SELECT p.id, p.language AS device_language, u.language AS user_language FROM push_subscriptions p
         JOIN sessions s ON s.id = p.session_id JOIN users u ON u.id = s.user_id
         WHERE s.user_id = ? AND u.locked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY p.id`,
      )
      .all(userId, now) as unknown as LanguageRow[];
    if (rows.length === 0) {
      return false;
    }
    const seq = ++this.#seq;
    const slot = this.#slots.get(key);
    if (slot === undefined) {
      this.#slots.set(key, { last: now, seq });
    } else {
      slot.last = now;
      slot.seq = seq;
    }
    for (const row of rows) {
      this.#enqueue({
        subscription: row.id,
        payload: payloadFor(pending.message, row),
        topic: topicFor(this.#topicSecret, row.id, room),
        urgency: pending.message.kind === "turn" ? "high" : "normal",
        attempt: 1,
        due: pending.due,
        slot: { key, seq },
      });
    }
    return true;
  }

  #stale(job: Job): boolean {
    if (job.slot !== undefined) {
      const current = this.#slots.get(job.slot.key);
      if (current !== undefined && current.seq !== job.slot.seq) {
        return true;
      }
    }
    return job.due !== undefined && !job.due();
  }

  #authorization(audience: string, subject: string, now: number): string {
    const key = `${audience} ${subject}`;
    const cached = this.#tokens.get(key);
    if (cached !== undefined && now - cached.createdAt < tokenReuseMs && now >= cached.createdAt) {
      return cached.header;
    }
    const header = vapidAuthorization(this.#keys, audience, subject, now + this.#limits.ttlSeconds * 1000);
    if (this.#tokens.size > 100) {
      this.#tokens.clear();
    }
    this.#tokens.set(key, { header, createdAt: now });
    return header;
  }

  #sweepSlots(now: number): void {
    if (this.#slots.size < 1000) {
      return;
    }
    for (const [key, slot] of this.#slots) {
      if (slot.timer === undefined && now - slot.last >= this.#limits.coalesceMs) {
        this.#slots.delete(key);
      }
    }
  }

  #enqueue(job: Job): void {
    if (this.#closed) {
      return;
    }
    if (this.#queue.length >= this.#limits.queueSize) {
      this.#queue.shift();
      const now = this.#clock();
      if (now - this.#droppedAt >= 60_000) {
        this.#droppedAt = now;
        this.#log(`Push queue full (${this.#limits.queueSize}), oldest message dropped`);
      }
    }
    this.#queue.push(job);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#limits.concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift() as Job;
      this.#active++;
      void this.#send(job)
        .catch((error: unknown) => {
          if (!this.#closed) {
            this.#log(`Push sending failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          }
        })
        .finally(() => {
          this.#active--;
          this.#pump();
          this.#settle();
        });
    }
  }

  #settle(): void {
    if (this.#active === 0 && this.#queue.length === 0 && this.#retries.size === 0) {
      for (const resolve of this.#idle.splice(0)) {
        resolve();
      }
    }
  }

  async #send(job: Job): Promise<void> {
    const row = this.#db
      .prepare("SELECT id, endpoint, p256dh, auth, origin, failures, failing_since FROM push_subscriptions WHERE id = ?")
      .get(job.subscription) as SubscriptionRow | undefined;
    if (row === undefined || this.#stale(job)) {
      return;
    }
    const now = this.#clock();
    let request: PushRequest;
    try {
      const endpoint = new URL(row.endpoint);
      const subject = this.#contact ?? (row.origin.startsWith("https://") ? row.origin : fallbackContact);
      request = {
        endpoint: row.endpoint,
        timeoutMs: this.#limits.timeoutMs,
        body: encryptPayload(Buffer.from(job.payload, "utf8"), { p256dh: row.p256dh, auth: row.auth }),
        headers: {
          authorization: this.#authorization(endpoint.origin, subject, now),
          ttl: String(this.#limits.ttlSeconds),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          urgency: job.urgency,
          topic: job.topic,
        },
      };
    } catch (error) {
      this.#log(`Push to ${new URL(row.endpoint).host} dropped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let response: PushResponse | undefined;
    let problem = "";
    try {
      response = await this.#transport(request);
    } catch (error) {
      problem = error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof Error ? error.message : String(error);
    }
    if (this.#closed) {
      return;
    }
    const status = response?.status;
    if (status !== undefined && status >= 200 && status < 300) {
      if (row.failures > 0) {
        this.#db.prepare("UPDATE push_subscriptions SET failures = 0, failing_since = NULL WHERE id = ?").run(row.id);
      }
      return;
    }
    if (status === 404 || status === 410) {
      this.#remove(row.id, `expired (${status})`);
      return;
    }
    const retryable = status === undefined || status === 429 || status >= 500;
    if (retryable && job.attempt === 1 && !this.#closed) {
      const delay = Math.min(parseRetryAfter(response?.retryAfter, this.#clock()) ?? this.#limits.retryDelayMs, this.#limits.maxRetryDelayMs);
      const timer = setTimeout(() => {
        this.#retries.delete(timer);
        this.#enqueue({ ...job, attempt: 2 });
        this.#settle();
      }, delay);
      timer.unref?.();
      this.#retries.add(timer);
      return;
    }
    if (retryable) {
      this.#log(`Push to ${new URL(row.endpoint).host} not delivered: ${status === undefined ? problem : `response ${status}`}`);
      return;
    }
    this.#failed(row, `response ${status}`);
  }

  #failed(row: SubscriptionRow, reason: string): void {
    const now = this.#clock();
    const failures = row.failures + 1;
    const since = row.failing_since ?? now;
    if (failures >= this.#limits.failuresBeforeRemoval && now - since >= this.#limits.failingMsBeforeRemoval) {
      this.#remove(row.id, `failed ${failures} times in a row (${reason})`);
      return;
    }
    this.#db.prepare("UPDATE push_subscriptions SET failures = ?, failing_since = ? WHERE id = ?").run(failures, since, row.id);
    this.#log(`Push to ${new URL(row.endpoint).host} failed: ${reason}`);
  }

  #remove(id: number, reason: string): void {
    const row = this.#db.prepare("SELECT endpoint FROM push_subscriptions WHERE id = ?").get(id) as { endpoint: string } | undefined;
    this.#db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
    if (row !== undefined) {
      this.#log(`Push subscription at ${new URL(row.endpoint).host} removed: ${reason}`);
    }
  }

  #parse(input: unknown): { endpoint: string; p256dh: string; auth: string } {
    const bad = (message: string) => new PushError("bad-subscription", message);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw bad("subscription must be an object with endpoint and keys");
    }
    const value = input as Record<string, unknown>;
    const endpoint = value["endpoint"];
    const keys = value["keys"] as Record<string, unknown> | null | undefined;
    if (typeof endpoint !== "string" || endpoint.length > this.#limits.maxEndpointLength) {
      throw bad("endpoint is missing or too long");
    }
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw bad("endpoint is not a valid address");
    }
    if (!hostAllowed(url, this.#hosts)) {
      throw new PushError("push-host-not-allowed", `Push service ${url.host} is not allowed on this server`);
    }
    if (keys === null || typeof keys !== "object") {
      throw bad("keys is missing");
    }
    const p256dh = keys["p256dh"];
    const auth = keys["auth"];
    if (typeof p256dh !== "string" || decodePublicKey(p256dh) === undefined || typeof auth !== "string" || decodeAuthSecret(auth) === undefined) {
      throw bad("keys.p256dh or keys.auth is invalid");
    }
    return { endpoint, p256dh, auth };
  }

  #loadTopicSecret(): Buffer {
    const read = () => this.#db.prepare("SELECT value FROM settings WHERE name = ?").get(topicSetting) as { value: string } | undefined;
    if (read() === undefined) {
      this.#db.prepare("INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)").run(topicSetting, randomBytes(32).toString("base64url"));
    }
    return Buffer.from((read() as { value: string }).value, "base64url");
  }

  #loadKeys(): VapidKeys {
    const read = () => this.#db.prepare("SELECT value FROM settings WHERE name = ?").get(vapidSetting) as { value: string } | undefined;
    let row = read();
    if (row === undefined) {
      const fresh = generateVapidKeys();
      this.#db.prepare("INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)").run(vapidSetting, JSON.stringify(fresh));
      row = read();
    }
    const parsed = JSON.parse((row as { value: string }).value) as VapidKeys;
    if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string" || decodePublicKey(parsed.publicKey) === undefined) {
      throw new Error("The VAPID key in the database is damaged");
    }
    return parsed;
  }
}
