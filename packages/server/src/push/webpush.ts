import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface EncryptOptions {
  salt?: Buffer;
  senderPrivateKey?: Buffer;
  recordSize?: number;
}

export const recordSize = 4096;
export const maxPayloadBytes = recordSize - 86 - 16 - 1;
const keyInfoLabel = Buffer.from("WebPush: info\0", "latin1");
const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "latin1");
const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "latin1");

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]).toString("base64url"),
    privateKey: jwk.d as string,
  };
}

export function decodePublicKey(value: string): Buffer | undefined {
  const raw = decodeBase64Url(value);
  if (raw === undefined || raw.length !== 65 || raw[0] !== 4) {
    return undefined;
  }
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(raw);
  } catch {
    return undefined;
  }
  return raw;
}

export function decodeAuthSecret(value: string): Buffer | undefined {
  const raw = decodeBase64Url(value);
  return raw !== undefined && raw.length === 16 ? raw : undefined;
}

export function decodeBase64Url(value: string): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

export function encryptPayload(plaintext: Buffer, keys: SubscriptionKeys, options: EncryptOptions = {}): Buffer {
  const userAgentKey = decodePublicKey(keys.p256dh);
  const authSecret = decodeAuthSecret(keys.auth);
  if (userAgentKey === undefined || authSecret === undefined) {
    throw new Error("Invalid keys in the push subscription");
  }
  const size = options.recordSize ?? recordSize;
  if (plaintext.length + 1 + 16 > size || plaintext.length > maxPayloadBytes) {
    throw new Error(`Push message too large: ${plaintext.length} bytes`);
  }
  const ecdh = createECDH("prime256v1");
  if (options.senderPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(options.senderPrivateKey);
  }
  const senderKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userAgentKey);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, Buffer.concat([keyInfoLabel, userAgentKey, senderKey]), 32));
  const salt = options.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, nonceInfo, 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(size, 16);
  header.writeUInt8(senderKey.length, 20);
  return Buffer.concat([header, senderKey, ciphertext]);
}

export function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, expiresAt: number): string {
  const publicKey = decodeBase64Url(keys.publicKey);
  if (publicKey === undefined || publicKey.length !== 65) {
    throw new Error("Invalid public VAPID key");
  }
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(expiresAt / 1000), sub: subject })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${header}.${body}.${signature}, k=${keys.publicKey}`;
}
