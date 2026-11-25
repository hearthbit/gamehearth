import { describe, expect, it } from "vitest";
import { decodePublicKey, encryptPayload, generateVapidKeys, maxPayloadBytes, vapidAuthorization } from "../src/push/webpush";
import { decryptPayload, newSubscriptionKeys, verifyVapid } from "./fake-push";

const rfc8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const rfc8292 = {
  header:
    "vapid t=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3" +
    "B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha" +
    "Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H" +
    "LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA, " +
    "k=BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dR" +
    "uU_RCPCfA5aq9ojSwk5Y2EmClBPs",
  exp: 1453523768,
};

describe("Encryption per RFC 8291", () => {
  it("yields exactly the RFC's message with its salt and sender key", () => {
    const body = encryptPayload(
      Buffer.from(rfc8291.plaintext),
      { p256dh: rfc8291.receiverPublic, auth: rfc8291.auth },
      { salt: Buffer.from(rfc8291.salt, "base64url"), senderPrivateKey: Buffer.from(rfc8291.senderPrivate, "base64url") },
    );
    expect(body.toString("base64url")).toBe(rfc8291.body);
    expect(body.length).toBe(86 + rfc8291.plaintext.length + 1 + 16);
  });

  it("decrypts the RFC's example message with the receiver's key", () => {
    const plain = decryptPayload(Buffer.from(rfc8291.body, "base64url"), rfc8291.receiverPrivate, {
      p256dh: rfc8291.receiverPublic,
      auth: rfc8291.auth,
    });
    expect(plain.toString()).toBe(rfc8291.plaintext);
  });

  it("encrypts each message with fresh salt and key, and the receiver still reads it", () => {
    const receiver = newSubscriptionKeys();
    const first = encryptPayload(Buffer.from("{\"kind\":\"turn\"}"), receiver.keys);
    const second = encryptPayload(Buffer.from("{\"kind\":\"turn\"}"), receiver.keys);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(decryptPayload(first, receiver.privateKey, receiver.keys).toString()).toBe("{\"kind\":\"turn\"}");
    expect(decryptPayload(second, receiver.privateKey, receiver.keys).toString()).toBe("{\"kind\":\"turn\"}");
  });

  it("writes record size 4096 and the sender key into the header", () => {
    const receiver = newSubscriptionKeys();
    const body = encryptPayload(Buffer.from("x"), receiver.keys);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body[21]).toBe(4);
  });

  it("rejects too large messages and broken keys", () => {
    const receiver = newSubscriptionKeys();
    expect(() => encryptPayload(Buffer.alloc(maxPayloadBytes + 1), receiver.keys)).toThrow(/too large/);
    expect(encryptPayload(Buffer.alloc(maxPayloadBytes), receiver.keys).length).toBe(4096);
    expect(() => encryptPayload(Buffer.from("x"), { ...receiver.keys, auth: "kurz" })).toThrow(/Invalid/);
    expect(() => encryptPayload(Buffer.from("x"), { ...receiver.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") })).toThrow(/Invalid/);
  });

  it("detects points that are not on the curve", () => {
    expect(decodePublicKey(rfc8291.receiverPublic)).toBeDefined();
    expect(decodePublicKey(Buffer.alloc(65, 4).toString("base64url"))).toBeUndefined();
    expect(decodePublicKey(Buffer.alloc(33, 2).toString("base64url"))).toBeUndefined();
    expect(decodePublicKey("not base64!")).toBeUndefined();
  });
});

describe("VAPID per RFC 8292", () => {
  it("the fake service's check accepts the RFC example", () => {
    const claims = verifyVapid(rfc8292.header, rfc8292.exp * 1000 - 60_000);
    expect(claims).toMatchObject({ aud: "https://push.example.net", sub: "mailto:push@example.com", exp: rfc8292.exp });
  });

  it("the check rejects a modified example", () => {
    const tampered = rfc8292.header.replace("i3CYb7t4", "i3CYb7t5");
    expect(() => verifyVapid(tampered, rfc8292.exp * 1000 - 60_000)).toThrow(/signature/);
    expect(() => verifyVapid(rfc8292.header, rfc8292.exp * 1000 + 1)).toThrow(/exp/);
  });

  it("signs a JWT that can be verified with the public key", () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 10, 17, 12);
    const header = vapidAuthorization(keys, "https://fcm.googleapis.com", "https://games.example.org", now + 12 * 60 * 60 * 1000);
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const claims = verifyVapid(header, now);
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", sub: "https://games.example.org", exp: now / 1000 + 12 * 60 * 60, key: keys.publicKey });
  });

  it("creates keys in the format browsers expect as applicationServerKey", () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, "base64url").length).toBe(65);
    expect(Buffer.from(keys.privateKey, "base64url").length).toBe(32);
    expect(decodePublicKey(keys.publicKey)).toBeDefined();
  });
});
