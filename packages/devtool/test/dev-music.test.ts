import { parsePlatformMessage, type MusicTrack } from "@gamehearth/sdk/platform";
import { describe, expect, it } from "vitest";
import { hostHtml } from "../src/dev/page";
import { musicLabel, musicSource, settingsMessage } from "../src/dev/view";

const loop: MusicTrack = { name: "Forest", bpm: 120, beats: 4, voices: [{ instrument: "musicbox", notes: [{ freq: 523, at: 0, length: 1 }] }] };
const { name: _name, ...unnamed } = loop;

describe("dev: music", () => {
  it("has a Music switch next to Sound and a place for the playing track in the header", () => {
    expect(hostHtml).toContain('<span id="music-note" class="tag" aria-live="polite"></span>');
    expect(hostHtml).toMatch(/<label id="sound-box"[^>]*><input type="checkbox" id="sound"> Sound<\/label>\s*<label id="music-box"[^>]*><input type="checkbox" id="music"> Music<\/label>/);
  });

  it("tells the frames that music plays only when Sound and Music are both on", () => {
    expect(parsePlatformMessage(settingsMessage(true, true))).toEqual({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(parsePlatformMessage(settingsMessage(true, false))).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    expect(parsePlatformMessage(settingsMessage(false, true))).toEqual({ gamehearth: 1, type: "settings", sound: false, music: false });
  });

  it("plays the TV's track, otherwise the first seat's that has one", () => {
    const tv = { screen: true, seat: "tv", track: null as MusicTrack | null };
    const p1 = { screen: false, seat: "p1", track: null as MusicTrack | null };
    const p2 = { screen: false, seat: "p2", track: unnamed as MusicTrack | null };
    expect(musicSource([tv, p1, p2])).toBe(p2);
    p1.track = loop;
    expect(musicSource([tv, p1, p2])).toBe(p1);
    tv.track = unnamed;
    expect(musicSource([tv, p1, p2])).toBe(tv);
    expect(musicSource([{ ...tv, track: null }, { ...p1, track: null }])).toBeUndefined();
  });

  it("names the playing track, or just music without a name", () => {
    expect(musicLabel(loop)).toBe("♪ Forest");
    expect(musicLabel(unnamed)).toBe("♪ music");
    expect(musicLabel(null)).toBe("");
  });
});
