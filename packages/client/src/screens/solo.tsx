import type { PlatformMessage } from "@gamehearth/sdk/platform";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, listGames, solo as soloApi } from "../api";
import { useDeviceSetting } from "../device-setting";
import type { SoloGameInfo, StatSpec } from "../protocol";
import { navigate } from "../router";
import { gameLanguage, tr, useLanguage } from "../language";
import { useSession } from "../session";
import { SoloBridge } from "../solo-bridge";
import { checkOffline, clientPath, rememberGames, soloSession, type SoloSession } from "../solo-service";
import { lastUser, type LocalUser } from "../solo-store";
import { music, musicChannel } from "../music";
import { gameSoundPlayer, sound } from "../sound";
import { errorText, texts } from "../texts";
import { useConfirm } from "../ui/confirm";
import { BoardList, formatStat } from "../ui/boards";
import { useScene } from "../effects";
import { BackIcon } from "../ui/icons";
import { MenuButton } from "../ui/menu";
import { Banner, Page } from "../ui/page";
import { useMusicItem, useSoundItem } from "../ui/switches";
import type { Notify } from "../ui/toasts";

export const preparingTimeoutMs = 4000;

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
export const answerTimeoutMs = 12_000;

type Phase = { name: "preparing" } | { name: "playing" } | { name: "missing" } | { name: "unknown" };

export function SoloScreen({ gameId, notify }: { gameId: string; notify: Notify }) {
  const session = useSession();
  const online = session.me.state === "ready";
  const account = session.user?.kind === "account" ? session.user : undefined;
  const user: LocalUser | undefined = account !== undefined ? { id: account.id, name: account.name } : session.me.state === "offline" ? lastUser() : undefined;

  if (session.me.state === "ready" && account === undefined) {
    return (
      <SoloMessage>
        <p>{session.user === undefined ? texts.soloSignedOut : texts.soloAccountOnly}</p>
      </SoloMessage>
    );
  }
  if (user === undefined) {
    return (
      <SoloMessage>
        <Banner kind="offline" detail={texts.offlineHint}>
          {texts.offline}
        </Banner>
      </SoloMessage>
    );
  }
  return <SoloGame key={`${user.id}:${gameId}`} user={user} gameId={gameId} online={online} notify={notify} />;
}

function SoloMessage({ children }: { children: preact.ComponentChildren }) {
  return (
    <Page class="center">
      <section class="card solo-message">
        {children}
        <button type="button" class="button secondary" onClick={() => navigate("/")}>
          {texts.home}
        </button>
      </section>
    </Page>
  );
}

function SoloGame({ user, gameId, online, notify }: { user: LocalUser; gameId: string; online: boolean; notify: Notify }) {
  const solo = useMemo<SoloSession>(() => soloSession(user), [user.id]);
  const [game, setGame] = useState<SoloGameInfo | undefined>(() => solo.store.game(gameId));
  const [phase, setPhase] = useState<Phase>({ name: "preparing" });
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [silent, setSilent] = useState(false);
  const [round, setRound] = useState(0);
  const [, setVersion] = useState(0);
  const [confirmDialog, confirm] = useConfirm();
  const frame = useRef<HTMLIFrameElement>(null);
  const given = useRef<string | undefined>(undefined);
  const [soundOn] = useDeviceSetting(sound);
  const [musicOn] = useDeviceSetting(music);
  const soundItem = useSoundItem();
  const musicItem = useMusicItem();
  const channel = useMemo(() => musicChannel(), []);
  useEffect(() => () => channel.close(), [channel]);
  useScene("play");

  useEffect(
    () =>
      solo.sync.onChange((changed) => {
        if (changed !== gameId) {
          return;
        }
        setVersion((value) => value + 1);
        if (given.current !== undefined && JSON.stringify(solo.store.saved(gameId) ?? null) !== given.current) {
          given.current = undefined;
          notify(texts.soloNewerSave);
          setAnswered(false);
          setSilent(false);
          setRound((value) => value + 1);
        }
      }),
    [solo, gameId],
  );

  useEffect(() => {
    let active = true;
    const prepare = async () => {
      let current = solo.store.game(gameId);
      let reached = false;
      if (online) {
        try {
          const list = rememberGames(solo, await withTimeout(listGames(), preparingTimeoutMs));
          current = list.find((candidate) => candidate.id === gameId);
          reached = true;
        } catch {
          current = solo.store.game(gameId);
        }
        if (reached && current !== undefined) {
          await Promise.race([solo.sync.sync(gameId), new Promise((resolve) => setTimeout(resolve, preparingTimeoutMs))]);
        }
      }
      if (!reached && current !== undefined && !(await checkOffline(solo, current))) {
        if (active) {
          setGame(current);
          setPhase({ name: "missing" });
        }
        return;
      }
      if (active) {
        setGame(current);
        setPhase(current === undefined ? { name: "unknown" } : { name: "playing" });
      }
    };
    void prepare();
    return () => {
      active = false;
    };
  }, [solo, gameId, online]);

  const { language: uiLanguage } = useLanguage();
  const bridge = useMemo(() => {
    if (game === undefined) {
      return undefined;
    }
    const language = gameLanguage(game.languages);
    return new SoloBridge({
      post: (message: PlatformMessage) => frame.current?.contentWindow?.postMessage(message, "*"),
      stats: game.stats,
      ...(language === undefined ? {} : { language }),
      sound: gameSoundPlayer(),
      soundOn: sound.get(),
      music: (track) => channel.play(track),
      musicOn: music.get(),
      saved: () => solo.store.saved(gameId),
      best: () => solo.store.best(gameId),
      onReady: (saved) => {
        given.current = JSON.stringify(saved ?? null);
      },
      save: (data) => {
        solo.store.save(gameId, data, Date.now());
        given.current = JSON.stringify(data);
        solo.sync.schedule(gameId);
      },
      record: (stat, value) => {
        if (solo.store.record(gameId, stat, value, game.stats[stat] as StatSpec, Date.now())) {
          solo.sync.schedule(gameId);
          setVersion((count) => count + 1);
        }
      },
    });
  }, [game?.build, round, uiLanguage]);

  useEffect(() => {
    bridge?.setAudio(soundOn, musicOn);
  }, [bridge, soundOn, musicOn]);

  useEffect(() => {
    if (bridge === undefined) {
      return;
    }
    const receive = (event: MessageEvent) => {
      if (frame.current !== null && event.source === frame.current.contentWindow) {
        bridge.receive(event.data);
        if (bridge.ready) {
          setAnswered(true);
        }
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [bridge]);

  useEffect(() => {
    if (phase.name !== "playing" || answered) {
      return;
    }
    const timer = setTimeout(() => setSilent(true), answerTimeoutMs);
    return () => clearTimeout(timer);
  }, [phase.name, answered, round]);

  useEffect(() => {
    const flush = () => document.visibilityState === "hidden" && void solo.sync.sync(gameId);
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      void solo.sync.sync(gameId);
    };
  }, [solo, gameId]);

  const restart = () => {
    given.current = undefined;
    setAnswered(false);
    setSilent(false);
    setRound((value) => value + 1);
  };

  const deleteSave = async () => {
    if (!(await confirm(texts.deleteSaveConfirm, texts.deleteSave))) {
      return;
    }
    solo.store.deleteSave(gameId, Date.now());
    void solo.sync.sync(gameId);
    notify(texts.saveDeleted);
    restart();
  };

  const deleteBest = async () => {
    if (!online) {
      notify(texts.deleteBestOffline);
      return;
    }
    if (!(await confirm(texts.deleteBestConfirm, texts.deleteBest))) {
      return;
    }
    try {
      await solo.sync.sync(gameId);
      const view = await soloApi.remove(gameId, "best");
      solo.store.apply(gameId, view, game?.stats ?? {});
      setVersion((value) => value + 1);
      notify(texts.bestDeleted);
      restart();
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
    }
  };

  const openBoards = () => {
    setBoardsOpen(true);
    if (online) {
      void solo.sync.sync(gameId);
    }
  };

  const title = game === undefined ? gameId : tr(game.name, game.languages);
  return (
    <div class="play solo">
      <header class="bar">
        <button type="button" class="icon-button" aria-label={texts.home} onClick={() => navigate("/")}>
          <BackIcon />
        </button>
        <div class="title">
          <strong>{title}</strong>
          <span>{online ? texts.soloLabel : `${texts.soloLabel} · ${texts.offlineShort}`}</span>
        </div>
        {game !== undefined && Object.keys(game.stats).length > 0 && (
          <button type="button" class="button small secondary" onClick={openBoards}>
            {texts.boards}
          </button>
        )}
        <MenuButton
          items={[
            { label: texts.restart, onSelect: restart },
            { label: texts.deleteSave, onSelect: () => void deleteSave(), danger: true },
            game !== undefined && Object.keys(game.stats).length > 0 && { label: texts.deleteBest, onSelect: () => void deleteBest(), danger: true },
            soundItem,
            musicItem,
            { label: texts.home, onSelect: () => navigate("/") },
          ]}
        />
      </header>
      <div class="stage">
        {phase.name === "playing" && game !== undefined && (
          <iframe
            ref={frame}
            key={`${game.build}#${round}#${uiLanguage}`}
            src={clientPath(game.build)}
            title={tr(game.name, game.languages)}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            allow=""
          />
        )}
        {phase.name === "preparing" && (
          <div class="overlay">
            <span class="spinner" aria-hidden="true" />
            {texts.soloPreparing}
          </div>
        )}
        {phase.name === "playing" && !answered && !silent && (
          <div class="overlay">
            <span class="spinner" aria-hidden="true" />
            {texts.gameLoading}
          </div>
        )}
        {phase.name === "playing" && !answered && silent && (
          <div class="overlay" role="alert">
            {texts.soloNoAnswer}
          </div>
        )}
        {phase.name === "missing" && (
          <div class="overlay" role="alert">
            {texts.soloMissing}
          </div>
        )}
        {phase.name === "unknown" && (
          <div class="overlay" role="alert">
            {texts.soloUnknown}
          </div>
        )}
      </div>
      {boardsOpen && game !== undefined && <Boards solo={solo} game={game} online={online} onClose={() => setBoardsOpen(false)} />}
      {confirmDialog}
    </div>
  );
}

function Boards({ solo, game, online, onClose }: { solo: SoloSession; game: SoloGameInfo; online: boolean; onClose: () => void }) {
  const best = solo.store.best(game.id);
  const boards = solo.store.boards(game.id);
  const pending = solo.store.pending(game.id)?.best ?? {};
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div class="modal boards" role="dialog" aria-modal="true" aria-labelledby="boards-title">
        <h2 id="boards-title">{texts.boardsTitle(tr(game.name, game.languages))}</h2>
        {!online && <p class="muted small">{texts.boardOffline}</p>}
        {Object.entries(game.stats).map(([stat, spec]) => (
          <section key={stat} data-stat={stat}>
            <h3>{tr(spec.label, game.languages)}</h3>
            <p class="small">
              {texts.yourBest}: <strong>{Object.hasOwn(best, stat) ? formatStat(best[stat] as number, spec) : "–"}</strong>
              {Object.hasOwn(pending, stat) && <span class="muted"> · {texts.boardPending}</span>}
            </p>
            <BoardList entries={Object.hasOwn(boards, stat) ? (boards[stat] ?? []) : []} spec={spec} />
          </section>
        ))}
        <div class="actions">
          <button type="button" class="button" onClick={onClose}>
            {texts.close}
          </button>
        </div>
      </div>
    </div>
  );
}

export { formatStat };
