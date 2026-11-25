import { SeededRandom, canonicalJson, cloneJson, deepFreeze, emptyProfile, randomStateFromSeed, type GameOptions, type ProfileData } from "@gamehearth/sdk/platform";
import type { Finding } from "./findings";
import type { AnyGame, AnyMatch } from "./runner";

export const minimumTokenLength = 2;

type Where = { playerCount: number; seed: string; options?: GameOptions; step: number };
type Tokens = Map<string, string>;

export function findLeaks(
  game: AnyGame | undefined,
  match: AnyMatch,
  where: Where,
  profiles: Readonly<Record<string, ProfileData>> = {},
  typed: ReadonlySet<string> = new Set(),
): Finding[] {
  const findings: Finding[] = [];
  if (game !== undefined && match.result === undefined) {
    const read = Object.fromEntries(match.players.map((player) => [player, cloneJson(Object.hasOwn(profiles, player) ? profiles[player] : emptyProfile())]));
    for (const player of match.players) {
      const finding = movesDependOnHidden(game, match, player, where, read);
      if (finding !== undefined) {
        findings.push(finding);
      }
    }
  }
  findings.push(...copiedValues(match, where, typed));
  return findings;
}

function movesDependOnHidden(game: AnyGame, match: AnyMatch, player: string, where: Where, profiles: Record<string, unknown>): Finding | undefined {
  const random = new SeededRandom(randomStateFromSeed(`leak:${where.seed}:${where.step}:${player}`));
  const perturbed = perturbHidden(match.state, player, new Set(match.players), random);
  if (perturbed === undefined) {
    return undefined;
  }
  let alternative: unknown;
  try {
    const context = deepFreeze({ players: [...match.players], options: cloneJson(match.options ?? {}), profiles: cloneJson(profiles) as never });
    alternative = game.legalMoves(deepFreeze(perturbed) as AnyMatch["state"], player, context);
  } catch {
    return undefined;
  }
  if (!Array.isArray(alternative)) {
    return undefined;
  }
  const original = match.moves[player] ?? [];
  const before = original.map(canonicalJson);
  const after = new Set(alternative.map(canonicalJson));
  if (before.length === after.size && before.every((move) => after.has(move))) {
    return undefined;
  }
  const revealing = before.find((move) => !after.has(move));
  return {
    severity: "error",
    kind: "leak",
    message:
      "The legal moves of a player depend on data the player may not see (secret or the areas of other players). Moves go to the player's client and reveal this data. legalMoves may only evaluate public and the player's own area.",
    detail:
      revealing === undefined
        ? `legalMoves(${player}) changes when hidden values are swapped`
        : `legalMoves(${player}) contains ${revealing}; when hidden values are swapped, this move disappears`,
    player,
    ...where,
  };
}

type Slot = { container: Record<string, unknown> | unknown[]; key: string | number };

export function perturbHidden(state: unknown, player: string, seats: ReadonlySet<string>, random: SeededRandom): unknown {
  const copy = cloneJson(state) as { secret: unknown; players: Record<string, unknown> };
  const slots: Slot[] = [];
  const sets: Record<string, unknown>[] = [];
  const roots: unknown[] = [copy.secret, ...Object.entries(copy.players).filter(([seat]) => seat !== player).map(([, area]) => area)];
  for (const root of roots) {
    collectSlots(root, seats, slots, sets);
  }
  const setKeys = sets.flatMap((set) => Object.keys(set));
  const values = [...slots.map((slot) => (slot.container as Record<string | number, unknown>)[slot.key] as string), ...setKeys];
  if (new Set(values).size < 2) {
    return undefined;
  }
  const shuffled = random.shuffle(values);
  if (shuffled.every((value, index) => value === values[index])) {
    shuffled.push(shuffled.shift() as string);
  }
  slots.forEach((slot, index) => {
    (slot.container as Record<string | number, unknown>)[slot.key] = shuffled[index];
  });
  let offset = slots.length;
  for (const set of sets) {
    const size = Object.keys(set).length;
    const fresh = shuffled.slice(offset, offset + size);
    offset += size;
    if (new Set(fresh).size !== size) {
      return undefined;
    }
    for (const key of Object.keys(set)) {
      delete set[key];
    }
    for (const key of fresh) {
      set[key] = true;
    }
  }
  return copy;
}

function collectSlots(root: unknown, seats: ReadonlySet<string>, slots: Slot[], sets: Record<string, unknown>[]): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      current.forEach((child, index) => {
        if (typeof child === "string") {
          if (!seats.has(child)) slots.push({ container: current, key: index });
        } else {
          stack.push(child);
        }
      });
    } else if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const entries = Object.entries(record);
      if (entries.length > 0 && entries.every(([key, value]) => value === true && !seats.has(key))) {
        sets.push(record);
        continue;
      }
      for (const [key, child] of entries) {
        if (typeof child === "string") {
          if (!seats.has(child)) slots.push({ container: record, key });
        } else {
          stack.push(child);
        }
      }
    }
  }
}

function copiedValues(match: AnyMatch, where: Where, typed: ReadonlySet<string>): Finding[] {
  const seats = new Set(match.players);
  const vocabulary = new Set<string>();
  for (const player of match.players) {
    for (const token of collectTokens(match.moves[player] ?? [], "moves", seats, false).keys()) {
      vocabulary.add(token);
    }
  }
  const publicTokens = collectTokens(match.state.public, "public", seats);
  const secretTokens = collectTokens(match.state.secret, "secret", seats);
  const ownTokens = new Map(
    match.players.map((player) => [player, collectTokens(match.state.players[player], `players.${player}`, seats)]),
  );
  const findings: Finding[] = [];
  const meaningful = (token: string) => !vocabulary.has(token);

  for (const [token, path] of publicTokens) {
    if (!meaningful(token)) continue;
    const secretPath = secretTokens.get(token);
    if (secretPath !== undefined) {
      findings.push({
        severity: "warning",
        kind: "leak",
        message:
          "A value is in public and in secret at the same time. When revealing, a value is normally moved, not copied.",
        detail: `${token} is in ${path} and in ${secretPath}`,
        ...where,
      });
    }
    const holder = holding(token, undefined, ownTokens);
    if (holder !== undefined) {
      findings.push({
        severity: "warning",
        kind: "leak",
        message:
          "A value is in public and in the area of a player at the same time. Everyone sees it, although it is still hidden with that player.",
        detail: `${token} is in ${path} and in ${holder}`,
        ...where,
      });
    }
  }

  for (const player of match.players) {
    for (const [token, path] of ownTokens.get(player) ?? new Map<string, string>()) {
      if (!meaningful(token) || publicTokens.has(token) || isTyped(token, typed, seats)) continue;
      const elsewhere = secretTokens.get(token) ?? holding(token, player, ownTokens);
      if (elsewhere !== undefined) {
        findings.push({
          severity: "warning",
          kind: "leak",
          message:
            "A value is in the area of a player and at the same time in secret or with another player. The player thus sees something hidden.",
          detail: `${token} is in ${path} and in ${elsewhere}`,
          player,
          ...where,
        });
      }
    }
  }
  return findings;
}

function isTyped(token: string, typed: ReadonlySet<string>, seats: ReadonlySet<string>): boolean {
  if (typed.size === 0) {
    return false;
  }
  const value: unknown = JSON.parse(token);
  if (typeof value === "string") {
    return typed.has(value);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const texts = Object.values(value).filter((field): field is string => typeof field === "string" && field.length >= minimumTokenLength && !seats.has(field));
  return texts.length > 0 && texts.every((field) => typed.has(field));
}

function holding(token: string, except: string | undefined, ownTokens: Map<string, Tokens>): string | undefined {
  for (const [player, tokens] of ownTokens) {
    if (player !== except && tokens.has(token)) {
      return tokens.get(token);
    }
  }
  return undefined;
}

export function collectTokens(value: unknown, path: string, seats: ReadonlySet<string>, items = true): Tokens {
  const tokens: Tokens = new Map();
  const add = (token: string, at: string) => {
    if (!tokens.has(token)) tokens.set(token, at);
  };
  const meaningful = (text: string) => text.length >= minimumTokenLength && !seats.has(text);
  const stack: { value: unknown; path: string; inArray: boolean }[] = [{ value, path, inArray: false }];
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; path: string; inArray: boolean };
    const item = current.value;
    if (typeof item === "string") {
      if (meaningful(item)) add(JSON.stringify(item), current.path);
    } else if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) {
        stack.push({ value: item[i], path: `${current.path}[${i}]`, inArray: true });
      }
    } else if (item !== null && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length > 0 && entries.every(([, child]) => child === true)) {
        for (const [key] of entries) {
          if (meaningful(key)) add(JSON.stringify(key), `${current.path}.${key}`);
        }
        continue;
      }
      const isItem =
        items &&
        current.inArray &&
        entries.length <= 6 &&
        entries.every(([, child]) => child === null || typeof child !== "object") &&
        entries.some(([, child]) => typeof child === "string" && meaningful(child));
      if (isItem) {
        add(canonicalJson(item), current.path);
        continue;
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i] as [string, unknown];
        stack.push({ value: child, path: `${current.path}.${key}`, inArray: false });
      }
    }
  }
  return tokens;
}
