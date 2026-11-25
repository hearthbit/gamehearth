import type { GameResult } from "./game";
import { cloneJson } from "./json";
import type { Match } from "./match";
import type { AnyGameState, PerPlayerOf, PlayerId, PublicOf } from "./state";

export interface PlayerSnapshot<Public, PerPlayer, A> {
  player: PlayerId;
  players: PlayerId[];
  public: Public;
  me: PerPlayer;
  moves: A[];
  version: number;
  tick?: number;
  result?: GameResult;
}

export interface ScreenSnapshot<Public> {
  players: PlayerId[];
  public: Public;
  version: number;
  tick?: number;
  result?: GameResult;
}

export function playerSnapshot<S extends AnyGameState, A>(
  match: Match<S, A>,
  player: PlayerId,
): PlayerSnapshot<PublicOf<S>, PerPlayerOf<S>, A> {
  if (!match.players.includes(player)) {
    throw new Error(`${player} is not a seat in this match`);
  }
  return cloneJson({
    player,
    players: match.players,
    public: match.state.public,
    me: match.state.players[player] as PerPlayerOf<S>,
    moves: match.moves[player] ?? [],
    version: match.version,
    ...(match.tick === undefined ? {} : { tick: match.tick }),
    ...(match.result === undefined ? {} : { result: match.result }),
  });
}

export function screenSnapshot<S extends AnyGameState, A>(match: Match<S, A>): ScreenSnapshot<PublicOf<S>> {
  return cloneJson({
    players: match.players,
    public: match.state.public,
    version: match.version,
    ...(match.tick === undefined ? {} : { tick: match.tick }),
    ...(match.result === undefined ? {} : { result: match.result }),
  });
}
