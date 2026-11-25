import { forgetPages } from "./page-store";
import { useEffect } from "preact/hooks";
import { solo } from "./api";
import { buildUrls, checkTimeoutMs, preloadFiles, type PreloadDom } from "./preload";
import { isSoloGame, type GameInfo, type SoloGameInfo } from "./protocol";
import { SoloStore, type LocalUser } from "./solo-store";
import { SoloSync } from "./solo-sync";
import type { KeyValueStore } from "./storage";

export interface SoloSession {
  store: SoloStore;
  sync: SoloSync;
}

const sessions = new Map<number, SoloSession>();
let queue: Promise<unknown> = Promise.resolve();

export function soloSession(user: LocalUser, storage?: KeyValueStore): SoloSession {
  const existing = sessions.get(user.id);
  if (existing !== undefined) {
    return existing;
  }
  const store = storage === undefined ? new SoloStore(user) : new SoloStore(user, storage);
  const sync = new SoloSync(store, { sync: (game, input) => solo.sync(game, input) }, (game) => store.game(game)?.stats);
  const created = { store, sync };
  sessions.set(user.id, created);
  return created;
}

export function useSoloBackground(user: { id: number; name: string } | undefined): void {
  const id = user?.id;
  const name = user?.name;
  useEffect(() => {
    if (id === undefined || name === undefined) {
      return;
    }
    const session = soloSession({ id, name });
    session.store.remember();
    void session.sync.flush();
    const flush = () => void session.sync.flush();
    addEventListener("online", flush);
    return () => removeEventListener("online", flush);
  }, [id, name]);
}

export function forgetSoloSessions(): void {
  sessions.clear();
}

export function clientPath(build: string): string {
  const at = build.indexOf("@");
  return `/games/${build.slice(0, at)}/${build.slice(at + 1)}/`;
}

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export function rememberGames(session: SoloSession, games: readonly GameInfo[]): SoloGameInfo[] {
  const list = games.filter(isSoloGame);
  session.store.remember();
  session.store.setGames(list);
  return list;
}

export function preloadMissing(session: SoloSession, dom?: PreloadDom): Promise<void> {
  return exclusive(async () => {
    for (const game of session.store.games()) {
      if (session.store.isReady(game.build)) {
        continue;
      }
      try {
        const files = session.store.files(game.build) ?? (await solo.files(game.id));
        if (files.build !== game.build) {
          continue;
        }
        session.store.setFiles(files);
        const result = await preloadFiles(buildUrls(files.client, files.files), dom);
        session.store.setReady(game.build, result.failed.length === 0);
      } catch {
        continue;
      }
    }
  });
}

export function checkOffline(session: SoloSession, game: SoloGameInfo, dom?: PreloadDom): Promise<boolean> {
  return exclusive(async () => {
    const files = session.store.files(game.build);
    if (files === undefined) {
      return false;
    }
    const result = await preloadFiles(buildUrls(files.client, files.files), dom, checkTimeoutMs);
    const ready = result.failed.length === 0;
    session.store.setReady(game.build, ready);
    return ready;
  });
}

export async function signOutDevice(user: LocalUser, timeoutMs = 3000): Promise<void> {
  await signOutSolo(user, timeoutMs);
  forgetPages(user.id);
}

export async function signOutSolo(user: LocalUser, timeoutMs = 3000): Promise<void> {
  const session = soloSession(user);
  await Promise.race([session.sync.flush(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  session.store.release();
  sessions.delete(user.id);
}
