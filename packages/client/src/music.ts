import { createMusicPlayer, type MusicPlayer, type MusicTrack } from "@gamehearth/sdk/platform";
import { deviceSetting } from "./device-setting";
import { audioContext, noteGesture, resumeAudio, sound, unlocked } from "./sound";

export const music = deviceSetting("gamehearth.music", true);
export const musicUnlockPollMs = 250;

export interface MusicChannel {
  play(track: MusicTrack | null): void;
  close(): void;
}

interface Owner {
  track: MusicTrack | null;
}

let player: MusicPlayer | undefined;
let owner: Owner | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let removeListeners: (() => void) | undefined;

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function wanted(): MusicTrack | null {
  const track = owner?.track ?? null;
  return track !== null && sound.get() && music.get() ? track : null;
}

function waitForUnlock(waiting: boolean): void {
  if (waiting && poll === undefined) {
    poll = setInterval(refresh, musicUnlockPollMs);
  } else if (!waiting && poll !== undefined) {
    clearInterval(poll);
    poll = undefined;
  }
}

function refresh(): void {
  const track = wanted();
  const ready = track === null || unlocked();
  waitForUnlock(!ready);
  if (!ready) {
    return;
  }
  if (player === undefined) {
    if (track === null) {
      return;
    }
    player = createMusicPlayer({ context: audioContext });
  }
  const paused = hidden();
  if (track !== null && !paused) {
    resumeAudio();
  }
  player.setPaused(paused);
  player.play(track);
}

function listen(): void {
  if (removeListeners !== undefined || typeof document === "undefined") {
    return;
  }
  const unsubscribe = [sound.subscribe(refresh), music.subscribe(refresh)];
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("pointerdown", refresh, { capture: true });
  document.addEventListener("keydown", refresh, { capture: true });
  removeListeners = () => {
    for (const stop of unsubscribe) {
      stop();
    }
    document.removeEventListener("visibilitychange", refresh);
    document.removeEventListener("pointerdown", refresh, { capture: true });
    document.removeEventListener("keydown", refresh, { capture: true });
  };
}

export function musicChannel(): MusicChannel {
  listen();
  const mine: Owner = { track: null };
  return {
    play(track) {
      mine.track = track;
      owner = mine;
      refresh();
    },
    close() {
      mine.track = null;
      if (owner === mine) {
        owner = undefined;
        refresh();
      }
    },
  };
}

export function playingTrack(): MusicTrack | null {
  return player?.paused === true ? null : (player?.track ?? null);
}

export function toggleMusic(on: boolean): void {
  if (on) {
    noteGesture();
    if (sound.get()) {
      resumeAudio();
    }
  }
  music.set(on);
}

export function stopMusic(): void {
  player?.stop();
  player = undefined;
  owner = undefined;
  waitForUnlock(false);
  removeListeners?.();
  removeListeners = undefined;
}
