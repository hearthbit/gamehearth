import {
  SeededRandom,
  applyChange,
  cloneProfile,
  emptyProfile,
  hasCatalog,
  randomStateFromSeed,
  type CatalogSpec,
  type ProfileChange,
  type ProfileData,
  type ProfileInput,
} from "@gamehearth/sdk/platform";

export interface ProfileRemoval {
  step: number;
  player: string;
  item: string;
  count: number;
}

export interface ProfileTrace {
  start: Record<string, ProfileData>;
  removals: ProfileRemoval[];
}

export const removalChance = 0.05;
export const filledChance = 0.5;

export class ProfileSim {
  readonly catalog: CatalogSpec | undefined;
  readonly trace: ProfileTrace;
  readonly #profiles = new Map<string, ProfileData>();

  constructor(catalog: CatalogSpec | undefined, players: readonly string[], trace: ProfileTrace) {
    this.catalog = catalog;
    this.trace = trace;
    for (const player of players) {
      const start = Object.hasOwn(trace.start, player) ? trace.start[player] : undefined;
      this.#profiles.set(player, start === undefined ? emptyProfile() : cloneProfile(start));
    }
  }

  static fresh(catalog: CatalogSpec | undefined, players: readonly string[], seed: string): ProfileSim {
    return new ProfileSim(catalog, players, { start: hasCatalog(catalog) ? startProfiles(catalog, players, seed) : {}, removals: [] });
  }

  input(): ProfileInput {
    const profiles: Record<string, ProfileData> = {};
    for (const [player, profile] of this.#profiles) {
      profiles[player] = cloneProfile(profile);
    }
    return this.catalog === undefined ? { profiles } : { catalog: this.catalog, profiles };
  }

  current(): Record<string, ProfileData> {
    return this.input().profiles as Record<string, ProfileData>;
  }

  apply(changes: readonly ProfileChange[] | undefined): string | undefined {
    for (const change of changes ?? []) {
      const profile = this.#profiles.get(change.player);
      if (profile === undefined) {
        return `Profile change for ${change.player}, a seat that is not in this match`;
      }
      const problem = applyChange(profile, change, this.catalog);
      if (problem !== undefined) {
        return problem.message;
      }
    }
    return undefined;
  }

  removalsAt(step: number): ProfileRemoval[] {
    return this.trace.removals.filter((removal) => removal.step === step);
  }

  remove(removal: ProfileRemoval): void {
    const profile = this.#profiles.get(removal.player);
    const have = profile?.items[removal.item] ?? 0;
    if (profile === undefined || have === 0) {
      return;
    }
    if (have <= removal.count) {
      delete profile.items[removal.item];
    } else {
      profile.items[removal.item] = have - removal.count;
    }
  }

  pickRemoval(random: SeededRandom, step: number): ProfileRemoval | undefined {
    if (Object.keys(this.catalog?.items ?? {}).length === 0 || random.next() >= removalChance) {
      return undefined;
    }
    const holders = [...this.#profiles].filter(([, profile]) => Object.keys(profile.items).length > 0);
    if (holders.length === 0) {
      return undefined;
    }
    const [player, profile] = random.pick(holders);
    const item = random.pick(Object.keys(profile.items).sort());
    const count = random.int(1, profile.items[item] ?? 1);
    const removal = { step, player, item, count };
    this.trace.removals.push(removal);
    return removal;
  }
}

export function removalRandom(seed: string): SeededRandom {
  return new SeededRandom(randomStateFromSeed(`profiles:${seed}`));
}

function startProfiles(catalog: CatalogSpec | undefined, players: readonly string[], seed: string): Record<string, ProfileData> {
  const random = new SeededRandom(randomStateFromSeed(`profile-start:${seed}`));
  const start: Record<string, ProfileData> = {};
  for (const player of players) {
    if (random.next() >= filledChance) {
      continue;
    }
    const profile = emptyProfile();
    for (const item of Object.keys(catalog?.items ?? {}).sort()) {
      if (random.next() < 0.6) {
        profile.items[item] = random.int(1, 10);
      }
    }
    for (const [stat, spec] of Object.entries(catalog?.stats ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (random.next() < 0.6) {
        profile.stats[stat] = spec.better === undefined ? random.int(0, 50) : random.int(1, 1000);
      }
    }
    for (const flag of Object.keys(catalog?.flags ?? {}).sort()) {
      if (random.next() < 0.5) {
        profile.flags[flag] = random.next() < 0.5 ? true : String(random.int(1, 5));
      }
    }
    start[player] = profile;
  }
  return start;
}

export function stepFingerprintText(match: unknown, changes: readonly ProfileChange[] | undefined): string {
  return JSON.stringify(changes === undefined || changes.length === 0 ? match : { match, changes });
}
