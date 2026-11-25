// @vitest-environment happy-dom
import type { Sound } from "@gamehearth/sdk/platform";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomConnection, type SocketLike } from "../src/connection";
import type { Me, RoomView, ScreenView } from "../src/protocol";
import { Play } from "../src/screens/play";
import { SoloScreen } from "../src/screens/solo";
import { TvScreen } from "../src/screens/tv";
import { SessionContext, type SessionValue } from "../src/session";
import { forgetSoloSessions } from "../src/solo-service";
import { gameSoundGain, gameSoundPlayer, gameSoundsPerSecond, playSound, sound, toggleSound } from "../src/sound";
import { setLanguage } from "../src/texts";
import { SoundSetting } from "../src/ui/switches";

interface Played {
  freq: number;
  wave: string;
  set: [number, number][];
  ramps: [number, number][];
}

const played: Played[] = [];
let resumed = 0;

class FakeContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  resume = async () => {
    resumed += 1;
  };
  createOscillator() {
    const tone: Played = { freq: 0, wave: "", set: [], ramps: [] };
    played.push(tone);
    const oscillator = {
      type: "square",
      frequency: { setValueAtTime: (value: number) => (tone.freq = value), exponentialRampToValueAtTime: () => undefined },
      connect: () => {
        tone.wave = oscillator.type;
        return { connect: () => undefined };
      },
      start: () => undefined,
      stop: () => undefined,
    };
    return oscillator;
  }
  createGain() {
    const tone = played.at(-1) as Played;
    return {
      gain: {
        setValueAtTime: (value: number, time: number) => tone.set.push([value, time]),
        exponentialRampToValueAtTime: (value: number, time: number) => tone.ramps.push([value, time]),
      },
    };
  }
}

function peaks(): number[] {
  return played.map((tone) => tone.ramps[0]?.[0] ?? Number.NaN);
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

beforeEach(() => {
  localStorage.clear();
  sound.set(false);
  setLanguage("de");
  played.length = 0;
  resumed = 0;
  vi.stubGlobal("AudioContext", FakeContext);
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  forgetSoloSessions();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

function switchOn(): void {
  toggleSound(true);
  played.length = 0;
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

describe("Playing a game's sounds", () => {
  it("maps a note's volume to a peak of volume × 0.12 with the cues' envelope", () => {
    sound.set(true);
    switchOn();
    playSound({ notes: [{ freq: 440, length: 0.1, volume: 1 }, { freq: 880, at: 0.1, length: 0.1, wave: "triangle" }, { freq: 220, length: 0.1, volume: 0 }] });
    expect(gameSoundGain).toBe(0.12);
    expect(played.map((tone) => [tone.freq, tone.wave])).toEqual([
      [440, "square"],
      [880, "triangle"],
      [220, "square"],
    ]);
    expect(peaks()).toEqual([0.12, 0.06, 0.0001]);
    const [first] = played;
    expect(first?.set[0]?.[0]).toBe(0.0001);
    expect(first?.ramps[0]?.[1]).toBeCloseTo((first?.set[0]?.[1] ?? 0) + 0.008);
    expect(first?.ramps[1]?.[0]).toBe(0.0001);
    expect(first?.ramps[1]?.[1]).toBeCloseTo((first?.set[0]?.[1] ?? 0) + 0.1);
    played.length = 0;
    playSound("coin");
    expect(played.map((tone) => tone.freq)).toEqual([988, 1319]);
  });

  it("stays silent while the switch is off", () => {
    sound.set(true);
    switchOn();
    sound.set(false);
    playSound("coin");
    expect(played).toEqual([]);
  });

  it("plays at most 12 sounds per second for each game frame and drops the rest", () => {
    let time = 0;
    const heard: Sound[] = [];
    const player = gameSoundPlayer(() => time, (effect) => heard.push(effect));
    for (let index = 0; index < 15; index++) {
      player("tap");
    }
    expect(gameSoundsPerSecond).toBe(12);
    expect(heard).toHaveLength(12);
    time = 999;
    player("coin");
    expect(heard).toHaveLength(12);
    const other = gameSoundPlayer(() => time, (effect) => heard.push(effect));
    other("win");
    expect(heard).toHaveLength(13);
    time = 1000;
    player("coin");
    expect(heard.at(-1)).toBe("coin");
    expect(heard).toHaveLength(14);
  });

  it("plays only after a tap in the platform's window or when the top window has had user activation", async () => {
    vi.resetModules();
    localStorage.setItem("gamehearth.sound", "on");
    const fresh = await import("../src/sound");
    fresh.playSound("coin");
    expect(played).toEqual([]);
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { hasBeenActive: false } });
    fresh.playSound("coin");
    expect(played).toEqual([]);
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { hasBeenActive: true } });
    fresh.playSound("coin");
    expect(played.map((tone) => tone.freq)).toEqual([988, 1319]);
    played.length = 0;
    localStorage.setItem("gamehearth.sound", "off");
    const off = await import("../src/sound");
    off.sound.set(false);
    off.playSound("coin");
    expect(played).toEqual([]);
  });

  it("says in the hint of the switch that the iPhone's silent switch also applies", () => {
    const root = mount(<SoundSetting />);
    expect(root.textContent).toContain("Auf dem iPhone gilt auch der Klingel-/Lautlos-Schalter");
    unmount();
    setLanguage("en");
    const english = mount(<SoundSetting />);
    expect(english.textContent).toContain("On iPhones the ringer/silent switch also applies");
  });
});

const mauMau = { id: "mau-mau", name: "Mau-Mau", version: "0.5.0", client: "/games/mau-mau/0.5.0+abcdefabcdef/" };

function room(): RoomView {
  return {
    code: "ABC234",
    game: mauMau,
    status: "running",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [
      { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Ben", seat: "p2", host: false, guest: false, deleted: false, you: false, connected: true },
    ],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 3 },
  };
}

describe("Sound on the game page", () => {
  it("keeps the game silent and answers its moves on the device while a bot plays your seat", async () => {
    switchOn();
    const commands: unknown[] = [];
    const notes: string[] = [];
    const onAutopilot: RoomView = { ...room(), you: { ...room().you, autopilot: true }, members: room().members.map((member) => (member.id === 1 ? { ...member, autopilot: true as const } : member)) };
    const root = mount(
      <Play room={onAutopilot} online command={async (next) => (commands.push(next), { ok: false, code: "bot-playing", message: "A bot is playing your seat" })} notify={(text) => notes.push(String(text))} onLeave={async () => {}} />,
    );
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: false }]);
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played).toEqual([]);
    fromGame(game, { gamehearth: 1, type: "move", id: 7, action: { type: "steer", dir: "none" }, expectedVersion: 3 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands).toEqual([]);
    expect(notes).toEqual([]);
    expect(game.posted.at(-1)).toMatchObject({ type: "result", id: 7, ok: false, code: "bot-playing" });
  });

  it("tells the game the switch, has the switch in the menu and plays the game's sounds only while it is on", async () => {
    const root = mount(<Play room={room()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: false }]);
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played).toEqual([]);

    const on = await menuItem(root, "Ton");
    expect(on.getAttribute("role")).toBe("menuitemcheckbox");
    expect(on.getAttribute("aria-checked")).toBe("false");
    await act(async () => on.click());
    expect(localStorage.getItem("gamehearth.sound")).toBe("on");
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true });
    played.length = 0;
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played.map((tone) => tone.freq)).toEqual([988, 1319]);
    expect(peaks()).toEqual([0.06, 0.06]);

    const off = await menuItem(root, "Ton");
    expect(off.getAttribute("aria-checked")).toBe("true");
    await act(async () => off.click());
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: false });
    played.length = 0;
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played).toEqual([]);
  });

  it("starts the game with the switch on and drops sounds beyond 12 per second", () => {
    sound.set(true);
    switchOn();
    const root = mount(<Play room={room()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: true }]);
    for (let index = 0; index < 20; index++) {
      fromGame(game, { gamehearth: 1, type: "sound", sound: "tap" });
    }
    expect(played).toHaveLength(12);
    fromGame(game, { gamehearth: 1, type: "sound", sound: "boing" });
    expect(played).toHaveLength(12);
  });

  it("names the switch in English", async () => {
    setLanguage("en");
    const root = mount(<Play room={room()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect((await menuItem(root, "Sound")).getAttribute("aria-checked")).toBe("false");
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

describe("Sound on the TV", () => {
  it("has its own switch on the pairing page whose click unlocks sound", async () => {
    const { root, socket } = await tv();
    act(() => socket.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 }));
    const toggle = root.querySelector<HTMLButtonElement>("[data-testid=tv-pairing] button[aria-label=Ton]");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle?.click());
    expect(localStorage.getItem("gamehearth.sound")).toBe("on");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(resumed).toBeGreaterThan(0);
    expect(played).toHaveLength(1);
    act(() => toggle?.click());
    expect(localStorage.getItem("gamehearth.sound")).toBe("off");
    expect(played).toHaveLength(1);
  });

  it("plays the game's shared sounds on the TV while its switch is on", async () => {
    sound.set(true);
    switchOn();
    const { root, socket } = await tv();
    act(() => socket.receive({ type: "screen-room", room: screen }));
    const game = attach(root.querySelector("[data-testid=tv-game] iframe"));
    fromGame(game, { gamehearth: 1, type: "ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: true }]);
    fromGame(game, { gamehearth: 1, type: "sound", sound: "win" });
    expect(played).toHaveLength(6);
    act(() => sound.set(false));
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: false });
    played.length = 0;
    fromGame(game, { gamehearth: 1, type: "sound", sound: "win" });
    expect(played).toEqual([]);
  });
});

describe("Sound on the single-player page", () => {
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

  function serve(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const body = path === "/api/games" ? [sammler] : { game: "sammler", save: null, savedAt: null, best: {}, generations: {}, boards: {}, ignored: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  }

  async function open(): Promise<HTMLElement> {
    serve();
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
    return container;
  }

  it("tells the game the switch, has the switch in the menu and plays the game's sounds only while it is on", async () => {
    const root = await open();
    const game = attach(root.querySelector("iframe"));
    fromGame(game, { gamehearth: 1, type: "solo-ready" });
    expect(settings(game)).toEqual([{ gamehearth: 1, type: "settings", sound: false }]);
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played).toEqual([]);
    const item = await menuItem(root, "Ton");
    await act(async () => item.click());
    expect(settings(game).at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true });
    played.length = 0;
    fromGame(game, { gamehearth: 1, type: "sound", sound: "coin" });
    expect(played.map((tone) => tone.freq)).toEqual([988, 1319]);
    for (let index = 0; index < 20; index++) {
      fromGame(game, { gamehearth: 1, type: "sound", sound: "tap" });
    }
    expect(played).toHaveLength(2 + gameSoundsPerSecond - 1);
  });
});
