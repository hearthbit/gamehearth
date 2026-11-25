import { findNonJson } from "./json";

export type PlayerId = string;

export interface GameState<Public, PerPlayer, Secret> {
  public: Public;
  players: Record<PlayerId, PerPlayer>;
  secret: Secret;
}

export type AnyGameState = GameState<unknown, unknown, unknown>;

export type PublicOf<S extends AnyGameState> = S["public"];
export type PerPlayerOf<S extends AnyGameState> = S["players"][PlayerId];
export type SecretOf<S extends AnyGameState> = S["secret"];

const stateKeys = ["public", "players", "secret"];

export function seatIds(count: number): PlayerId[] {
  return Array.from({ length: count }, (_, index) => `p${index + 1}`);
}

export function describeStateProblem(state: unknown, players: readonly PlayerId[]): string | undefined {
  if (!isPlainObject(state)) {
    return "the state must be an object with public, players and secret";
  }
  for (const key of stateKeys) {
    if (!Object.hasOwn(state, key) || state[key] === undefined) {
      return `the state is missing the field "${key}"`;
    }
  }
  for (const key of Object.keys(state)) {
    if (!stateKeys.includes(key)) {
      return `the state has the unknown field "${key}", only public, players and secret are allowed`;
    }
  }
  const seats = state["players"];
  if (!isPlainObject(seats)) {
    return "state.players must be an object with one entry per seat";
  }
  for (const player of players) {
    if (!Object.hasOwn(seats, player) || seats[player] === undefined) {
      return `state.players has no entry for the seat ${player}`;
    }
  }
  for (const key of Object.keys(seats)) {
    if (!players.includes(key)) {
      return `state.players contains "${key}", which is not a seat in this match (seats: ${players.join(", ")})`;
    }
  }
  const problem = findNonJson(state, "state");
  return problem === undefined ? undefined : `${problem.path} ${problem.reason}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
