import "./prelude";
import { applyMove, botMove, createMatch, hasBot, refreshMatch, stepMatch, type AnyGameState, type CatalogSpec, type GameDefinition, type GameOptions } from "@gamehearth/sdk/platform";

type AnyGame = GameDefinition<AnyGameState, unknown>;

let installed: AnyGame | undefined;
let catalog: CatalogSpec | undefined;

function game(): AnyGame {
  if (installed === undefined) {
    throw new Error("no game installed");
  }
  return installed;
}

function profileInput(profiles: unknown): { catalog?: CatalogSpec; profiles?: Record<string, unknown> } {
  return {
    ...(catalog === undefined ? {} : { catalog }),
    ...(profiles === undefined || profiles === null ? {} : { profiles: profiles as Record<string, unknown> }),
  };
}

const api = {
  install(value: unknown, catalogJson?: unknown): string {
    const candidate = value as Record<string, unknown> | null;
    const complete =
      candidate !== null &&
      typeof candidate === "object" &&
      ["setup", "legalMoves", "apply", "result"].every((name) => typeof candidate[name] === "function");
    if (!complete) {
      throw new Error(
        "src/index.ts does not export a game. The game must be exported like this: export default defineGame({ setup, legalMoves, apply, result })",
      );
    }
    installed = candidate as unknown as AnyGame;
    catalog = typeof catalogJson === "string" ? (JSON.parse(catalogJson) as CatalogSpec) : undefined;
    return typeof (candidate as Record<string, unknown>)["bot"] === "function" ? "bot" : "";
  },
  createMatch(input: string): string {
    const { playerCount, seed, options, profiles } = JSON.parse(input) as { playerCount: number; seed: string; options?: GameOptions; profiles?: unknown };
    return JSON.stringify(createMatch(game(), { playerCount, seed, ...(options === undefined ? {} : { options }), ...profileInput(profiles) }));
  },
  applyMove(input: string): string {
    const { match, move, profiles } = JSON.parse(input);
    return JSON.stringify(applyMove(game(), match, move, profileInput(profiles)));
  },
  stepMatch(input: string): string {
    const { match, step, profiles } = JSON.parse(input);
    return JSON.stringify(stepMatch(game(), match, step, profileInput(profiles)));
  },
  refreshMatch(input: string): string {
    const { match, profiles } = JSON.parse(input);
    return JSON.stringify(refreshMatch(game(), match, profileInput(profiles)));
  },
  botMove(input: string): string {
    const { match, player, now, away, profiles } = JSON.parse(input);
    const bot = botMove(game(), match, player, { now, ...(away === undefined ? {} : { away }), ...profileInput(profiles) });
    return JSON.stringify({ ok: true, match, bot, hasBot: hasBot(game()) });
  },
};

Object.defineProperty(globalThis, "__gamehearth", { value: Object.freeze(api), writable: false, enumerable: false, configurable: false });
