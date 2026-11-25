import type { GameOptions, OptionsShape } from "./options";
import type { AnyCatalog, CatalogIds, ProfileWriter, Profiles, TickProfileWriter } from "./profile";
import type { Random } from "./random";
import type { AnyGameState, PlayerId } from "./state";

export interface SetupContext<O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> {
  players: readonly PlayerId[];
  random: Random;
  options: O;
  profiles: Profiles<C>;
}

export interface MoveContext<O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> extends SetupContext<O, C> {
  player: PlayerId;
  now: number;
  away: readonly PlayerId[];
  profile: ProfileWriter<C>;
}

export interface TickContext<O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> extends SetupContext<O, C> {
  now: number;
  away: readonly PlayerId[];
  profile: TickProfileWriter<C>;
}

export interface LegalMovesContext<O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> {
  players: readonly PlayerId[];
  options: O;
  profiles: Profiles<C>;
}

export interface BotContext<O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> extends SetupContext<O, C> {
  now: number;
  away: readonly PlayerId[];
}

export interface GameResult {
  winners: PlayerId[];
}

export interface GameDefinition<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> {
  setup(ctx: SetupContext<O, C>): S;
  legalMoves(state: S, player: PlayerId, ctx: LegalMovesContext<O, C>): A[];
  apply(state: S, action: A, ctx: MoveContext<O, C>): S | void;
  result(state: S): GameResult | undefined;
  tick?(state: S, dt: number, ctx: TickContext<O, C>): S | void;
  bot?(state: S, player: PlayerId, moves: A[], ctx: BotContext<O, C>): A | undefined;
}

export type DefinedGame<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> = GameDefinition<S, A, O, C> & {
  legalMoves(state: S, player: PlayerId, ctx?: LegalMovesContext<O, C>): A[];
};

export function defineGame<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
): DefinedGame<S, A, O, C> {
  return game as DefinedGame<S, A, O, C>;
}
