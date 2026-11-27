import { maxSoundFrequency, minSoundFrequency, soundWaves, type SoundWave } from "./sound";

export type MusicInstrument = SoundWave | "musicbox" | "organ" | "pluck" | "bass" | "noise";

export interface MusicNote {
  freq: number;
  at: number;
  length: number;
  volume?: number;
  to?: number;
}

export interface MusicVoice {
  instrument: MusicInstrument;
  volume?: number;
  notes: readonly MusicNote[];
}

export interface MusicTrack {
  name?: string;
  bpm: number;
  beats: number;
  voices: readonly MusicVoice[];
}

export const musicInstruments: readonly MusicInstrument[] = [...soundWaves, "musicbox", "organ", "pluck", "bass", "noise"];
export const minMusicBpm = 40;
export const maxMusicBpm = 240;
export const maxMusicBeats = 128;
export const maxMusicSeconds = 60;
export const maxMusicVoices = 4;
export const maxMusicNotes = 256;
export const maxMusicNotesPerSecond = 64;
export const maxMusicNameLength = 40;
export const defaultVoiceVolume = 0.5;
export const defaultMusicNoteVolume = 1;

const slack = 1e-9;

export function musicSeconds(track: { bpm: number; beats: number }): number {
  return (track.beats * 60) / track.bpm;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownField(record: Record<string, unknown>, known: readonly string[]): string | undefined {
  return Object.keys(record).find((key) => !known.includes(key));
}

function volumeProblem(value: unknown): string | undefined {
  return value !== undefined && (!isNumber(value) || value < 0 || value > 1) ? "volume must be a number from 0 to 1" : undefined;
}

export function trackProblem(track: unknown): string | undefined {
  if (!isRecord(track)) {
    return "A track is an object such as { bpm: 120, beats: 8, voices: [{ instrument: \"musicbox\", notes: [{ freq: 523, at: 0, length: 1 }] }] }.";
  }
  const unknown = unknownField(track, ["name", "bpm", "beats", "voices"]);
  if (unknown !== undefined) {
    return `unknown field ${unknown}; a track has name, bpm, beats and voices.`;
  }
  const name = track["name"];
  if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > maxMusicNameLength)) {
    return `name must be a text of 1 to ${maxMusicNameLength} characters.`;
  }
  const bpm = track["bpm"];
  if (!isNumber(bpm) || bpm < minMusicBpm || bpm > maxMusicBpm) {
    return `bpm must be a number of beats per minute from ${minMusicBpm} to ${maxMusicBpm}.`;
  }
  const beats = track["beats"];
  if (typeof beats !== "number" || !Number.isInteger(beats) || beats < 1 || beats > maxMusicBeats) {
    return `beats (the length of the loop) must be a whole number from 1 to ${maxMusicBeats}.`;
  }
  const seconds = musicSeconds({ bpm, beats });
  if (seconds > maxMusicSeconds + slack) {
    return `The loop lasts ${seconds.toFixed(1)} seconds (beats × 60 / bpm); at most ${maxMusicSeconds} seconds are allowed.`;
  }
  const voices = track["voices"];
  if (!Array.isArray(voices) || voices.length === 0 || voices.length > maxMusicVoices) {
    return `voices must be a list of 1 to ${maxMusicVoices} voices.`;
  }
  let total = 0;
  for (const [index, voice] of voices.entries()) {
    const problem = voiceProblem(voice, beats);
    if (problem !== undefined) {
      return `voices[${index}]${problem}`;
    }
    total += (voice as { notes: unknown[] }).notes.length;
    if (total > maxMusicNotes) {
      return `A track has at most ${maxMusicNotes} notes in all its voices together.`;
    }
  }
  if (total / seconds > maxMusicNotesPerSecond + slack) {
    return `The track plays ${Math.ceil(total / seconds)} notes per second; at most ${maxMusicNotesPerSecond} are allowed. Use fewer notes or a longer loop.`;
  }
  return undefined;
}

function voiceProblem(voice: unknown, beats: number): string | undefined {
  if (!isRecord(voice)) {
    return ": a voice is an object such as { instrument: \"organ\", notes: [...] }";
  }
  const unknown = unknownField(voice, ["instrument", "volume", "notes"]);
  if (unknown !== undefined) {
    return `: unknown field ${unknown}; a voice has instrument, volume and notes`;
  }
  if (!(musicInstruments as readonly unknown[]).includes(voice["instrument"])) {
    return `: instrument must be one of ${musicInstruments.join(", ")}`;
  }
  const volume = volumeProblem(voice["volume"]);
  if (volume !== undefined) {
    return `: ${volume}`;
  }
  const notes = voice["notes"];
  if (!Array.isArray(notes) || notes.length === 0 || notes.length > maxMusicNotes) {
    return `: notes must be a list of 1 to ${maxMusicNotes} notes`;
  }
  for (const [index, note] of notes.entries()) {
    const problem = noteProblem(note, beats);
    if (problem !== undefined) {
      return `.notes[${index}]: ${problem}`;
    }
  }
  return undefined;
}

function noteProblem(note: unknown, beats: number): string | undefined {
  if (!isRecord(note)) {
    return "a note is an object such as { freq: 440, at: 0, length: 1 }";
  }
  const unknown = unknownField(note, ["freq", "at", "length", "volume", "to"]);
  if (unknown !== undefined) {
    return `unknown field ${unknown}; a note has freq, at, length, volume and to`;
  }
  const frequency = (value: unknown) => isNumber(value) && value >= minSoundFrequency && value <= maxSoundFrequency;
  if (!frequency(note["freq"])) {
    return `freq must be a number of hertz from ${minSoundFrequency} to ${maxSoundFrequency}`;
  }
  if (note["to"] !== undefined && !frequency(note["to"])) {
    return `to must be a number of hertz from ${minSoundFrequency} to ${maxSoundFrequency}`;
  }
  const at = note["at"];
  if (!isNumber(at) || at < 0 || at >= beats) {
    return `at must be a beat of at least 0 and less than beats (${beats})`;
  }
  const length = note["length"];
  if (!isNumber(length) || length <= 0 || at + length > beats + slack) {
    return `length must be a number of beats greater than 0, and the note must end by the end of the loop (beat ${beats})`;
  }
  return volumeProblem(note["volume"]);
}

export function readTrack(raw: unknown): MusicTrack | undefined {
  if (trackProblem(raw) !== undefined) {
    return undefined;
  }
  const track = raw as MusicTrack;
  return {
    ...(track.name === undefined ? {} : { name: track.name }),
    bpm: track.bpm,
    beats: track.beats,
    voices: track.voices.map((voice) => ({
      instrument: voice.instrument,
      volume: voice.volume ?? defaultVoiceVolume,
      notes: voice.notes.map((note) => ({
        freq: note.freq,
        ...(note.to === undefined ? {} : { to: note.to }),
        at: note.at,
        length: note.length,
        volume: note.volume ?? defaultMusicNoteVolume,
      })),
    })),
  };
}

export function trackLabel(track: MusicTrack): string {
  return track.name ?? "music";
}
