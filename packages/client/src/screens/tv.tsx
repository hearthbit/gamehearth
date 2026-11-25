import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PlatformMessage } from "@gamehearth/sdk/platform";
import { ensureScreenDevice } from "../api";
import { RoomConnection, socketUrl, type ConnectionState } from "../connection";
import { useDeviceSetting } from "../device-setting";
import { GameBridge } from "../game-bridge";
import { roomPath } from "../router";
import type { Pairing, ScreenView } from "../protocol";
import { memberName, tr, useLanguage } from "../language";
import { gameSoundPlayer, sound } from "../sound";
import { texts } from "../texts";
import { useWakeLock } from "../turn";
import { LiveOverlay, awayNames } from "../ui/live";
import { optionText } from "../ui/options";
import { QrCode } from "../ui/qr";
import { LanguageSwitch } from "../ui/language-switch";
import { ThemeSwitch } from "../ui/theme-switch";
import { SoundSwitch } from "../ui/switches";
import { useScene } from "../effects";
import { gameColor } from "../ui/cover";
import { Loading } from "../ui/page";

const renewBeforeMs = 30_000;

export interface TvScreenProps {
  createConnection?: (handlers: Pick<ConstructorParameters<typeof RoomConnection>[0], "onState" | "onNotice">) => RoomConnection;
  prepare?: () => Promise<void>;
}

function defaultConnection(handlers: Pick<ConstructorParameters<typeof RoomConnection>[0], "onState" | "onNotice">): RoomConnection {
  return new RoomConnection({ code: "", url: socketUrl(location), screen: true, ...handlers });
}

export function TvScreen({ createConnection = defaultConnection, prepare = ensureScreenDevice }: TvScreenProps) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting", room: undefined, fatal: undefined });
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const connection = useRef<RoomConnection | undefined>(undefined);
  useWakeLock(true);

  useEffect(() => {
    document.title = `${texts.tvTitle} · ${texts.appName}`;
    let active = true;
    setFailed(false);
    prepare().then(
      () => {
        if (!active) {
          return;
        }
        const created = createConnection({ onState: setState, onNotice: () => undefined });
        connection.current = created;
        created.start();
      },
      () => active && setFailed(true),
    );
    return () => {
      active = false;
      connection.current?.dispose();
      connection.current = undefined;
    };
  }, [attempt]);

  useEffect(() => {
    if (state.fatal?.code === "no-device") {
      setAttempt((value) => value + 1);
    }
  }, [state.fatal]);

  useEffect(() => {
    const pairing = state.pairing;
    if (pairing === undefined) {
      return;
    }
    const remaining = pairing.expiresInMs ?? pairing.expiresAt - Date.now();
    const timer = setTimeout(() => connection.current?.reconnectNow(), Math.max(1000, remaining - renewBeforeMs));
    return () => clearTimeout(timer);
  }, [state.pairing]);

  useEffect(() => {
    const online = () => connection.current?.reconnectNow();
    addEventListener("online", online);
    return () => removeEventListener("online", online);
  }, []);

  const online = state.status === "online";
  if (failed || (state.fatal !== undefined && state.fatal.code !== "no-device")) {
    return (
      <main class="tv center">
        <p class="tv-hint">{texts.offline}</p>
        <button type="button" class="button" onClick={() => setAttempt((value) => value + 1)}>
          {texts.retry}
        </button>
      </main>
    );
  }
  if (state.screen !== undefined) {
    return state.screen.status === "lobby" ? <TvLobby room={state.screen} online={online} /> : <TvGame room={state.screen} online={online} />;
  }
  if (state.pairing !== undefined) {
    return <TvPairing pairing={state.pairing} online={online} />;
  }
  return (
    <main class="tv center">
      <Loading />
    </main>
  );
}

function TvPairing({ pairing, online }: { pairing: Pairing; online: boolean }) {
  const raw = pairing.code.replace(/-/g, "");
  return (
    <main class="tv pairing" data-testid="tv-pairing">
      <div class="tv-side">
        <div class="tv-top">
          <h1 class="tv-title">{texts.tvTitle}</h1>
          <LanguageSwitch />
          <ThemeSwitch compact />
          <SoundSwitch />
        </div>
        <p class="tv-hint">{texts.tvPairHint}</p>
        <p class="tv-code" data-testid="tv-code">
          {pairing.code}
        </p>
        {!online && <p class="tv-hint">{texts.reconnecting}</p>}
      </div>
      <div class="tv-qr">
        <QrCode text={`${location.origin}/pair#${raw}`} label={texts.tvPairQr} />
      </div>
    </main>
  );
}

function TvLobby({ room, online }: { room: ScreenView; online: boolean }) {
  const link = `${location.origin}${roomPath(room.code)}`;
  const host = room.members.find((member) => member.host);
  return (
    <main class="tv lobby" data-testid="tv-lobby" style={{ "--tone": gameColor(room.game.id) }}>
      <div class="tv-side">
        <h1 class="tv-title game">{tr(room.game.name, room.game.languages)}</h1>
        <p class="tv-hint">{texts.tvJoinHint}</p>
        <p class="tv-code" data-testid="tv-room-code">
          {room.code}
        </p>
        <p class="tv-host">{location.host}</p>
        <ul class="tv-members">
          {room.members.map((member) => (
            <li key={member.id}>
              {member.bot === undefined && <span class={member.connected ? "dot" : "dot off"} aria-hidden="true" />}
              {memberName(member)}
            </li>
          ))}
        </ul>
        {room.options !== undefined && (
          <dl class="tv-options" data-testid="tv-options">
            {Object.entries(room.options.spec).map(([name, option]) => (
              <div key={name}>
                <dt>{tr(option.label, room.game.languages)}</dt>
                <dd>{optionText(option, room.options?.values[name], room.game.languages)}</dd>
              </div>
            ))}
          </dl>
        )}
        <p class="tv-hint">{texts.waitingForHost(host?.name ?? texts.host)}</p>
        {!online && <p class="tv-hint">{texts.reconnecting}</p>}
      </div>
      <div class="tv-qr">
        <QrCode text={link} label={texts.qrLabel(room.code)} />
      </div>
    </main>
  );
}

function TvGame({ room, online }: { room: ScreenView; online: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const finished = room.status === "finished";
  const host = room.members.find((member) => member.host);
  const away = finished ? [] : awayNames(room);
  const [soundOn] = useDeviceSetting(sound);
  useScene("play");
  const bridge = useMemo(
    () =>
      new GameBridge({
        post: (message: PlatformMessage) => frame.current?.contentWindow?.postMessage(message, "*"),
        move: () => Promise.resolve({ ok: false, code: "screen", message: texts.screenCannotMove }),
        sound: gameSoundPlayer(),
        soundOn: sound.get(),
      }),
    [],
  );

  useEffect(() => {
    bridge.setSound(soundOn);
  }, [bridge, soundOn]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (frame.current !== null && event.source === frame.current.contentWindow) {
        bridge.receive(event.data);
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [bridge]);

  const { language } = useLanguage();
  useLayoutEffect(() => {
    bridge.update(room, online);
  }, [room, online, bridge, language]);

  return (
    <div class="tv game" data-testid="tv-game">
      <div class="stage">
        <iframe
          ref={frame}
          key={`${room.game.client}#${room.round}#${language}`}
          src={room.game.client}
          title={tr(room.game.name, room.game.languages)}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          allow=""
          onLoad={() => setLoaded(true)}
        />
        {!loaded && (
          <div class="overlay">
            <span class="spinner" aria-hidden="true" />
            {texts.gameLoading}
          </div>
        )}
        {loaded && !online && (
          <div class="overlay" role="status">
            <span class="spinner" aria-hidden="true" />
            {texts.reconnecting}
          </div>
        )}
        {loaded && online && !finished && <LiveOverlay live={room.live} members={room.members} />}
      </div>
      <footer class="strip">
        <strong class="grow">
          {tr(room.game.name, room.game.languages)} · {texts.roomCode} {room.code}
        </strong>
        {away.length > 0 && <span class="away">{texts.awaySeats(away.join(", "))}</span>}
        {finished && <span>{texts.waitingForNewRound(host?.name ?? texts.host)}</span>}
      </footer>
    </div>
  );
}
