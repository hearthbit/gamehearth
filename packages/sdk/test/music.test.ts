import { describe, expect, it } from "vitest";
import {
  maxMusicNotes,
  maxMusicPolyphony,
  musicPolyphony,
  maxMusicNotesPerSecond,
  musicInstruments,
  musicSeconds,
  parseGameMessage,
  parsePlatformMessage,
  readTrack,
  trackLabel,
  trackProblem,
  type MusicTrack,
} from "../src/platform";

const loop: MusicTrack = {
  name: "Forest",
  bpm: 120,
  beats: 8,
  voices: [
    {
      instrument: "musicbox",
      notes: [
        { freq: 523.25, at: 0, length: 1 },
        { freq: 659.25, at: 1, length: 1, volume: 0.6 },
        { freq: 783.99, at: 2, length: 2, to: 880 },
      ],
    },
    { instrument: "bass", volume: 0.8, notes: [{ freq: 130.81, at: 0, length: 4 }] },
  ],
};

function withNote(note: Record<string, unknown>): unknown {
  return { bpm: 120, beats: 4, voices: [{ instrument: "sine", notes: [note] }] };
}

describe("Music tracks", () => {
  it("accepts a loop and fills in the default volumes", () => {
    expect(trackProblem(loop)).toBeUndefined();
    expect(readTrack(loop)).toEqual({
      name: "Forest",
      bpm: 120,
      beats: 8,
      voices: [
        {
          instrument: "musicbox",
          volume: 0.5,
          notes: [
            { freq: 523.25, at: 0, length: 1, volume: 1 },
            { freq: 659.25, at: 1, length: 1, volume: 0.6 },
            { freq: 783.99, to: 880, at: 2, length: 2, volume: 1 },
          ],
        },
        { instrument: "bass", volume: 0.8, notes: [{ freq: 130.81, at: 0, length: 4, volume: 1 }] },
      ],
    });
    expect(musicSeconds(loop)).toBe(4);
    expect(trackLabel(loop)).toBe("Forest");
    const { name: _name, ...unnamed } = loop;
    expect(trackLabel(unnamed)).toBe("music");
  });

  it("knows the four waves and five presets", () => {
    expect(musicInstruments).toEqual(["square", "sine", "triangle", "sawtooth", "musicbox", "organ", "pluck", "bass", "noise"]);
    for (const instrument of musicInstruments) {
      expect(trackProblem({ bpm: 90, beats: 1, voices: [{ instrument, notes: [{ freq: 200, at: 0, length: 1 }] }] })).toBeUndefined();
    }
  });

  it("names what is wrong with a track", () => {
    expect(trackProblem(null)).toMatch(/A track is an object/);
    expect(trackProblem([])).toMatch(/A track is an object/);
    expect(trackProblem({ ...loop, tempo: 1 })).toMatch(/unknown field tempo/);
    expect(trackProblem({ ...loop, name: "" })).toMatch(/name must be a text of 1 to 40/);
    expect(trackProblem({ ...loop, name: "x".repeat(41) })).toMatch(/name must be/);
    expect(trackProblem({ ...loop, bpm: 39 })).toMatch(/bpm must be a number of beats per minute from 40 to 240/);
    expect(trackProblem({ ...loop, bpm: 241 })).toMatch(/bpm/);
    expect(trackProblem({ ...loop, bpm: Number.NaN })).toMatch(/bpm/);
    expect(trackProblem({ ...loop, beats: 0 })).toMatch(/beats .* whole number from 1 to 128/);
    expect(trackProblem({ ...loop, beats: 2.5 })).toMatch(/whole number/);
    expect(trackProblem({ ...loop, beats: 129 })).toMatch(/beats/);
    expect(trackProblem({ bpm: 100, beats: 128, voices: loop.voices })).toMatch(/The loop lasts 76\.8 seconds .* at most 60 seconds/);
    expect(trackProblem({ bpm: 120, beats: 120, voices: loop.voices })).toBeUndefined();
    expect(trackProblem({ ...loop, voices: [] })).toMatch(/voices must be a list of 1 to 4 voices/);
    expect(trackProblem({ ...loop, voices: Array.from({ length: 5 }, () => loop.voices[0]) })).toMatch(/1 to 4 voices/);
    expect(trackProblem({ ...loop, voices: [7] })).toMatch(/^voices\[0\]: a voice is an object/);
    expect(trackProblem({ ...loop, voices: [{ instrument: "kazoo", notes: [] }] })).toMatch(/^voices\[0\]: instrument must be one of square, sine/);
    expect(trackProblem({ ...loop, voices: [{ instrument: "sine", notes: [], pan: 1 }] })).toMatch(/unknown field pan/);
    expect(trackProblem({ ...loop, voices: [{ instrument: "sine", volume: 2, notes: [{ freq: 440, at: 0, length: 1 }] }] })).toMatch(/^voices\[0\]: volume must be/);
    expect(trackProblem({ ...loop, voices: [{ instrument: "sine", notes: [] }] })).toMatch(/notes must be a list of 1 to 256 notes/);
    expect(trackProblem(withNote({ freq: 20, at: 0, length: 1 }))).toMatch(/^voices\[0\]\.notes\[0\]: freq must be a number of hertz from 30 to 8000/);
    expect(trackProblem(withNote({ freq: 440, to: 9000, at: 0, length: 1 }))).toMatch(/to must be/);
    expect(trackProblem(withNote({ freq: 440, length: 1 }))).toMatch(/at must be a beat of at least 0 and less than beats \(4\)/);
    expect(trackProblem(withNote({ freq: 440, at: 4, length: 1 }))).toMatch(/at must be/);
    expect(trackProblem(withNote({ freq: 440, at: -1, length: 1 }))).toMatch(/at must be/);
    expect(trackProblem(withNote({ freq: 440, at: 0, length: 0 }))).toMatch(/length must be a number of beats greater than 0/);
    expect(trackProblem(withNote({ freq: 440, at: 3.5, length: 1 }))).toMatch(/end by the end of the loop \(beat 4\)/);
    expect(trackProblem(withNote({ freq: 440, at: 3.7, length: 0.3 }))).toBeUndefined();
    expect(trackProblem(withNote({ freq: 440, at: 0, length: 1, volume: -0.1 }))).toMatch(/volume must be a number from 0 to 1/);
    expect(trackProblem(withNote({ freq: 440, at: 0, length: 1, wave: "sine" }))).toMatch(/unknown field wave; a note has freq, at, length, volume and to/);
  });

  it("limits the notes in total and per second, so that a short loop cannot flood the audio", () => {
    const notes = (count: number) => Array.from({ length: count }, (_, index) => ({ freq: 440, at: (index % 64) / 2, length: 0.5 }));
    const many = { bpm: 60, beats: 32, voices: [{ instrument: "pluck", notes: notes(128) }, { instrument: "pluck", notes: notes(128) }] };
    expect(trackProblem(many)).toBeUndefined();
    expect(trackProblem({ ...many, voices: [...many.voices, { instrument: "pluck", notes: notes(1) }] })).toMatch(`at most ${maxMusicNotes} notes`);
    expect(trackProblem({ bpm: 60, beats: 1, voices: [{ instrument: "sine", notes: notes(maxMusicNotesPerSecond).map((note, index) => ({ ...note, at: index / 100, length: 0.01 })) }] })).toBeUndefined();
    expect(trackProblem({ bpm: 60, beats: 1, voices: [{ instrument: "sine", notes: notes(maxMusicNotesPerSecond + 1).map((note, index) => ({ ...note, at: index / 100, length: 0.01 })) }] })).toMatch(
      /plays 65 notes per second; at most 64/,
    );
    expect(trackProblem({ bpm: 60, beats: 1, voices: [{ instrument: "sine", notes: notes(100_000) }] })).toMatch(/1 to 256 notes/);
  });

  it("travels over the bridge only when it is valid, null included, and settings carry the music switch", () => {
    expect(parseGameMessage({ gamehearth: 1, type: "music", track: loop })).toEqual({ gamehearth: 1, type: "music", track: readTrack(loop) });
    expect(parseGameMessage({ gamehearth: 1, type: "music", track: null })).toEqual({ gamehearth: 1, type: "music", track: null });
    expect(parseGameMessage({ gamehearth: 1, type: "music", track: { ...loop, bpm: 10 } })).toBeUndefined();
    expect(parseGameMessage({ gamehearth: 1, type: "music" })).toBeUndefined();
    expect(parsePlatformMessage({ gamehearth: 1, type: "settings", sound: true, music: false })).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    expect(parsePlatformMessage({ gamehearth: 1, type: "settings", sound: true })).toEqual({ gamehearth: 1, type: "settings", sound: true });
    expect(parsePlatformMessage({ gamehearth: 1, type: "settings", sound: true, music: "on" })).toEqual({ gamehearth: 1, type: "settings", sound: true });
  });

  it("keeps the message small: the largest valid track is under 40 KB as JSON", () => {
    const value = 0.30000000000000004;
    const notes = Array.from({ length: 64 }, (_, index) => ({ freq: 30.000000000000004 + index, to: 7999.999999999999, at: index * value, length: value, volume: value }));
    const largest = { name: "x".repeat(40), bpm: 239.99999999999997, beats: 60, voices: [0, 1, 2, 3].map(() => ({ instrument: "musicbox", volume: value, notes })) };
    expect(trackProblem(largest)).toBeUndefined();
    expect(JSON.stringify(readTrack(largest)).length).toBeLessThan(40 * 1024);
  });
});

describe("Review 17: notes sounding at once", () => {
  const voice = (notes: { at: number; length: number }[]) => ({ instrument: "organ" as const, notes: notes.map((note, index) => ({ freq: 200 + index, ...note })) });

  it("allows at most 24 notes sounding at the same time, counted over all voices", () => {
    expect(maxMusicPolyphony).toBe(24);
    const chord = (count: number) => Array.from({ length: count }, () => ({ at: 0, length: 4 }));
    expect(trackProblem({ bpm: 120, beats: 4, voices: [voice(chord(24))] })).toBeUndefined();
    expect(trackProblem({ bpm: 120, beats: 4, voices: [voice(chord(25))] })).toMatch(/25 notes sound at the same time \(from beat 0\); at most 24 are allowed/);
    expect(trackProblem({ bpm: 120, beats: 4, voices: [voice(chord(12)), voice(chord(13))] })).toMatch(/25 notes sound at the same time/);
  });

  it("counts overlaps, not notes: a note that ends where the next starts does not overlap it", () => {
    const steps = Array.from({ length: 64 }, (_, index) => ({ at: index / 2, length: 0.5 }));
    expect(musicPolyphony({ bpm: 120, beats: 32, voices: [voice(steps)] })).toBe(1);
    const held = [{ at: 0, length: 4 }, { at: 1, length: 2 }, { at: 2, length: 2 }, { at: 3.5, length: 0.5 }];
    expect(musicPolyphony({ bpm: 120, beats: 4, voices: [voice(held)] })).toBe(3);
  });

  it("counts across the loop's end, where the last notes meet the first ones", () => {
    const wrapped = [{ at: 0, length: 1 }, { at: 3, length: 1 }];
    expect(musicPolyphony({ bpm: 120, beats: 4, voices: [voice(wrapped)] })).toBe(1);
    expect(musicPolyphony({ bpm: 120, beats: 4, voices: [voice([{ at: 0, length: 4 }, { at: 0, length: 4 }])] })).toBe(2);
  });
});
