import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: string;
}

export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
  key: string;
}

export interface ReceivedPush {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  payload?: unknown;
  vapid?: VapidClaims;
  problem?: string;
}

export function newSubscriptionKeys(): { keys: { p256dh: string; auth: string }; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

export function decryptPayload(body: Buffer, privateKey: string, keys: { p256dh: string; auth: string }): Buffer {
  if (body.length < 21) {
    throw new Error("header missing");
  }
  const salt = body.subarray(0, 16);
  const size = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  if (ciphertext.length > size || ciphertext.length < 17) {
    throw new Error(`record does not fit: ${ciphertext.length} bytes at size ${size}`);
  }
  const userAgentKey = Buffer.from(keys.p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const shared = ecdh.computeSecret(senderKey);
  const info = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), userAgentKey, senderKey]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(keys.auth, "base64url"), info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) {
    end--;
  }
  if (end < 0 || padded[end] !== 2) {
    throw new Error("delimiter 0x02 missing");
  }
  return padded.subarray(0, end);
}

export function verifyVapid(header: string | undefined, now: number): VapidClaims {
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), ?k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (match === null) {
    throw new Error(`Authorization is not vapid: ${header}`);
  }
  const [, head, body, signature, key] = match as unknown as [string, string, string, string, string];
  const parsedHead = JSON.parse(Buffer.from(head, "base64url").toString()) as Record<string, unknown>;
  if (parsedHead["alg"] !== "ES256" || parsedHead["typ"] !== "JWT") {
    throw new Error(`wrong JWT header ${JSON.stringify(parsedHead)}`);
  }
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 65 || raw[0] !== 4) {
    throw new Error("k is not an uncompressed P-256 key");
  }
  const publicKey = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    format: "jwk",
  });
  if (!verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))) {
    throw new Error("signature does not match");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp * 1000 <= now || exp * 1000 > now + 24 * 60 * 60 * 1000) {
    throw new Error(`exp ${String(exp)} is not within the next 24 hours`);
  }
  if (typeof claims["sub"] !== "string" || !/^(mailto:|https:)/.test(claims["sub"])) {
    throw new Error(`sub ${String(claims["sub"])} is neither mailto: nor https:`);
  }
  return { aud: String(claims["aud"]), exp, sub: claims["sub"], key };
}

export interface FakePushService {
  origin: string;
  received: ReceivedPush[];
  subscription(name?: string): TestSubscription;
  respond(handler: (request: ReceivedPush) => { status: number; headers?: Record<string, string>; delayMs?: number } | undefined): void;
  waitFor(count: number, timeoutMs?: number): Promise<ReceivedPush[]>;
  close(): Promise<void>;
}

export async function startFakePushService(options: { clock?: () => number; port?: number } = {}): Promise<FakePushService> {
  const clock = options.clock ?? Date.now;
  const received: ReceivedPush[] = [];
  const subscriptions = new Map<string, TestSubscription>();
  let handler: (request: ReceivedPush) => { status: number; headers?: Record<string, string>; delayMs?: number } | undefined = () => undefined;
  const waiters: (() => void)[] = [];
  let origin = "";
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const push: ReceivedPush = { path, headers: request.headers, body: Buffer.concat(chunks) };
      try {
        push.vapid = verifyVapid(request.headers.authorization, clock());
        if (push.vapid.aud !== origin) {
          throw new Error(`aud ${push.vapid.aud} is not ${origin}`);
        }
        if (request.headers["content-encoding"] !== "aes128gcm") {
          throw new Error(`content-encoding ${String(request.headers["content-encoding"])}`);
        }
        const subscription = subscriptions.get(`${origin}${path}`);
        if (subscription === undefined) {
          throw new Error(`unknown subscription ${path}`);
        }
        push.payload = JSON.parse(decryptPayload(push.body, subscription.privateKey, subscription.keys).toString("utf8"));
      } catch (error) {
        push.problem = error instanceof Error ? error.message : String(error);
      }
      received.push(push);
      const answer = handler(push) ?? { status: push.problem === undefined ? 201 : 400 };
      const finish = () => {
        response.writeHead(answer.status, answer.headers ?? {});
        response.end();
        for (const waiter of waiters.splice(0)) {
          waiter();
        }
      };
      if (answer.delayMs === undefined) {
        finish();
      } else {
        setTimeout(finish, answer.delayMs);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let counter = 0;
  return {
    origin,
    received,
    subscription(name = `abo-${++counter}`) {
      const { keys, privateKey } = newSubscriptionKeys();
      const subscription = { endpoint: `${origin}/push/${name}`, keys, privateKey };
      subscriptions.set(subscription.endpoint, subscription);
      return subscription;
    },
    respond(next) {
      handler = next;
    },
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Only ${received.length} of ${count} pushes arrived`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return received.slice(0, count);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
