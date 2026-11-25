import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts";
import { openDatabase } from "../src/db";
import { createHash } from "node:crypto";
import { PushError, PushService, hostAllowed, parseRetryAfter, validContact, validPushHost, type PushLimits, type PushOptions } from "../src/push/service";
import { cheapPasswords } from "./helpers";
import { newSubscriptionKeys, startFakePushService, type FakePushService } from "./fake-push";

const fast: Partial<PushLimits> = { coalesceMs: 300, retryDelayMs: 50, maxRetryDelayMs: 200, timeoutMs: 300, testIntervalMs: 60_000 };

let dir: string;
let db: DatabaseSync;
let accounts: AccountService;
let fake: FakePushService;
let logs: string[];
let services: PushService[];
let dbOpen = false;

function closeDatabase(): void {
  if (dbOpen) {
    dbOpen = false;
    db.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gamehearth-push-"));
  db = openDatabase(join(dir, "test.sqlite"));
  dbOpen = true;
  accounts = new AccountService(db, { passwordCost: cheapPasswords });
  fake = await startFakePushService();
  logs = [];
  services = [];
});

afterEach(async () => {
  for (const service of services) {
    service.close();
  }
  await fake.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

function service(options: PushOptions = {}): PushService {
  const created = new PushService(db, { hosts: [fake.origin], log: (message) => logs.push(message), limits: fast, ...options });
  services.push(created);
  return created;
}

function device(name = "Anna"): { user: number; session: number } {
  const guest = accounts.createGuest(name);
  return { user: guest.id, session: accounts.createSession(guest.id).session.id };
}

function secondDevice(user: number): number {
  return accounts.createSession(user).session.id;
}

const always = () => true;

describe("Keys", () => {
  it("creates the VAPID key once and keeps it across a restart", () => {
    const first = service().publicKey();
    expect(Buffer.from(first, "base64url").length).toBe(65);
    expect(service().publicKey()).toBe(first);
    const row = db.prepare("SELECT value FROM settings WHERE name = 'vapid'").get() as { value: string };
    expect(JSON.parse(row.value)).toMatchObject({ publicKey: first, privateKey: expect.any(String) });
  });
});

describe("Subscriptions", () => {
  it("accepts only addresses of the known services and from PUSH_HOSTS", () => {
    const push = service();
    const { session } = device();
    const { keys } = newSubscriptionKeys();
    const attempt = (endpoint: string) => {
      try {
        push.subscribe(session, { endpoint, keys }, "https://games.example.org");
        return "ok";
      } catch (error) {
        return error instanceof PushError ? error.code : String(error);
      }
    };
    expect(attempt("https://fcm.googleapis.com/fcm/send/abc")).toBe("ok");
    expect(attempt("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe("ok");
    expect(attempt("https://web.push.apple.com/QGx")).toBe("ok");
    expect(attempt("https://wns2-db5p.notify.windows.com/w/?token=abc")).toBe("ok");
    expect(attempt(`${fake.origin}/push/x`)).toBe("ok");
    expect(attempt("http://fcm.googleapis.com/fcm/send/abc")).toBe("push-host-not-allowed");
    expect(attempt("https://fcm.googleapis.com:8443/fcm/send/abc")).toBe("push-host-not-allowed");
    expect(attempt("https://fcm.googleapis.com.evil.example/x")).toBe("push-host-not-allowed");
    expect(attempt("https://evilfcm.googleapis.com/x")).toBe("push-host-not-allowed");
    expect(attempt("https://push.apple.com/x")).toBe("push-host-not-allowed");
    expect(attempt("https://user:pw@fcm.googleapis.com/x")).toBe("push-host-not-allowed");
    expect(attempt("https://192.168.1.1/x")).toBe("push-host-not-allowed");
    expect(attempt("http://127.0.0.1:1/x")).toBe("push-host-not-allowed");
    expect(attempt("http://localhost:8080/api/admin/users")).toBe("push-host-not-allowed");
    expect(attempt("not a url")).toBe("bad-subscription");
    expect(attempt(`https://fcm.googleapis.com/${"x".repeat(2000)}`)).toBe("bad-subscription");
  });

  it("checks the subscription keys", () => {
    const push = service();
    const { session } = device();
    const { keys } = newSubscriptionKeys();
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(() => push.subscribe(session, { endpoint }, "https://x.example")).toThrow(/keys/);
    expect(() => push.subscribe(session, { endpoint, keys: { ...keys, auth: "zu-kurz" } }, "https://x.example")).toThrow(/invalid/);
    expect(() => push.subscribe(session, { endpoint, keys: { ...keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }, "https://x.example")).toThrow(/invalid/);
    expect(() => push.subscribe(session, null, "https://x.example")).toThrow(PushError);
    expect(push.enabled(session)).toBe(false);
  });

  it("keeps one subscription per session and one session per address", () => {
    const push = service();
    const anna = device("Anna");
    const ben = device("Ben");
    const first = fake.subscription();
    const second = fake.subscription();
    push.subscribe(anna.session, first, "https://x.example");
    push.subscribe(anna.session, second, "https://x.example");
    expect(push.count()).toBe(1);
    push.subscribe(ben.session, second, "https://x.example");
    expect(push.enabled(anna.session)).toBe(false);
    expect(push.enabled(ben.session)).toBe(true);
    expect(push.count()).toBe(1);
  });

  it("keeps at most ten subscriptions per user and drops the oldest", () => {
    let now = 1_000;
    const push = service({ clock: () => (now += 1000) });
    const anna = device();
    const sessions = [anna.session, ...Array.from({ length: 10 }, () => secondDevice(anna.user))];
    for (const session of sessions) {
      push.subscribe(session, fake.subscription(), "https://x.example");
    }
    expect(push.count()).toBe(10);
    expect(push.enabled(anna.session)).toBe(false);
    expect(push.enabled(sessions[10] as number)).toBe(true);
    expect(push.sessionsWithPush(anna.user).size).toBe(10);
  });

  it("disappears with the session: sign-out, deletion, lock", () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    accounts.endSession(anna.session);
    expect(push.count()).toBe(0);
    const ben = device("Ben");
    push.subscribe(ben.session, fake.subscription(), "https://x.example");
    accounts.deleteUser(ben.user);
    expect(push.count()).toBe(0);
  });

  it("turns off", () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.unsubscribe(anna.session);
    expect(push.enabled(anna.session)).toBe(false);
  });
});

describe("Sending", () => {
  it("sends encrypted and signed to all of the user's devices, to no one else", async () => {
    const push = service();
    const anna = device("Anna");
    const phone = secondDevice(anna.user);
    const ben = device("Ben");
    push.subscribe(anna.session, fake.subscription("anna-pc"), "https://games.example.org");
    push.subscribe(phone, fake.subscription("anna-handy"), "https://games.example.org");
    push.subscribe(ben.session, fake.subscription("ben"), "https://games.example.org");
    push.notify(anna.user, "ABC234", { kind: "turn", room: "ABC234", game: "Mau-Mau" }, always);
    await push.idle();
    expect(fake.received.map((push) => push.path).sort()).toEqual(["/push/anna-handy", "/push/anna-pc"]);
    for (const received of fake.received) {
      expect(received.problem).toBeUndefined();
      expect(received.payload).toEqual({ kind: "turn", room: "ABC234", game: "Mau-Mau", lang: "en" });
      expect(received.vapid).toMatchObject({ aud: fake.origin, sub: "https://games.example.org", key: push.publicKey() });
      expect(received.headers["ttl"]).toBe("43200");
      expect(received.headers["urgency"]).toBe("high");
      expect(received.headers["topic"]).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(received.headers["topic"]).not.toContain("ABC234");
    }
  });

  it("takes PUSH_CONTACT as sub, a placeholder without an https origin, never a guessed address", async () => {
    const withContact = service({ contact: "mailto:betrieb@example.org" });
    const anna = device();
    withContact.subscribe(anna.session, fake.subscription(), "http://localhost:8080");
    withContact.notify(anna.user, "R1", { kind: "finished", room: "R1", game: "Mau-Mau" }, always);
    await withContact.idle();
    expect(fake.received[0]?.vapid?.sub).toBe("mailto:betrieb@example.org");
    expect(fake.received[0]?.headers["urgency"]).toBe("normal");
    withContact.close();
    const plain = service();
    plain.notify(anna.user, "R2", { kind: "finished", room: "R2", game: "Mau-Mau" }, always);
    await plain.idle();
    expect(fake.received[1]?.vapid?.sub).toBe("mailto:gamehearth@invalid");
  });

  it("merges messages per user and room; the newest wins", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    push.notify(anna.user, "R1", { kind: "finished", room: "R1", game: "G" }, always);
    push.notify(anna.user, "R2", { kind: "turn", room: "R2", game: "G" }, always);
    await push.idle();
    expect(fake.received.map((push) => push.payload)).toEqual([
      { kind: "turn", room: "R1", game: "G", lang: "en" },
      { kind: "turn", room: "R2", game: "G", lang: "en" },
    ]);
    await fake.waitFor(3, 2000);
    expect(fake.received[2]?.payload).toEqual({ kind: "finished", room: "R1", game: "G", lang: "en" });
  });

  it("checks again on delayed sending whether the message is still due", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    let due = true;
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, () => due);
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, () => due);
    due = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await push.idle();
    expect(fake.received).toHaveLength(1);
    push.notify(anna.user, "R3", { kind: "turn", room: "R3", game: "G" }, () => false);
    await push.idle();
    expect(fake.received).toHaveLength(1);
  });

  it("deletes expired subscriptions on 404 and 410", async () => {
    const push = service();
    const anna = device();
    const ben = device("Ben");
    push.subscribe(anna.session, fake.subscription("weg-404"), "https://x.example");
    push.subscribe(ben.session, fake.subscription("weg-410"), "https://x.example");
    fake.respond((request) => ({ status: request.path.endsWith("404") ? 404 : 410 }));
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    push.notify(ben.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await push.idle();
    expect(push.count()).toBe(0);
    expect(logs.filter((line) => line.includes("expired"))).toHaveLength(2);
  });

  it("retries exactly once on 429 and 5xx, after Retry-After", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    let calls = 0;
    fake.respond(() => (++calls === 1 ? { status: 429, headers: { "retry-after": "0" } } : { status: 201 }));
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await fake.waitFor(2);
    expect(calls).toBe(2);
    fake.respond(() => ({ status: 503 }));
    push.notify(anna.user, "R2", { kind: "turn", room: "R2", game: "G" }, always);
    await fake.waitFor(4);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.received).toHaveLength(4);
    expect(logs.some((line) => line.includes("response 503"))).toBe(true);
    expect(push.count()).toBe(1);
  });

  it("waits at most maxRetryDelayMs, even if Retry-After asks for longer", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    let calls = 0;
    fake.respond(() => (++calls === 1 ? { status: 500, headers: { "retry-after": "3600" } } : { status: 201 }));
    const started = Date.now();
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await fake.waitFor(2, 2000);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("aborts slow services after the timeout and tries again", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    fake.respond(() => ({ status: 201, delayMs: 1000 }));
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await fake.waitFor(2, 3000);
    await push.idle();
    expect(logs.some((line) => line.includes("timeout"))).toBe(true);
  });

  it("deletes a subscription only after five failures over at least one day", async () => {
    let now = Date.now();
    const push = service({ clock: () => now });
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    fake.respond(() => ({ status: 403 }));
    for (let round = 0; round < 6; round++) {
      push.notify(anna.user, `R${round}`, { kind: "turn", room: `R${round}`, game: "G" }, always);
      await push.idle();
      expect(push.count()).toBe(1);
      now += 60 * 60 * 1000;
    }
    now += 24 * 60 * 60 * 1000;
    push.notify(anna.user, "R9", { kind: "turn", room: "R9", game: "G" }, always);
    await push.idle();
    expect(push.count()).toBe(0);
    fake.respond(() => undefined);
  });

  it("resets the failure counter after a success", async () => {
    let now = Date.now();
    const push = service({ clock: () => now });
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    fake.respond(() => ({ status: 400 }));
    for (let round = 0; round < 4; round++) {
      push.notify(anna.user, `R${round}`, { kind: "turn", room: `R${round}`, game: "G" }, always);
      await push.idle();
    }
    fake.respond(() => undefined);
    push.notify(anna.user, "OK", { kind: "turn", room: "OK", game: "G" }, always);
    await push.idle();
    const row = db.prepare("SELECT failures, failing_since FROM push_subscriptions").get() as { failures: number; failing_since: number | null };
    expect(row).toEqual({ failures: 0, failing_since: null });
  });

  it("sends at most eight at a time and drops the oldest when the queue is full", async () => {
    const push = service({ limits: { ...fast, queueSize: 5, concurrency: 8 } });
    let inFlight = 0;
    let peak = 0;
    fake.respond(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => inFlight--, 100);
      return { status: 201, delayMs: 100 };
    });
    const users = Array.from({ length: 20 }, (_, index) => device(`U${index}`));
    users.forEach((user, index) => push.subscribe(user.session, fake.subscription(`u${index}`), "https://x.example"));
    for (const user of users) {
      push.notify(user.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    }
    await push.idle();
    expect(peak).toBeLessThanOrEqual(8);
    const arrived = fake.received.map((push) => Number(push.path.replace("/push/u", ""))).sort((a, b) => a - b);
    expect(arrived).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 18, 19]);
    expect(logs.filter((line) => line.includes("queue full"))).toHaveLength(1);
  });

  it("sends a test message at most once a minute and only with a subscription", async () => {
    let now = Date.now();
    const push = service({ clock: () => now });
    const anna = device();
    expect(() => push.sendTest(anna.session)).toThrow(expect.objectContaining({ code: "push-off" }));
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.sendTest(anna.session);
    expect(() => push.sendTest(anna.session)).toThrow(expect.objectContaining({ code: "rate-limited" }));
    now += 60_000;
    push.sendTest(anna.session);
    await push.idle();
    expect(fake.received.map((push) => push.payload)).toEqual([{ kind: "test", lang: "en" }, { kind: "test", lang: "en" }]);
  });

  it("sends nothing to subscriptions whose session ends between request and sending", async () => {
    const push = service({ limits: { ...fast, concurrency: 1 } });
    const anna = device();
    const ben = device("Ben");
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.subscribe(ben.session, fake.subscription(), "https://x.example");
    fake.respond(() => ({ status: 201, delayMs: 50 }));
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    push.notify(ben.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    accounts.endSession(ben.session);
    await push.idle();
    expect(fake.received).toHaveLength(1);
  });
});

describe("Review", () => {
  it("does not send a retry when it is no longer due or something newer already went out", async () => {
    const push = service({ limits: { ...fast, retryDelayMs: 600, maxRetryDelayMs: 600 } });
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    let calls = 0;
    fake.respond(() => (++calls === 1 ? { status: 503 } : { status: 201 }));
    let turnDue = true;
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, () => turnDue);
    await fake.waitFor(1);
    turnDue = false;
    push.notify(anna.user, "R1", { kind: "finished", room: "R1", game: "G" }, always);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await push.idle();
    expect(fake.received.map((push) => (push.payload as { kind: string }).kind)).toEqual(["turn", "finished"]);
  });

  it("drops the retry when its reason is gone in the meantime", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    let calls = 0;
    fake.respond(() => (++calls === 1 ? { status: 503 } : { status: 201 }));
    let due = true;
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, () => due);
    await fake.waitFor(1);
    due = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await push.idle();
    expect(fake.received).toHaveLength(1);
  });

  it("gives each subscription its own topic per room that cannot be computed from the room code without the secret", async () => {
    const push = service();
    const anna = device("Anna");
    const ben = device("Ben");
    push.subscribe(anna.session, fake.subscription("anna"), "https://x.example");
    push.subscribe(ben.session, fake.subscription("ben"), "https://x.example");
    for (const room of ["R1", "R2"]) {
      push.notify(anna.user, room, { kind: "turn", room, game: "G" }, always);
      push.notify(ben.user, room, { kind: "turn", room, game: "G" }, always);
    }
    await push.idle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    push.notify(anna.user, "R1", { kind: "finished", room: "R1", game: "G" }, always);
    await push.idle();
    const topic = (path: string, room: string, index = 0) =>
      fake.received.filter((push) => push.path === path && (push.payload as { room: string }).room === room)[index]?.headers["topic"];
    const plain = (room: string) => createHash("sha256").update(`gamehearth-room:${room}`).digest("base64url").slice(0, 32);
    expect(topic("/push/anna", "R1")).not.toBe(topic("/push/ben", "R1"));
    expect(topic("/push/anna", "R1")).not.toBe(topic("/push/anna", "R2"));
    expect(topic("/push/anna", "R1", 1)).toBe(topic("/push/anna", "R1"));
    expect(topic("/push/anna", "R1")).not.toBe(plain("R1"));
    for (const received of fake.received) {
      expect(received.headers["topic"]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("does not delete subscriptions when the server itself has no network or the service is down", async () => {
    let now = Date.now();
    let mode: "throw" | "503" = "throw";
    const push = service({
      clock: () => now,
      transport: async () => {
        if (mode === "throw") {
          throw new Error("getaddrinfo EAI_AGAIN fcm.googleapis.com");
        }
        return { status: 503 };
      },
    });
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    for (const next of ["throw", "503"] as const) {
      mode = next;
      for (let round = 0; round < 6; round++) {
        push.notify(anna.user, `${next}${round}`, { kind: "turn", room: `${next}${round}`, game: "G" }, always);
        await push.idle();
        now += 5 * 60 * 60 * 1000;
      }
    }
    expect(push.count()).toBe(1);
  });

  it("shortens a long game name and keeps the subscription", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "x".repeat(4000) }, always);
    await push.idle();
    expect(push.count()).toBe(1);
    expect(((fake.received[0]?.payload as { game: string }).game ?? "").length).toBe(80);
  });

  it("reuses the VAPID JWT per service for one hour", async () => {
    let now = Date.now();
    const push = service({ clock: () => now });
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await push.idle();
    now += 30 * 60 * 1000;
    push.notify(anna.user, "R2", { kind: "turn", room: "R2", game: "G" }, always);
    await push.idle();
    now += 31 * 60 * 1000;
    push.notify(anna.user, "R3", { kind: "turn", room: "R3", game: "G" }, always);
    await push.idle();
    const headers = fake.received.map((push) => push.headers.authorization);
    expect(headers[1]).toBe(headers[0]);
    expect(headers[2]).not.toBe(headers[0]);
    expect(fake.received.every((push) => push.problem === undefined)).toBe(true);
  });

  it("sends nothing to expired sessions and locked users, even if the rows are still there", async () => {
    let now = Date.now();
    const push = service({ clock: () => now });
    const account = accounts.createGuest("Anna");
    db.prepare("UPDATE users SET kind = 'account', username = 'anna-review' WHERE id = ?").run(account.id);
    const session = accounts.createSession(account.id).session.id;
    push.subscribe(session, fake.subscription(), "https://x.example");
    const expires = (db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(session) as { expires_at: number }).expires_at;
    now = expires + 1;
    push.notify(account.id, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await push.idle();
    expect(fake.received).toHaveLength(0);
    now = Date.now();
    db.prepare("UPDATE users SET locked = 1 WHERE id = ?").run(account.id);
    push.notify(account.id, "R2", { kind: "turn", room: "R2", game: "G" }, always);
    await push.idle();
    expect(fake.received).toHaveLength(0);
    db.prepare("UPDATE users SET locked = 0 WHERE id = ?").run(account.id);
    push.notify(account.id, "R3", { kind: "turn", room: "R3", game: "G" }, always);
    await push.idle();
    expect(fake.received).toHaveLength(1);
  });
});

describe("Shutdown", () => {
  it("survives closing service and database in the middle of sending", async () => {
    const push = service();
    const anna = device();
    push.subscribe(anna.session, fake.subscription(), "https://x.example");
    fake.respond(() => ({ status: 500, delayMs: 100 }));
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: "G" }, always);
    await fake.waitFor(1);
    push.close();
    closeDatabase();
    await push.idle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.received).toHaveLength(1);
    expect(logs).toEqual([]);
  });
});

describe("Helpers", () => {
  it("reads Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("120", 0)).toBe(120_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter("quatsch", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it("checks entries for PUSH_HOSTS and PUSH_CONTACT", () => {
    expect(validPushHost("push.example.org")).toBe(true);
    expect(validPushHost("*.push.example.org")).toBe(true);
    expect(validPushHost("http://127.0.0.1:9999")).toBe(true);
    expect(validPushHost("https://push.example.org/pfad")).toBe(false);
    expect(validPushHost("*")).toBe(false);
    expect(validPushHost("*.org")).toBe(false);
    expect(validContact("mailto:betrieb@example.org")).toBe(true);
    expect(validContact("https://games.example.org")).toBe(true);
    expect(validContact("http://games.example.org")).toBe(false);
    expect(validContact("betrieb@example.org")).toBe(false);
  });

  it("compares hosts case-insensitively", () => {
    expect(hostAllowed(new URL("https://FCM.googleapis.com/x"), ["fcm.googleapis.com"])).toBe(true);
    expect(hostAllowed(new URL("https://a.b.push.apple.com/x"), ["*.push.apple.com"])).toBe(true);
  });
});
