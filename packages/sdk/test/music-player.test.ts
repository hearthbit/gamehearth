import { describe, expect, it } from "vitest";
import { createMusicPlayer, musicCrossfadeSeconds, musicPeakGain, type MusicPlayer, type MusicTrack } from "../src/platform";
import { FakeContext, FakeOscillator, FakeSource, type FakeGain } from "./fake-audio";

const scale: MusicTrack = {
  name: "Scale",
  bpm: 120,
  beats: 4,
  voices: [
    {
      instrument: "sine",
      notes: [
        { freq: 440, at: 0, length: 0.5 },
        { freq: 550, at: 1, length: 0.5 },
        { freq: 660, at: 2, length: 0.5 },
        { freq: 770, at: 3, length: 0.5 },
      ],
    },
  ],
};

const other: MusicTrack = { bpm: 60, beats: 2, voices: [{ instrument: "triangle", notes: [{ freq: 330, at: 0, length: 1 }] }] };

function setup(): { context: FakeContext; player: MusicPlayer; timers: { running: number; set: number }; advance(to: number): void } {
  const context = new FakeContext();
  const timers = { running: 0, set: 0 };
  const player = createMusicPlayer({
    context: () => context,
    timers: {
      setInterval: () => {
        timers.running += 1;
        timers.set += 1;
        return timers.set;
      },
      clearInterval: () => {
        timers.running -= 1;
      },
    },
  });
  const advance = (to: number) => {
    while (context.currentTime < to - 1e-9) {
      context.currentTime = Math.min(to, Math.round((context.currentTime + 0.1) * 1000) / 1000);
      player.tick();
    }
  };
  return { context, player, timers, advance };
}

function starts(context: FakeContext, freq?: number): number[] {
  return context
    .oscillators()
    .filter((node) => freq === undefined || node.freq === freq)
    .map((node) => Math.round(node.startAt * 1000) / 1000);
}

function lastRamp(gain: FakeGain): [string, number, number] | undefined {
  const ramp = gain.gain.events.filter((event) => event[0] === "linear").at(-1);
  return ramp === undefined ? undefined : [ramp[0], ramp[1], Math.round(ramp[2] * 1000) / 1000];
}

describe("Music player", () => {
  it("loops the track sample-accurately on the audio clock, a lookahead ahead", () => {
    const { context, player, timers, advance } = setup();
    context.currentTime = 10;
    player.play(scale);
    expect(timers.running).toBe(1);
    expect(starts(context)).toEqual([10.05, 10.55, 11.05]);
    expect((context.oscillators()[0] as FakeOscillator).stopAt).toBeCloseTo(10.05 + 0.25 + 0.02);
    advance(14.2);
    expect(starts(context)).toEqual([10.05, 10.55, 11.05, 11.55, 12.05, 12.55, 13.05, 13.55, 14.05, 14.55, 15.05, 15.55]);
    expect(starts(context, 440)).toEqual([10.05, 12.05, 14.05]);
    const first = context.oscillators()[0] as FakeOscillator;
    expect(first.type).toBe("sine");
    expect(first.disconnected).toBe(true);
    expect(player.track).toEqual({ ...scale, voices: [{ instrument: "sine", volume: 0.5, notes: scale.voices[0]?.notes.map((note) => ({ ...note, volume: 1 })) }] });
  });

  it("mixes music quieter than sounds: voice volume × note volume × 0.05", () => {
    const { context, player } = setup();
    player.play({ bpm: 120, beats: 1, voices: [{ instrument: "sine", notes: [{ freq: 440, at: 0, length: 1 }, { freq: 880, at: 0, length: 1, volume: 0.5 }] }, { instrument: "sine", volume: 0, notes: [{ freq: 220, at: 0, length: 1 }] }] });
    expect(musicPeakGain).toBe(0.05);
    const envelopes = context.gains.filter((gain) => !context.outs().includes(gain) && gain !== context.master());
    expect(envelopes.slice(0, 2).map((gain) => gain.gain.events.find((event) => event[0] === "linear")?.[1])).toEqual([0.025, 0.0125]);
    expect(starts(context, 220)).toEqual([]);
  });

  it("keeps playing the same track, also as a deep-equal copy with defaults written out", () => {
    const { context, player, advance } = setup();
    player.play(scale);
    advance(1);
    player.play(JSON.parse(JSON.stringify({ ...scale, voices: [{ ...scale.voices[0], volume: 0.5 }] })) as MusicTrack);
    expect(context.outs()).toHaveLength(1);
    advance(2.2);
    expect(starts(context)).toEqual([0.05, 0.55, 1.05, 1.55, 2.05, 2.55, 3.05, 3.55]);
  });

  it("crossfades for a second to a different track, then lets the old one go", () => {
    const { context, player, advance } = setup();
    player.play(scale);
    advance(1);
    player.play(other);
    const [old, next] = context.outs() as [FakeGain, FakeGain];
    expect(lastRamp(old)).toEqual(["linear", 0, 1 + musicCrossfadeSeconds]);
    expect(lastRamp(next)).toEqual(["linear", 1, 1.05 + musicCrossfadeSeconds]);
    expect(starts(context, 330)).toEqual([1.05]);
    advance(1.9);
    expect(starts(context, 770)).toEqual([1.55]);
    expect(starts(context, 440)).toEqual([0.05, 2.05]);
    expect(old.disconnected).toBe(false);
    advance(2.2);
    expect(old.disconnected).toBe(true);
    expect(starts(context, 440)).toEqual([0.05, 2.05]);
    expect(context.oscillators().find((node) => node.startAt > 2)?.stopAt).toBeLessThanOrEqual(2.1);
    expect(next.disconnected).toBe(false);
    expect(player.track?.beats).toBe(2);
  });

  it("fades out with null and stops scheduling and the timer afterwards", () => {
    const { context, player, timers, advance } = setup();
    player.play(scale);
    advance(1);
    player.play(null);
    expect(player.track).toBeNull();
    const [out] = context.outs() as [FakeGain];
    expect(lastRamp(out)).toEqual(["linear", 0, 2]);
    advance(2.3);
    expect(out.disconnected).toBe(true);
    expect(timers.running).toBe(0);
    const count = context.started.length;
    advance(6);
    expect(context.started).toHaveLength(count);
    player.play(null);
    expect(context.outs()).toHaveLength(1);
  });

  it("keeps at most one fading track, so quick changes do not pile up", () => {
    const { context, player, advance } = setup();
    player.play(scale);
    advance(0.5);
    player.play(other);
    advance(0.7);
    player.play({ ...other, bpm: 90 });
    expect(context.outs()).toHaveLength(2);
    advance(0.9);
    const [first, second, third] = context.outs() as [FakeGain, FakeGain, FakeGain];
    expect(first.disconnected).toBe(true);
    expect(lastRamp(second)).toEqual(["linear", 0, 1.8]);
    expect(second.disconnected).toBe(false);
    expect(lastRamp(third)?.[1]).toBe(1);
  });

  it("pauses where it is and resumes there, without scheduling anything in between", () => {
    const { context, player, timers, advance } = setup();
    player.play(scale);
    advance(3.3);
    player.setPaused(true);
    expect(player.paused).toBe(true);
    const [out] = context.outs() as [FakeGain];
    expect(lastRamp(out)).toEqual(["linear", 0, 3.4]);
    advance(3.6);
    const count = context.started.length;
    advance(10);
    expect(context.started).toHaveLength(count);
    expect(timers.running).toBe(0);
    player.setPaused(false);
    const resumed = context.outs().at(-1) as FakeGain;
    expect(lastRamp(resumed)).toEqual(["linear", 1, 10.35]);
    expect(starts(context).slice(count)).toEqual([10.3, 10.8, 11.3]);
    expect(context.oscillators().slice(count).map((node) => node.freq)).toEqual([770, 440, 550]);
  });

  it("remembers a track chosen while paused and starts it when unpaused", () => {
    const { context, player } = setup();
    player.setPaused(true);
    player.play(scale);
    expect(context.outs()).toEqual([]);
    player.setPaused(false);
    expect(starts(context)).toEqual([0.05, 0.55, 1.05]);
  });

  it("does not create an audio context for nothing", () => {
    let asked = 0;
    const player = createMusicPlayer({ context: () => ((asked += 1), undefined) });
    player.play(null);
    player.setPaused(true);
    player.setPaused(false);
    expect(asked).toBe(0);
    player.play(scale);
    expect(asked).toBe(1);
  });

  it("catches up after the main thread stalled instead of playing every missed note", () => {
    const { context, player } = setup();
    player.play(scale);
    player.tick();
    context.currentTime = 30.2;
    player.tick();
    expect(starts(context).filter((time) => time > 2)).toEqual([30.55, 31.05, 31.55]);
  });

  it("builds each instrument from oscillators, filters and noise", () => {
    const { context, player } = setup();
    player.play({
      bpm: 60,
      beats: 4,
      voices: [
        { instrument: "musicbox", notes: [{ freq: 500, at: 0, length: 0.25 }] },
        { instrument: "organ", notes: [{ freq: 300, at: 0, length: 0.25, to: 330 }] },
        { instrument: "pluck", notes: [{ freq: 200, at: 0, length: 0.25 }] },
        { instrument: "noise", notes: [{ freq: 1200, at: 0, length: 0.25, to: 600 }] },
      ],
    });
    const oscillators = context.oscillators();
    expect(oscillators.map((node) => [node.type, node.freq])).toEqual([
      ["sine", 500],
      ["sine", 2000],
      ["custom", 300],
      ["sawtooth", 200],
    ]);
    expect(oscillators[2]?.frequency.events.at(-1)).toEqual(["exponential", 330, 0.3]);
    expect(context.waves).toBe(1);
    const noise = context.started.find((node): node is FakeSource => node instanceof FakeSource);
    expect(noise?.loop).toBe(true);
    expect(context.buffers).toBe(1);
    expect(context.filters.map((filter) => filter.type)).toEqual(["lowpass", "bandpass"]);
    expect(context.filters[1]?.frequency.events).toEqual([
      ["set", 1200, 0.05],
      ["exponential", 600, 0.3],
    ]);
    player.play({ bpm: 60, beats: 1, voices: [{ instrument: "bass", notes: [{ freq: 55, at: 0, length: 1 }] }] });
    context.currentTime = 0.3;
    player.tick();
    const bass = context.oscillators().at(-1);
    expect([bass?.type, bass?.freq]).toEqual(["square", 55]);
    expect(context.filters.at(-1)?.frequency.events[0]?.[1]).toBe(165);
  });

  it("stops at once and forgets the track", () => {
    const { context, player, timers } = setup();
    player.play(scale);
    player.stop();
    expect(player.track).toBeNull();
    expect(context.outs().every((out) => out.disconnected)).toBe(true);
    expect(timers.running).toBe(0);
    player.play(scale);
    expect(context.outs()).toHaveLength(2);
    expect(player.track?.name).toBe("Scale");
  });
});
