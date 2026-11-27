import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MoveResult, PlatformMessage } from "@gamehearth/sdk/platform";
import { useDeviceSetting } from "../device-setting";
import { GameBridge } from "../game-bridge";
import type { MemberView } from "../protocol";
import { navigate } from "../router";
import { memberName, robotSign, tr, useLanguage } from "../language";
import { music, musicChannel } from "../music";
import { gameSoundPlayer, sound } from "../sound";
import { errorText, texts } from "../texts";
import { isMyTurn } from "../turn";
import { useConfirm } from "../ui/confirm";
import { useScene } from "../effects";
import { BackIcon } from "../ui/icons";
import { LiveOverlay, awayNames, canHandOver } from "../ui/live";
import { MenuButton, type MenuItem } from "../ui/menu";
import { toggleMute } from "../ui/push";
import { useMusicItem, useSoundItem } from "../ui/switches";
import type { RoomScreenChildProps } from "./lobby";

const silentCodes = new Set(["stale", "illegal-move", "not-your-turn", "game-over", "paused", "too-many-inputs", "not-running", "bot-playing"]);

export function Play({ room, online, command, notify, onLeave }: RoomScreenChildProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const realtimeRef = useRef(false);
  realtimeRef.current = room.snapshot?.tick !== undefined;
  const [loaded, setLoaded] = useState(false);
  useScene("play");
  const [confirmDialog, confirm] = useConfirm();
  const host = room.members.find((member) => member.host);
  const finished = room.status === "finished";
  const removed = room.installed === false;
  const myTurn = isMyTurn(room);
  const live = room.live;
  const canPause = room.you.host && live !== undefined && (live.state === "running" || live.state === "countdown");
  const running = room.status === "running";
  const bots = room.game.bots === true && running;
  const autopilot = running && room.you.autopilot === true;
  const autopilotRef = useRef(false);
  autopilotRef.current = autopilot;
  const away = finished ? [] : awayNames(room);
  const [soundOn] = useDeviceSetting(sound);
  const [musicOn] = useDeviceSetting(music);
  const soundItem = useSoundItem();
  const musicItem = useMusicItem();
  const channel = useMemo(() => musicChannel(), []);
  useEffect(() => () => channel.close(), [channel]);

  const bridge = useMemo(
    () =>
      new GameBridge({
        post: (message: PlatformMessage) => frame.current?.contentWindow?.postMessage(message, "*"),
        move: async (action, expectedVersion): Promise<MoveResult> => {
          if (autopilotRef.current) {
            return { ok: false, code: "bot-playing", message: "A bot is playing your seat; take it back first" };
          }
          const result = await command({ type: "move", action, expectedVersion });
          if (!result.ok && !silentCodes.has(result.code) && !(result.code === "rate-limited" && realtimeRef.current)) {
            notify(errorText(result.code, result.message));
          }
          return result;
        },
        sound: gameSoundPlayer(),
        soundOn: sound.get(),
        music: (track) => channel.play(track),
        musicOn: music.get(),
      }),
    [],
  );

  useEffect(() => {
    bridge.setAudio(soundOn && !autopilot, musicOn);
  }, [bridge, soundOn, musicOn, autopilot]);

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

  const run = async (next: Parameters<typeof command>[0]) => {
    const result = await command(next);
    if (!result.ok) {
      notify(errorText(result.code, result.message));
    }
  };

  const abort = async () => {
    if (await confirm(removed ? texts.abortRemovedConfirm : texts.abortConfirm, texts.abort)) {
      await run({ type: "abort" });
    }
  };

  const leave = async () => {
    if (await confirm(texts.leaveConfirm, texts.leave)) {
      await onLeave();
    }
  };

  const handOverSelf = async () => {
    if (await confirm(texts.handOverSelfConfirm, texts.handOverSelfConfirmLabel)) {
      await run({ type: "hand-over", member: room.you.id });
    }
  };

  const handOver = async (member: MemberView) => {
    const name = memberName(member);
    if (await confirm(member.deleted ? texts.handOverDeletedConfirm : texts.handOverConfirm(name), texts.handOverConfirmLabel)) {
      await run({ type: "hand-over", member: member.id });
    }
  };

  const handOverItems: MenuItem[] =
    bots && room.you.host ? room.members.filter(canHandOver).map((member) => ({ label: texts.handOver(memberName(member)), onSelect: () => void handOver(member) })) : [];

  return (
    <div class="play">
      <header class="bar">
        <button type="button" class="icon-button" aria-label={texts.home} onClick={() => navigate("/")}>
          <BackIcon />
        </button>
        <div class="title">
          <strong>{tr(room.game.name, room.game.languages)}</strong>
          <span>
            {texts.roomCode} {room.code}
            {room.round > 1 ? ` · ${texts.round(room.round)}` : ""}
            {away.length > 0 && <span class="away"> · {texts.awaySeats(away.join(", "))}</span>}
          </span>
        </div>
        {myTurn && <span class="turn">{texts.yourTurn}</span>}
        <span class={online ? "dot" : "dot off"} title={online ? undefined : texts.reconnecting} aria-hidden="true" />
        <MenuButton
          items={[
            canPause && { label: texts.pause, onSelect: () => void run({ type: "pause" }) },
            autopilot && room.you.host && live !== undefined && (live.state === "paused" || live.state === "halted") && { label: texts.resume, onSelect: () => void run({ type: "resume" }) },
            bots && room.you.seat !== null && !autopilot && { label: texts.handOverSelf, onSelect: () => void handOverSelf() },
            ...handOverItems,
            room.you.host && !finished && { label: texts.abort, onSelect: () => void abort(), danger: true },
            room.you.host && finished && !removed && { label: texts.newRound, onSelect: () => void run({ type: "new-round" }) },
            finished && { label: texts.leave, onSelect: () => void leave() },
            soundItem,
            musicItem,
            { label: room.muted === true ? texts.unmute : texts.mute, onSelect: () => void toggleMute(room.code, room.muted !== true, notify) },
            { label: texts.home, onSelect: () => navigate("/") },
          ]}
        />
      </header>
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
        {loaded && online && !finished && !autopilot && (
          <LiveOverlay
            live={live}
            members={room.members}
            host={room.you.host}
            online={online}
            bots={bots}
            onResume={() => void run({ type: "resume" })}
            onAbort={() => void abort()}
            onHandOver={(member) => void handOver(member)}
          />
        )}
        {online && autopilot && (
          <div class="overlay autopilot" role="status" data-testid="autopilot">
            <span class="autopilot-sign" aria-hidden="true">
              {robotSign}
            </span>
            <strong>{texts.autopilot}</strong>
            <span class="small">{texts.autopilotHint}</span>
            <button type="button" class="button" onClick={() => void run({ type: "take-back" })}>
              {texts.takeBack}
            </button>
          </div>
        )}
      </div>
      {removed && (
        <footer class="strip" role="status">
          <span class="grow small">{finished ? texts.gameRemovedFinished : texts.gameRemovedRunning}</span>
          {finished && (
            <button type="button" class="button small secondary" disabled={!online} onClick={() => void leave()}>
              {texts.leave}
            </button>
          )}
        </footer>
      )}
      {finished && !removed && (
        <footer class="strip">
          <strong>{texts.finished}</strong>
          {room.you.host ? (
            <button type="button" class="button small" disabled={!online} onClick={() => void run({ type: "new-round" })}>
              {texts.newRound}
            </button>
          ) : (
            <span class="muted small">{texts.waitingForNewRound(host?.name ?? texts.host)}</span>
          )}
        </footer>
      )}
      {confirmDialog}
    </div>
  );
}
