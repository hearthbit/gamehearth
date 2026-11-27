import { afterEach, describe, expect, it, vi } from "vitest";
import { createMusicPlayer, musicInstruments, musicLookaheadSeconds, musicPeakGain, type MusicInstrument, type MusicPlayer, type MusicTrack } from "../src/platform";
import { FakeContext, FakeOscillator, FakeSource } from "./fake-audio";

function chord(freq: number, instrument: MusicInstrument = "organ"): MusicTrack {
  return { bpm: 60, beats: 60, voices: [{ instrument, notes: Array.from({ length: 24 }, (_, index) => ({ freq: freq + index, at: 0, length: 60 })) }] };
}

const first = chord(200);
const second = chord(300);

function setup(): { context: FakeContext; player: MusicPlayer; advance(seconds: number, each?: () => void): void } {
  const context = new FakeContext();
  const player = createMusicPlayer({ context: () => context, timers: { setInterval: () => 1, clearInterval: () => undefined } });
  const advance = (seconds: number, each?: () => void) => {
    const end = context.currentTime + seconds;
    while (context.currentTime < end - 1e-9) {
      context.currentTime = Math.round((context.currentTime + 0.016) * 1000) / 1000;
      each?.();
      player.tick();
    }
  };
  return { context, player, advance };
}

function sounding(context: FakeContext): (FakeOscillator | FakeSource)[] {
  return context.started.filter((node) => (node.stopAt ?? Number.POSITIVE_INFINITY) > context.currentTime + 1e-9 && !node.disconnected);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Review 17: music player", () => {
  it("applies the first change at once and only the latest of a burst after 300 ms", () => {
    const { context, player, advance } = setup();
    for (let index = 0; index < 200; index++) {
      player.play(index % 2 === 0 ? first : second);
    }
    expect(context.connected()).toHaveLength(1);
    expect(context.oscillators()).toHaveLength(24);
    expect(player.track?.voices[0]?.notes[0]?.freq).toBe(300);
    advance(0.25);
    expect(context.connected()).toHaveLength(1);
    advance(0.1);
    expect(context.connected()).toHaveLength(2);
    expect(context.oscillators()).toHaveLength(48);
    expect(sounding(context).filter((node) => node instanceof FakeOscillator && node.freq >= 300)).toHaveLength(24);
  });

  it("keeps at most two tracks and their notes alive when the game switches every frame", () => {
    const { context, player, advance } = setup();
    let frame = 0;
    advance(10, () => {
      frame += 1;
      player.play(frame % 2 === 0 ? first : second);
      expect(context.connected().length).toBeLessThanOrEqual(2);
      expect(sounding(context).length).toBeLessThanOrEqual(48);
    });
    expect(context.oscillators().length).toBeLessThanOrEqual(24 * Math.ceil(10 / 0.3 + 1));
  });

  it("drops a track beyond the one that fades at once: its notes stop and it is disconnected in the same call", () => {
    const { context, player, advance } = setup();
    player.play(first);
    advance(0.4);
    player.play(second);
    advance(0.4);
    const [old] = context.outs();
    expect(old?.disconnected).toBe(false);
    player.play(chord(400));
    expect(old?.disconnected).toBe(true);
    const oldNotes = context.oscillators().filter((node) => node.freq < 300);
    expect(oldNotes.every((node) => node.disconnected && (node.stopAt ?? Number.POSITIVE_INFINITY) <= context.currentTime + 1e-9)).toBe(true);
  });

  it("stops every scheduled note of a track when its fade ends", () => {
    const { context, player, advance } = setup();
    player.play({ bpm: 120, beats: 4, voices: [{ instrument: "sine", notes: [{ freq: 440, at: 0, length: 4 }] }] });
    advance(0.5);
    player.play(null);
    advance(1.2);
    expect(context.connected()).toEqual([]);
    expect(context.started.length).toBeGreaterThan(0);
    expect(sounding(context)).toEqual([]);
  });

  it("schedules 1.5 seconds ahead, so a stalled main thread of up to about 1.4 seconds drops no notes", () => {
    expect(musicLookaheadSeconds).toBe(1.5);
    const { context, player } = setup();
    player.play({ bpm: 120, beats: 4, voices: [{ instrument: "sine", notes: [0, 1, 2, 3].map((at) => ({ freq: 440, at, length: 0.5 })) }] });
    expect(context.oscillators().map((node) => Math.round(node.startAt * 1000) / 1000)).toEqual([0.05, 0.55, 1.05]);
  });

  it("puts all music through one gain and a limiter in front of the speakers", () => {
    const { context, player } = setup();
    player.play(first);
    player.play(null);
    const [compressor] = context.compressors;
    expect(context.compressors).toHaveLength(1);
    expect(compressor?.outputs).toEqual([context.destination]);
    expect(compressor?.threshold.events.at(-1)?.[1]).toBe(-6);
    expect(compressor?.ratio.events.at(-1)?.[1]).toBe(20);
    expect(context.master()).toBeDefined();
    expect(context.outs().every((out) => out.outputs.includes(context.master() as never))).toBe(true);
  });

  it("keeps every instrument at or below the documented peak of 0.05 × voice volume × note volume", () => {
    for (const instrument of musicInstruments) {
      const context = new FakeContext();
      const player = createMusicPlayer({ context: () => context, timers: { setInterval: () => 1, clearInterval: () => undefined } });
      player.play({ bpm: 60, beats: 2, voices: [{ instrument, volume: 1, notes: [{ freq: 440, at: 0, length: 1 }] }] });
      const outs = context.outs();
      const master = context.master();
      const envelopes = context.gains.filter((gain) => !outs.includes(gain) && gain !== master);
      const peak = envelopes.reduce((sum, gain) => sum + Math.max(0, ...gain.gain.events.filter((event) => event[0] !== "cancel").map((event) => event[1])), 0);
      expect(peak, instrument).toBeLessThanOrEqual(musicPeakGain + 1e-12);
      for (const filter of context.filters.filter((node) => node.type === "lowpass")) {
        expect(filter.Q.events[0]?.[1], instrument).toBeLessThanOrEqual(0);
      }
    }
  });

  it("passes Float32Arrays to createPeriodicWave", () => {
    const { context, player } = setup();
    player.play(chord(200));
    expect(context.waveArguments[0]?.every((part) => part instanceof Float32Array)).toBe(true);
  });

  it("skips a note whose synthesis throws and says so once on the console", () => {
    const error = vi.spyOn((globalThis as unknown as { console: { error(message: string): void } }).console, "error").mockImplementation(() => undefined);
    const { context, player, advance } = setup();
    context.failOscillators = true;
    expect(() => player.play(chord(200, "sine"))).not.toThrow();
    expect(() => advance(3)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Music: a note could not be played/));
    context.failOscillators = false;
    player.play(chord(300, "sine"));
    advance(0.5);
    expect(context.oscillators().length).toBeGreaterThan(0);
  });
});
