import {
  applyChange,
  cloneProfile,
  emptyProfile,
  maxChangesPerCall,
  readProfile,
  type CatalogInput,
  type ProfileChange,
  type ProfileData,
  type ProfileOperation,
  type ProfileWriter,
  type Profiles,
} from "./profile";
import type { PlayerId } from "./state";

export interface ProfileFailure {
  kind: "missing" | "invalid";
  message: string;
  stack?: string;
}

export type WriterPhase = "apply" | "tick";

export class ProfileSession {
  readonly #catalog: CatalogInput | undefined;
  readonly #players: readonly PlayerId[];
  readonly #data: Map<PlayerId, ProfileData>;
  readonly #views = new Map<PlayerId, ProfileData>();
  readonly changes: ProfileChange[] = [];
  failure: ProfileFailure | undefined;

  constructor(players: readonly PlayerId[], catalog: CatalogInput | undefined, profiles: Readonly<Record<PlayerId, unknown>> | undefined) {
    this.#catalog = catalog;
    this.#players = [...players];
    this.#data = new Map();
    for (const player of players) {
      const raw = profiles !== undefined && Object.hasOwn(profiles, player) ? profiles[player] : undefined;
      this.#data.set(player, raw === undefined ? emptyProfile() : readProfile(raw));
    }
  }

  fork(): ProfileSession {
    const copy = new ProfileSession(this.#players, this.#catalog, undefined);
    for (const [player, profile] of this.#data) {
      copy.#data.set(player, cloneProfile(profile));
    }
    return copy;
  }

  data(): Record<PlayerId, ProfileData> {
    const result = Object.create(null) as Record<PlayerId, ProfileData>;
    for (const [player, profile] of this.#data) {
      result[player] = cloneProfile(profile);
    }
    return result;
  }

  snapshot(): Profiles {
    const view = Object.create(null) as Record<PlayerId, ProfileData>;
    for (const player of this.#players) {
      view[player] = this.#view(player);
    }
    return Object.freeze(view);
  }

  live(): Profiles {
    const view = Object.create(null) as Record<PlayerId, ProfileData>;
    for (const player of this.#players) {
      Object.defineProperty(view, player, { enumerable: true, get: () => this.#view(player) });
    }
    return Object.freeze(view);
  }

  writer(phase: WriterPhase): ProfileWriter {
    const write = (op: ProfileOperation) => (player: PlayerId, id: string, value: number | string | boolean) => this.#write(phase, op, player, id, value);
    return Object.freeze({ add: write("add"), use: write("use"), stat: write("stat"), record: write("record"), flag: write("flag") });
  }

  #write(phase: WriterPhase, op: ProfileOperation, player: PlayerId, id: string, value: number | string | boolean): void {
    const call = `ctx.profile.${op}`;
    if (op === "use" && phase === "tick") {
      this.#fail("invalid", `${call} exists only in apply, not in tick: the server cannot reject a tick without pausing the match. Consuming belongs in the move that triggers it.`);
    }
    if (typeof player !== "string" || !this.#players.includes(player)) {
      this.#fail("invalid", `${call}: ${JSON.stringify(player) ?? String(player)} is not a seat in this match (seats: ${this.#players.join(", ")})`);
    }
    if (this.changes.length >= maxChangesPerCall) {
      this.#fail("invalid", `${call}: More than ${maxChangesPerCall} profile changes in one call; combine changes, e.g. add(seat, id, 5) instead of add(seat, id, 1) five times`);
    }
    const profile = this.#data.get(player) as ProfileData;
    const section = op === "add" || op === "use" ? profile.items : op === "flag" ? profile.flags : profile.stats;
    const before = typeof id === "string" && Object.hasOwn(section, id) ? section[id] : undefined;
    const problem = applyChange(profile, { op, id, value }, this.#catalog);
    if (problem !== undefined) {
      this.#fail(problem.kind, problem.kind === "missing" ? `${player}: ${problem.message}` : problem.message);
    }
    const after = Object.hasOwn(section, id) ? section[id] : undefined;
    if (Object.is(before, after)) {
      return;
    }
    this.#views.delete(player);
    this.changes.push({ player, op, id, value });
  }

  #fail(kind: ProfileFailure["kind"], message: string): never {
    const error = new Error(message);
    if (this.failure === undefined) {
      this.failure = typeof error.stack === "string" ? { kind, message, stack: error.stack } : { kind, message };
    }
    throw error;
  }

  #view(player: PlayerId): ProfileData {
    let view = this.#views.get(player);
    if (view === undefined) {
      const profile = cloneProfile(this.#data.get(player) as ProfileData);
      view = Object.freeze({ items: Object.freeze(profile.items), stats: Object.freeze(profile.stats), flags: Object.freeze(profile.flags) });
      this.#views.set(player, view);
    }
    return view;
  }
}

export function forbiddenWriter(where: string): ProfileWriter {
  const refuse = (op: string) => () => {
    throw new Error(`ctx.profile.${op} does not exist in ${where}. The game changes profiles only in apply and tick; reading works everywhere through ctx.profiles.`);
  };
  return Object.freeze({ add: refuse("add"), use: refuse("use"), stat: refuse("stat"), record: refuse("record"), flag: refuse("flag") });
}
