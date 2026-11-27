// @vitest-environment happy-dom
import type { MusicTrack } from "@gamehearth/sdk/platform";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { music, musicUnlockPollMs, playingTrack, stopMusic } from "../src/music";
import { RoomConnection, type SocketLike } from "../src/connection";
import type { Me, RoomView, ScreenView } from "../src/protocol";
import { AccountScreen } from "../src/screens/account";
import { Play } from "../src/screens/play";
import { SoloScreen } from "../src/screens/solo";
import { TvScreen } from "../src/screens/tv";
import { SessionContext, type SessionValue } from "../src/session";
import { forgetSoloSessions } from "../src/solo-service";
import { playSound, sound, toggleSound } from "../src/sound";
import { setLanguage } from "../src/texts";
import { MusicSetting } from "../src/ui/switches";

interface Note {
  freq: number;
  start: number;
}

class Param {
  value = 1;
  events: [string, number, number][] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push(["set", value, time]);
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push(["linear", value, time]);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push(["exponential", value, time]);
  }
  cancelScheduledValues(time: number) {
    this.events.push(["cancel", 0, time]);
  }
}

class Node {
  outputs: unknown[] = [];
  disconnected = false;
  connect(destination: unknown) {
    this.outputs.push(destination);
    return destination;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class Gain extends Node {
  gain = new Param();
}

let audio: FakeContext | undefined;
const notes: Note[] = [];
const gains: Gain[] = [];
const compressors: Node[] = [];

class FakeContext {
  state = "suspended";
  currentTime = 0;
  sampleRate = 100;
  destination = new Node();
  constructor() {
    audio = this;
  }
  resume = async () => {
    this.state = "running";
  };
  createGain() {
    const gain = new Gain();
    gains.push(gain);
    return gain;
  }
  createOscillator() {
    const frequency = new Param();
    return Object.assign(new Node(), {
      type: "square",
      frequency,
      setPeriodicWave: () => undefined,
      start: (when: number) => notes.push({ freq: frequency.events[0]?.[1] ?? 0, start: when }),
      stop: () => undefined,
    });
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { type: "lowpass", frequency: new Param(), Q: new Param() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    return Object.assign(new Node(), { buffer: null, loop: false, start: () => undefined, stop: () => undefined });
  }
  createPeriodicWave() {
    return {};
  }
  createDynamicsCompressor() {
    const node = Object.assign(new Node(), { threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param() });
    compressors.push(node);
    return node;
  }
}

const forest: MusicTrack = { name: "Wald", bpm: 120, beats: 2, voices: [{ instrument: "sine", notes: [{ freq: 523, at: 0, length: 1 }, { freq: 523, at: 1, length: 1 }] }] };
const night: MusicTrack = { name: "Nacht", bpm: 120, beats: 2, voices: [{ instrument: "triangle", notes: [{ freq: 784, at: 0, length: 2 }] }] };

function heard(freq: number): number {
  return notes.filter((note) => note.freq === freq).length;
}

function isMaster(node: unknown): boolean {
  return node instanceof Gain && node.outputs.some((output) => compressors.includes(output as Node));
}

function tracks(): Gain[] {
  return gains.filter((gain) => gain.outputs.some(isMaster) && gain.gain.events[1]?.[0] === "linear" && gain.gain.events[1][1] === 1);
}

function lastRamp(gain: Gain | undefined): number | undefined {
  return gain?.gain.events.filter((event) => event[0] === "linear").at(-1)?.[1];
}

function advance(seconds: number): void {
  const context = audio;
  if (context === undefined) {
    vi.advanceTimersByTime(seconds * 1000);
    return;
  }
  const end = context.currentTime + seconds;
  while (context.currentTime < end - 1e-9) {
    context.currentTime = Math.round((context.currentTime + 0.1) * 1000) / 1000;
    vi.advanceTimersByTime(100);
  }
}

let visibility: "visible" | "hidden" = "visible";

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let container: HTMLElement | undefined;

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container as HTMLElement));
  return container;
}

function unmount(): void {
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
}

interface FakeWindow {
  posted: unknown[];
  postMessage(message: unknown): void;
}

function attach(frame: HTMLIFrameElement | null): FakeWindow {
  expect(frame).not.toBeNull();
  const window: FakeWindow = { posted: [], postMessage: (message) => window.posted.push(message) };
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => window });
  return window;
}

function fromGame(window: FakeWindow, data: unknown): void {
  act(() => {
    dispatchEvent(new MessageEvent("message", { data, source: window as never }));
  });
}

const settings = (window: FakeWindow) => window.posted.filter((message) => (message as { type?: string }).type === "settings");

async function menuItem(root: HTMLElement, label: string): Promise<HTMLButtonElement> {
  await act(async () => (root.querySelector("[aria-haspopup=menu]") as HTMLButtonElement).click());
  const item = [...root.querySelectorAll<HTMLButtonElement>("[role=menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(item, label).toBeDefined();
  return item as HTMLButtonElement;
}

async function select(root: HTMLElement, label: string): Promise<void> {
  const item = await menuItem(root, label);
  await act(async () => item.click());
}

beforeEach(() => {
  localStorage.clear();
  sound.set(false);
  music.set(true);
  setLanguage("de");
  notes.length = 0;
  gains.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  unmount();
  stopMusic();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetSoloSessions();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const mauMau = { id: "mau-mau", name: "Mau-Mau", version: "0.5.0", client: "/games/mau-mau/0.5.0+abcdefabcdef/" };

function room(autopilot = false): RoomView {
  const members = [
    { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true, ...(autopilot ? { autopilot: true as const } : {}) },
    { id: 2, name: "Ben", seat: "p2", host: false, guest: false, deleted: false, you: false, connected: true },
  ];
  return {
    code: "ABC234",
    game: mauMau,
    status: "running",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members,
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, ...(autopilot ? { autopilot: true } : {}) },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 3 },
  };
}

function play(view: RoomView): preact.JSX.Element {
  return <Play room={view} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />;
}

describe("Music on the game page", () => {
  it("is on by default as a device setting, with a hint that it needs sound", () => {
    expect(music.get()).toBe(true);
    const root = mount(<MusicSetting />);
    expect(root.textContent).toContain("Musik");
    expect(root.textContent).toContain("Spielt nur, wenn auch der Ton an ist");
  });

  it("plays the game's loop only with sound and music on, switches it off on its own, crossfades and keeps the same track", async () => {
    const root = mount(play(room()));
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: false, music: false }]);
    fromGame(game, { gamehearth: 1, type: "music", track: forest });
    advance(1);
    expect(heard(523)).toBe(0);

    const item = await menuItem(root, "Musik");
    expect(item.getAttribute("aria-checked")).toBe("true");
    await act(async () => (root.querySelector("[aria-haspopup=menu]") as HTMLButtonElement).click());
    await select(root, "Ton");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(heard(523)).toBe(3);
    advance(2);
    expect(heard(523)).toBe(7);
    expect(playingTrack()?.name).toBe("Wald");

    fromGame(game, { gamehearth: 1, type: "music", track: JSON.parse(JSON.stringify(forest)) as MusicTrack });
    expect(tracks()).toHaveLength(1);

    fromGame(game, { gamehearth: 1, type: "music", track: night });
    const [old, next] = tracks();
    expect(lastRamp(old)).toBe(0);
    expect(lastRamp(next)).toBe(1);
    expect(heard(784)).toBe(2);
    advance(2);
    expect(old?.disconnected).toBe(true);
    const before = heard(523);
    advance(2);
    expect(heard(523)).toBe(before);

    await select(root, "Musik");
    expect(localStorage.getItem("gamehearth.music")).toBe("off");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    expect(lastRamp(next)).toBe(0);
    advance(2);
    const silent = heard(784);
    advance(3);
    expect(heard(784)).toBe(silent);
    expect(playingTrack()).toBeNull();

    await select(root, "Musik");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: true });
    advance(2);
    expect(heard(784)).toBeGreaterThan(silent);

    await select(root, "Ton");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: false, music: false });
    advance(2);
    const quiet = heard(784);
    advance(3);
    expect(heard(784)).toBe(quiet);
  });

  it("pauses while the page is hidden and goes on where it was when it is visible again", () => {
    toggleSound(true);
    const root = mount(play(room()));
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    fromGame(game, { gamehearth: 1, type: "music", track: forest });
    advance(1.2);
    setVisibility("hidden");
    expect(playingTrack()).toBeNull();
    advance(0.5);
    const count = heard(523);
    advance(5);
    expect(heard(523)).toBe(count);
    setVisibility("visible");
    advance(1);
    expect(heard(523)).toBeGreaterThan(count);
    expect(playingTrack()?.name).toBe("Wald");
  });

  it("stops while a bot plays your seat, when the game reloads and when you leave the page", () => {
    toggleSound(true);
    const root = mount(play(room()));
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    fromGame(game, { gamehearth: 1, type: "music", track: forest });
    expect(playingTrack()?.name).toBe("Wald");
    act(() => render(play(room(true)), root));
    expect(playingTrack()).toBeNull();
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: false, music: false });
    act(() => render(play(room()), root));
    expect(playingTrack()?.name).toBe("Wald");
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(playingTrack()).toBeNull();
    fromGame(game, { gamehearth: 1, type: "music", track: night });
    expect(playingTrack()?.name).toBe("Nacht");
    unmount();
    expect(playingTrack()).toBeNull();
    advance(0.4);
    expect(tracks().filter((gain) => !gain.disconnected).map(lastRamp)).toEqual([0]);
  });

  it("names the switch in English", async () => {
    setLanguage("en");
    const root = mount(play(room()));
    expect((await menuItem(root, "Music")).getAttribute("aria-checked")).toBe("true");
  });

  it("is on the account page next to sound", async () => {
    const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const session: SessionValue = { me: { state: "ready", user: anna }, user: anna, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined };
    const root = mount(
      <SessionContext.Provider value={session}>
        <AccountScreen notify={() => {}} />
      </SessionContext.Provider>,
    );
    const labels = [...root.querySelectorAll(".setting-label")].map((label) => label.textContent);
    expect(labels.indexOf("Musik")).toBe(labels.indexOf("Ton") + 1);
  });
});

describe("Review 17: music on the platform", () => {
  it("lets a frame that sends 500 tracks in a row keep at most two tracks alive, and plays the latest after 300 ms", () => {
    toggleSound(true);
    const root = mount(play(room()));
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    const before = tracks().length;
    for (let index = 0; index < 500; index++) {
      fromGame(game, { gamehearth: 1, type: "music", track: index % 2 === 0 ? forest : night });
    }
    expect(tracks().length - before).toBe(1);
    expect(tracks().filter((gain) => !gain.disconnected).length).toBeLessThanOrEqual(2);
    advance(0.4);
    expect(tracks().length - before).toBe(2);
    expect(tracks().filter((gain) => !gain.disconnected).length).toBeLessThanOrEqual(2);
    expect(playingTrack()?.name).toBe("Nacht");
    expect(heard(784)).toBeGreaterThan(0);
  });

  it("resumes an interrupted audio context, as Safari leaves it after the page was in the background", () => {
    toggleSound(true);
    expect(audio).toBeDefined();
    (audio as FakeContext).state = "interrupted";
    playSound("coin");
    expect(audio?.state).toBe("running");
  });

  it("creates and resumes the TV's audio on every click on its Sound or Music switch, also when it turns it off", async () => {
    toggleSound(true);
    const { root, socket } = await tv();
    act(() => socket.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 }));
    for (const label of ["Musik", "Ton"]) {
      (audio as FakeContext).state = "suspended";
      act(() => root.querySelector<HTMLButtonElement>(`[data-testid=tv-pairing] button[aria-label=${label}]`)?.click());
      expect(audio?.state, label).toBe("running");
    }
    expect(localStorage.getItem("gamehearth.music")).toBe("off");
    expect(localStorage.getItem("gamehearth.sound")).toBe("off");
  });

  it("has the Sound and Music switches in the TV's lobby too, so music can be turned off between rounds", async () => {
    const { root, socket } = await tv();
    const lobby: ScreenView = {
      code: "ABC234",
      screen: 7,
      game: { ...mauMau, roles: ["player", "screen"], screenOptional: true },
      status: "lobby",
      round: 1,
      players: { min: 2, max: 6 },
      maxMembers: 6,
      members: room().members.map((member) => ({ ...member, you: false })),
      screens: [{ id: 7, connected: true }],
    };
    act(() => socket.receive({ type: "screen-room", room: lobby }));
    const labels = [...root.querySelectorAll<HTMLButtonElement>("[data-testid=tv-lobby] button")].map((button) => button.getAttribute("aria-label"));
    expect(labels).toContain("Ton");
    expect(labels.indexOf("Musik")).toBe(labels.indexOf("Ton") + 1);
    act(() => root.querySelector<HTMLButtonElement>("[data-testid=tv-lobby] button[aria-label=Musik]")?.click());
    expect(localStorage.getItem("gamehearth.music")).toBe("off");
  });
});

describe("Music before the first tap", () => {
  it("waits for user activation and then starts on its own", async () => {
    vi.resetModules();
    localStorage.setItem("gamehearth.sound", "on");
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { hasBeenActive: false } });
    const fresh = await import("../src/music");
    const channel = fresh.musicChannel();
    channel.play(forest);
    vi.advanceTimersByTime(1000);
    expect(fresh.playingTrack()).toBeNull();
    expect(heard(523)).toBe(0);
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { hasBeenActive: true } });
    vi.advanceTimersByTime(musicUnlockPollMs);
    expect(fresh.playingTrack()?.name).toBe("Wald");
    expect(heard(523)).toBe(3);
    channel.close();
    fresh.stopMusic();
    delete (navigator as { userActivation?: unknown }).userActivation;
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

async function tv(): Promise<{ root: HTMLElement; socket: FakeSocket }> {
  const sockets: FakeSocket[] = [];
  const root = mount(
    <TvScreen
      prepare={async () => undefined}
      createConnection={(handlers) =>
        new RoomConnection({
          code: "",
          url: "ws://test/ws",
          screen: true,
          timers: { setTimeout: () => 0, clearTimeout: () => undefined },
          createSocket: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          },
          ...handlers,
        })
      }
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const socket = sockets[0] as FakeSocket;
  act(() => socket.open());
  return { root, socket };
}

describe("Music on the TV", () => {
  it("has its own switch next to sound on the pairing page and plays the shared loop", async () => {
    const { root, socket } = await tv();
    act(() => socket.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 }));
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-testid=tv-pairing] .tv-top button")].map((button) => button.getAttribute("aria-label"));
    expect(buttons.indexOf("Musik")).toBe(buttons.indexOf("Ton") + 1);
    const toggle = root.querySelector<HTMLButtonElement>("[data-testid=tv-pairing] button[aria-label=Musik]");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle?.click());
    expect(localStorage.getItem("gamehearth.music")).toBe("off");
    act(() => toggle?.click());
    expect(localStorage.getItem("gamehearth.music")).toBe("on");
    act(() => root.querySelector<HTMLButtonElement>("[data-testid=tv-pairing] button[aria-label=Ton]")?.click());

    const screen: ScreenView = {
      code: "ABC234",
      screen: 7,
      game: { ...mauMau, roles: ["player", "screen"], screenOptional: true },
      status: "running",
      round: 1,
      players: { min: 2, max: 6 },
      maxMembers: 6,
      members: room().members.map((member) => ({ ...member, you: false })),
      screens: [{ id: 7, connected: true }],
      snapshot: { players: ["p1", "p2"], public: {}, version: 3 },
    };
    act(() => socket.receive({ type: "screen-room", room: screen }));
    const game = attach(root.querySelector("[data-testid=tv-game] iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: true, music: true }]);
    fromGame(game, { gamehearth: 1, type: "music", track: night });
    expect(heard(784)).toBe(2);
    act(() => music.set(false));
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    expect(playingTrack()).toBeNull();
  });
});

describe("Music on the single-player page", () => {
  const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };
  const sammler = {
    id: "sammler",
    name: "Sammler",
    version: "0.1.0",
    mode: "single",
    players: { min: 1, max: 1 },
    solo: true,
    build: "sammler@0.1.0+abcdefabcdef",
    stats: {},
  };

  it("has the switch in the menu, tells the game and plays its loop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const body = path === "/api/games" ? [sammler] : { game: "sammler", save: null, savedAt: null, best: {}, generations: {}, boards: {}, ignored: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const session: SessionValue = { me: { state: "ready", user: anna }, user: anna, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined };
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      render(
        <SessionContext.Provider value={session}>
          <SoloScreen gameId="sammler" notify={() => {}} />
        </SessionContext.Provider>,
        container as HTMLElement,
      );
    });
    for (let round = 0; round < 5; round++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const root = container;
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "solo-ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: false, music: false }]);
    fromGame(game, { gamehearth: 1, type: "music", track: forest });
    await select(root, "Ton");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(heard(523)).toBe(3);
    await select(root, "Musik");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    expect(playingTrack()).toBeNull();
  });
});
