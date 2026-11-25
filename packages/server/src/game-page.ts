import type { CatalogEntrySpec, Localized, PlayerCountSpec, ProfileData, StatSpec } from "@gamehearth/sdk/platform";
import { clientUrl, languagesAndCover, type GameLibrary, type LanguagesAndCover } from "./games";
import { ProfileError, type BoardEntry, type ProfileService, type ProfileSource } from "./profiles";
import { isSoloManifest } from "./solo";

export interface GamePageInfo extends LanguagesAndCover {
  id: string;
  name: Localized;
  version: string;
  description?: Localized;
  mode: string;
  players: PlayerCountSpec;
  roles: string[];
  solo: boolean;
  build?: string;
  client?: string;
  items: Record<string, CatalogEntrySpec>;
  stats: Record<string, StatSpec>;
  flags: Record<string, CatalogEntrySpec>;
}

export interface GamePage {
  game: GamePageInfo;
  profile: ProfileData | null;
  boards: Record<string, BoardEntry[]>;
  source: ProfileSource;
}

export function gamePage(library: GameLibrary, profiles: ProfileService, gameId: string, userId: number | undefined): GamePage {
  const build = library.current(gameId);
  if (build === undefined) {
    throw new ProfileError("unknown-game", `The game ${gameId} is not installed on this server`);
  }
  const manifest = build.manifest;
  const solo = isSoloManifest(manifest);
  const source: ProfileSource = solo ? "client" : "server";
  return {
    game: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      ...languagesAndCover(build),
      mode: manifest.mode,
      players: manifest.players,
      roles: Object.keys(manifest.roles),
      solo,
      ...(solo ? { build: build.build, client: clientUrl(build.build) } : {}),
      items: manifest.items ?? {},
      stats: manifest.stats ?? {},
      flags: manifest.flags ?? {},
    },
    profile: userId === undefined ? null : profiles.read(userId, gameId).profile,
    boards: profiles.boards(userId, gameId, manifest, source),
    source,
  };
}
