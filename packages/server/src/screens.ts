import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { Manifest } from "gamehearth";

export const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const pairingLength = 8;
export const pairingMinutes = 10;
export const maxScreensPerRoom = 4;
export const screenIdleMs = 24 * 60 * 60 * 1000;

export function hasScreenRole(manifest: Pick<Manifest, "roles">): boolean {
  return manifest.roles.screen !== undefined;
}

export function requiresScreen(manifest: Pick<Manifest, "roles">): boolean {
  return manifest.roles.screen !== undefined && manifest.roles.screen.optional !== true;
}

const pairingPattern = new RegExp(`^[${pairingAlphabet}]{${pairingLength}}$`);
const reuseAboveMs = 60_000;
export const maxPendingCodes = 10_000;

export interface PairingCode {
  code: string;
  expiresAt: number;
  expiresInMs: number;
}

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deviceHash(token: string): string {
  return createHash("sha256").update(`screen:${token}`).digest("hex");
}

export function normalizePairingCode(code: unknown): string | undefined {
  if (typeof code !== "string") {
    return undefined;
  }
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  return pairingPattern.test(normalized) ? normalized : undefined;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class ScreenPairing {
  readonly #key = randomBytes(32);
  readonly #byDevice = new Map<string, { code: string; hash: string; expiresAt: number }>();
  readonly #byCode = new Map<string, string>();
  readonly #clock: () => number;
  readonly #lifetimeMs: number;
  readonly #maxPending: number;

  constructor(options: { clock?: () => number; lifetimeMs?: number; maxPending?: number } = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#lifetimeMs = options.lifetimeMs ?? pairingMinutes * 60 * 1000;
    this.#maxPending = options.maxPending ?? maxPendingCodes;
  }

  code(device: string): PairingCode | undefined {
    const now = this.#clock();
    const existing = this.#byDevice.get(device);
    if (existing !== undefined && existing.expiresAt - now > reuseAboveMs) {
      return { code: formatPairingCode(existing.code), expiresAt: existing.expiresAt, expiresInMs: existing.expiresAt - now };
    }
    this.#drop(device);
    this.sweep();
    if (this.#byDevice.size >= this.#maxPending) {
      return undefined;
    }
    let code: string;
    let hash: string;
    do {
      code = Array.from({ length: pairingLength }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join("");
      hash = this.#hash(code);
    } while (this.#byCode.has(hash));
    const expiresAt = now + this.#lifetimeMs;
    this.#byDevice.set(device, { code, hash, expiresAt });
    this.#byCode.set(hash, device);
    return { code: formatPairingCode(code), expiresAt, expiresInMs: this.#lifetimeMs };
  }

  peek(code: unknown): string | undefined {
    const normalized = normalizePairingCode(code);
    if (normalized === undefined) {
      return undefined;
    }
    const device = this.#byCode.get(this.#hash(normalized));
    const entry = device === undefined ? undefined : this.#byDevice.get(device);
    if (device === undefined || entry === undefined || entry.expiresAt <= this.#clock()) {
      return undefined;
    }
    return device;
  }

  redeem(code: unknown): string | undefined {
    const device = this.peek(code);
    if (device !== undefined) {
      this.#drop(device);
    }
    return device;
  }

  forget(device: string): void {
    this.#drop(device);
  }

  sweep(): void {
    const now = this.#clock();
    for (const [device, entry] of this.#byDevice) {
      if (entry.expiresAt <= now) {
        this.#drop(device);
      }
    }
  }

  #drop(device: string): void {
    const entry = this.#byDevice.get(device);
    if (entry !== undefined) {
      this.#byCode.delete(entry.hash);
      this.#byDevice.delete(device);
    }
  }

  #hash(code: string): string {
    return createHmac("sha256", this.#key).update(code).digest("hex");
  }
}
