// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomConnection, type ConnectionState, type SocketLike, type Timers } from "../src/connection";
import { deviceLabel, fitsGame, fitsRole, type Device } from "../src/devices";
import { bridgeUpdate, seatRole } from "../src/game-bridge";
import { setLanguage } from "../src/texts";
import type { Command, LiveView, RoomView, ScreenView } from "../src/protocol";
import { Lobby } from "../src/screens/lobby";
import { Play } from "../src/screens/play";
import { TvScreen } from "../src/screens/tv";
import { isMyTurn } from "../src/turn";
import { LiveOverlay } from "../src/ui/live";

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

const timers: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };

const race = { id: "wettlauf", name: "Wettlauf", version: "0.1.0", client: "/games/wettlauf/0.1.0+abcdefabcdef/", mode: "realtime", roles: ["screen", "controller"] };

const members = [
  { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
  { id: 2, name: "Ben", seat: "p2", host: false, guest: true, deleted: false, you: false, connected: true },
];

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

function defined<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function raceRoom(overrides: Loose<RoomView> = {}): RoomView {
  return defined<RoomView>({
    code: "ABC234",
    game: race,
    status: "running",
    round: 1,
    players: { min: 2, max: 4 },
    maxMembers: 4,
    members,
    screens: [{ id: 7, connected: true }],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    live: { state: "running", missingSeats: [], screenMissing: false, byHost: false },
    snapshot: { player: "p1", players: ["p1", "p2"], public: { pos: { p1: 0, p2: 0 } }, me: {}, moves: [{ type: "run" }], version: 3, tick: 3 },
    ...overrides,
  });
}

function screenRoom(overrides: Loose<ScreenView> = {}): ScreenView {
  return defined<ScreenView>({
    code: "ABC234",
    screen: 7,
    game: race,
    status: "running",
    round: 1,
    players: { min: 2, max: 4 },
    maxMembers: 4,
    members: members.map((member) => ({ ...member, you: false })),
    screens: [{ id: 7, connected: true }],
    snapshot: { players: ["p1", "p2"], public: { pos: { p1: 0, p2: 0 } }, version: 3, tick: 3 },
    ...overrides,
  });
}

let container: HTMLElement;

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container));
  return container;
}

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container));
    container.remove();
  }
  vi.restoreAllMocks();
});

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

describe("Bridge with roles", () => {
  it("gives phones in games with a TV the role controller, and TVs seat null", () => {
    expect(seatRole(race)).toBe("controller");
    expect(seatRole({ ...race, roles: ["player"] })).toBe("player");
    const { roles: _roles, ...withoutRoles } = race;
    expect(seatRole(withoutRoles)).toBe("player");
    expect(bridgeUpdate(raceRoom(), true)).toMatchObject({ seat: "p1", role: "controller" });
    expect(bridgeUpdate(screenRoom(), true)).toEqual({
      seat: null,
      role: "screen",
      snapshot: screenRoom().snapshot,
      players: { p1: { name: "Anna", connected: true, you: false }, p2: { name: "Ben", connected: true, you: false } },
      options: {},
      online: true,
    });
  });

  it('never reports "Your turn" ("Du bist dran") in realtime', () => {
    expect(isMyTurn(raceRoom())).toBe(false);
  });
});

describe("Connection for realtime and TV", () => {
  function connect(screen: boolean) {
    const states: ConnectionState[] = [];
    const sockets: FakeSocket[] = [];
    const connection = new RoomConnection({
      code: screen ? "" : "ABC234",
      url: "ws://test/ws",
      screen,
      timers,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onState: (state) => states.push(state),
      onNotice: () => undefined,
    });
    connection.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    return { connection, socket, sockets, states };
  }

  it("takes frames as the new snapshot of the running room", () => {
    const { connection, socket } = connect(false);
    socket.receive({ type: "room", room: raceRoom() });
    socket.receive({ type: "frame", snapshot: { ...raceRoom().snapshot, version: 4, tick: 4 } });
    expect(connection.state.room?.snapshot?.tick).toBe(4);
    expect(connection.state.room?.live?.state).toBe("running");
  });

  it("signs a TV in with screen, shows the code and then the room", () => {
    const { connection, socket } = connect(true);
    expect(socket.sent).toEqual([{ type: "screen", deltas: true }]);
    socket.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: 1000 });
    expect(connection.state).toMatchObject({ status: "online", pairing: { code: "ABCD-EFGH" } });
    socket.receive({ type: "screen-room", room: screenRoom() });
    expect(connection.state.pairing).toBeUndefined();
    socket.receive({ type: "frame", snapshot: { players: ["p1", "p2"], public: {}, version: 5, tick: 5 } });
    expect(connection.state.screen?.snapshot?.tick).toBe(5);
    connection.reportVisibility();
    expect(socket.sent).toEqual([{ type: "screen", deltas: true }]);
  });

  it("treats a missing device cookie as an abort so the page fetches one", () => {
    const { connection, socket } = connect(true);
    socket.receive({ type: "error", code: "no-device", message: "kein Gerät" });
    expect(connection.state.fatal?.code).toBe("no-device");
  });

  const tick = (version: number) => [
    { op: "set", path: ["version"], value: version },
    { op: "set", path: ["tick"], value: version },
  ];
  const resyncs = (socket: FakeSocket) => socket.sent.filter((message) => message["type"] === "resync").length;

  it("rebuilds the whole snapshot from delta frames and passes it on to the game", () => {
    const { connection, socket } = connect(false);
    socket.receive({ type: "room", room: raceRoom({ snapshot: { ...raceRoom().snapshot!, public: { drawing: "M0,0", pos: { p1: 0, p2: 0 } } } }) });
    socket.receive({ type: "frame", base: 3, delta: [{ op: "append", path: ["public", "drawing"], text: "L1,1" }, ...tick(4)] });
    socket.receive({ type: "frame", base: 4, delta: [{ op: "set", path: ["public", "pos", "p1"], value: 2 }, ...tick(5)] });
    const whole = { player: "p1", players: ["p1", "p2"], public: { drawing: "M0,0L1,1", pos: { p1: 2, p2: 0 } }, me: {}, moves: [{ type: "run" }], version: 5, tick: 5 };
    expect(connection.state.room?.snapshot).toEqual(whole);
    expect(bridgeUpdate(connection.state.room!, true)?.snapshot).toEqual(whole);
    expect(resyncs(socket)).toBe(0);
  });

  it("rebuilds the snapshot of the TV from delta frames", () => {
    const { connection, socket } = connect(true);
    socket.receive({ type: "screen-room", room: screenRoom() });
    socket.receive({ type: "frame", base: 3, delta: [{ op: "set", path: ["public", "pos", "p2"], value: 1 }, ...tick(4)] });
    expect(connection.state.screen?.snapshot).toEqual({ players: ["p1", "p2"], public: { pos: { p1: 0, p2: 1 } }, version: 4, tick: 4 });
    expect(resyncs(socket)).toBe(0);
  });

  it("applies no delta onto another version or one that does not fit, asks once for the whole snapshot and goes on with deltas", () => {
    const { connection, socket, sockets } = connect(false);
    socket.receive({ type: "room", room: raceRoom() });
    socket.receive({ type: "frame", base: 5, delta: tick(6) });
    expect(connection.state.room?.snapshot?.version).toBe(3);
    expect(socket.sent.at(-1)).toEqual({ type: "resync" });
    socket.receive({ type: "frame", base: 6, delta: tick(7) });
    expect(resyncs(socket)).toBe(1);
    socket.receive({ type: "frame", snapshot: { ...raceRoom().snapshot, version: 8, tick: 8 } });
    socket.receive({ type: "frame", base: 8, delta: tick(9) });
    expect(connection.state.room?.snapshot).toMatchObject({ version: 9, tick: 9, public: { pos: { p1: 0, p2: 0 } } });

    socket.receive({ type: "frame", base: 9, delta: [{ op: "append", path: ["public", "pos"], text: "x" }, ...tick(10)] });
    socket.receive({ type: "frame", base: 9, delta: [{ op: "set", path: ["__proto__", "polluted"], value: true }, ...tick(10)] });
    expect(connection.state.room?.snapshot?.version).toBe(9);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(resyncs(socket)).toBe(2);
    socket.receive({ type: "room", room: raceRoom({ snapshot: { ...raceRoom().snapshot!, version: 11, tick: 11 } }) });
    socket.receive({ type: "frame", base: 11, delta: tick(12) });
    expect(connection.state.room?.snapshot?.version).toBe(12);

    socket.receive({ type: "frame", base: 20, delta: tick(21) });
    expect(resyncs(socket)).toBe(3);
    socket.readyState = 3;
    socket.onclose?.({});
    connection.reconnectNow();
    const next = sockets[1] as FakeSocket;
    next.open();
    next.receive({ type: "room", room: raceRoom({ snapshot: { ...raceRoom().snapshot!, version: 30, tick: 30 } }) });
    next.receive({ type: "frame", base: 29, delta: tick(31) });
    expect(next.sent.at(-1)).toEqual({ type: "resync" });
  });

  it("asks a TV for the whole snapshot too and skips deltas while there is no running room", () => {
    const { connection, socket } = connect(true);
    socket.receive({ type: "screen-room", room: screenRoom({ status: "finished" }) });
    socket.receive({ type: "frame", base: 3, delta: tick(4) });
    expect(connection.state.screen?.snapshot?.version).toBe(3);
    expect(socket.sent.at(-1)).toEqual({ type: "resync" });
  });
});

describe("Devices", () => {
  const phone: Device = { screen: "small", touch: true, pointer: false };
  const tv: Device = { screen: "large", touch: false, pointer: true };

  it("checks the screen class and inputs of a role", () => {
    expect(fitsRole({ inputs: [], screen: "large" }, tv)).toBe(true);
    expect(fitsRole({ inputs: [], screen: "large" }, phone)).toBe(false);
    expect(fitsRole({ inputs: ["touch"], screen: "small" }, tv)).toBe(false);
    expect(fitsRole({ inputs: ["touch", "keyboard"], screen: "small" }, tv)).toBe(true);
  });

  it("labels games by their roles and fits when one role fits", () => {
    const party = { id: "x", name: "X", version: "1", mode: "realtime", players: { min: 2 }, roles: { screen: { inputs: [], screen: "large" as const }, controller: { inputs: ["touch"], screen: "small" as const } } };
    expect(deviceLabel(party)).toBe("Fernseher + Handys");
    expect(deviceLabel({ roles: { player: { inputs: ["touch"], screen: "small" } } })).toBe("jeder am eigenen Gerät");
    expect(fitsGame(party, phone)).toBe(true);
    expect(fitsGame(party, tv)).toBe(true);
    expect(fitsGame({ ...party, roles: { player: { inputs: ["touch"], screen: "medium" } } }, phone)).toBe(false);
  });

  it("labels a game with an optional TV as one for everyone's own device, in both languages", () => {
    const player = { inputs: ["touch"], screen: "small" as const };
    const tv = { inputs: [], screen: "large" as const };
    expect(deviceLabel({ roles: { player, screen: { ...tv, optional: true } } })).toBe("jeder am eigenen Gerät, Fernseher optional");
    expect(deviceLabel({ roles: { player, screen: { ...tv, optional: false } } })).toBe("Fernseher + eigene Geräte");
    expect(deviceLabel({ roles: { player, screen: tv } })).toBe("Fernseher + eigene Geräte");
    try {
      setLanguage("en");
      expect(deviceLabel({ roles: { player, screen: { ...tv, optional: true } } })).toBe("everyone on their own device, TV optional");
      expect(deviceLabel({ roles: { player, screen: tv } })).toBe("TV + own devices");
    } finally {
      setLanguage("de");
    }
  });
});

describe("Display of countdown, pause and error", () => {
  it("counts down without blocking input", () => {
    const root = mount(<LiveOverlay live={{ state: "countdown", remainingMs: 2500, missingSeats: [], screenMissing: false, byHost: false }} members={members} />);
    const overlay = root.querySelector("[data-testid=live-countdown]");
    expect(overlay?.textContent).toContain("3");
    expect(overlay?.textContent).toContain("Gleich geht es los");
  });

  it("names missing players and the TV and lets the host resume", async () => {
    const resume = vi.fn();
    const live: LiveView = { state: "paused", missingSeats: ["p2"], screenMissing: true, byHost: true };
    const root = mount(<LiveOverlay live={live} members={members} host onResume={resume} />);
    expect(root.textContent).toContain("Warte auf Ben");
    expect(root.textContent).toContain("Warte auf den Fernseher");
    expect(root.textContent).toContain("Der Gastgeber hat angehalten");
    await act(async () => button(root, "Weiterspielen")?.click());
    expect(resume).toHaveBeenCalledOnce();
  });

  it("shows the incident number after an error, and retry and abort to the host", () => {
    const root = mount(<LiveOverlay live={{ state: "halted", missingSeats: [], screenMissing: false, byHost: false, incident: "3fa2c91b" }} members={members} host />);
    expect(root.textContent).toContain("Vorfall 3fa2c91b");
    expect(button(root, "Noch einmal versuchen")).toBeDefined();
    expect(button(root, "Partie abbrechen")).toBeDefined();
  });

  it("lets the host pause from the menu", async () => {
    const commands: Command[] = [];
    const root = mount(<Play room={raceRoom()} online command={async (command) => (commands.push(command), { ok: true })} notify={() => {}} onLeave={async () => {}} />);
    await act(async () => (root.querySelector("[aria-haspopup=menu]") as HTMLButtonElement).click());
    await act(async () => button(root, "Anhalten")?.click());
    expect(commands).toEqual([{ type: "pause" }]);
    expect(root.querySelector(".turn")).toBeNull();
  });
});

describe("Review: rate limiting and remaining time", () => {
  async function sendMove(root: HTMLElement): Promise<void> {
    const source = (root.querySelector("iframe") as HTMLIFrameElement).contentWindow;
    await act(async () => {
      dispatchEvent(new MessageEvent("message", { data: { gamehearth: 1, type: "move", id: 1, action: { type: "run" }, expectedVersion: 3 }, source }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("Review 8: does not report rate limiting as a notice on every input in realtime, but does in turn-based games", async () => {
    const notices: string[] = [];
    const answer = async () => ({ ok: false as const, code: "rate-limited", message: "zu schnell" });
    const root = mount(<Play room={raceRoom()} online command={answer} notify={(text) => notices.push(text)} onLeave={async () => {}} />);
    await sendMove(root);
    expect(notices).toEqual([]);
    act(() => render(null, container));
    container.remove();
    const turnBased = mount(
      <Play room={raceRoom({ snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 3 } })} online command={answer} notify={(text) => notices.push(text)} onLeave={async () => {}} />,
    );
    await sendMove(turnBased);
    expect(notices).toEqual(["Zu viele Versuche in kurzer Zeit, bitte kurz warten."]);
  });

  it("Review 6: renews the code on the TV after the remaining time from the server, not by its own clock", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      mount(
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
      const ws = sockets[0] as FakeSocket;
      act(() => ws.open());
      act(() => ws.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: 0, expiresInMs: 600_000 }));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(ws.sent).toEqual([{ type: "screen", deltas: true }]);
      act(() => {
        vi.advanceTimersByTime(520_000);
      });
      expect(ws.sent).toEqual([{ type: "screen", deltas: true }, { type: "screen", deltas: true }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TV in the lobby", () => {
  it("shows paired TVs, pairs by code and requires a TV to start", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: 9 }), { status: 201 }));
    const notices: string[] = [];
    const room = raceRoom({ status: "lobby", live: undefined, snapshot: undefined, screens: [{ id: 7, connected: false }], canStart: false });
    const root = mount(<Lobby room={room} online command={async () => ({ ok: true })} notify={(text) => notices.push(text)} onLeave={async () => {}} />);
    expect(root.querySelector("[data-testid=screens]")?.textContent).toContain("Fernseher 1");
    expect(root.textContent).toContain("Zum Starten muss ein Fernseher gekoppelt und verbunden sein.");
    const input = root.querySelector("[data-testid=screens] input") as HTMLInputElement;
    await act(async () => {
      input.value = "abcd-efgh";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(root, "Koppeln")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/ABC234/screens", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "abcd-efgh" }) }));
    expect(notices).toEqual(["Fernseher gekoppelt"]);
  });

  it("lets the host start a game with an optional TV without one, and still offers pairing", () => {
    const optional = { ...race, roles: ["player", "screen"], screenOptional: true };
    const room = raceRoom({ status: "lobby", game: optional, live: undefined, snapshot: undefined, screens: [], canStart: true });
    const root = mount(<Lobby room={room} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const card = root.querySelector("[data-testid=screens]");
    expect(card?.querySelector(".card-head")?.textContent).toBe("Fernseheroptional");
    expect(button(root, "Koppeln")).toBeDefined();
    expect(button(root, "Dieses Gerät als Fernseher nutzen")).toBeDefined();
    expect(root.textContent).not.toContain("Zum Starten muss ein Fernseher gekoppelt und verbunden sein.");
    expect(button(root, "Partie starten")?.disabled).toBe(false);
    act(() => render(null, container));
    container.remove();
    const required = mount(<Lobby room={raceRoom({ status: "lobby", live: undefined, snapshot: undefined, screens: [], canStart: false })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(required.querySelector("[data-testid=screens] .card-head")?.textContent).toBe("Fernsehernötig zum Starten");
    expect(required.textContent).toContain("Zum Starten muss ein Fernseher gekoppelt und verbunden sein.");
    expect(button(required, "Partie starten")?.disabled).toBe(true);
  });

  it("shows the TV section only for games with a TV", () => {
    const room = raceRoom({ status: "lobby", game: { ...race, roles: ["player"] }, live: undefined, snapshot: undefined, screens: [] });
    const root = mount(<Lobby room={room} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(root.querySelector("[data-testid=screens]")).toBeNull();
  });
});

describe("TV page", () => {
  function tv() {
    const sockets: FakeSocket[] = [];
    const root = mount(
      <TvScreen
        prepare={async () => undefined}
        createConnection={(handlers) =>
          new RoomConnection({
            code: "",
            url: "ws://test/ws",
            screen: true,
            timers,
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
    return { root, socket: async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return sockets[0] as FakeSocket;
    } };
  }

  it("shows first the pairing code, then the lobby with the room code, then the game", async () => {
    const { root, socket } = tv();
    const ws = await socket();
    act(() => ws.open());
    act(() => ws.receive({ type: "pairing", code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 }));
    expect(root.querySelector("[data-testid=tv-code]")?.textContent).toBe("ABCD-EFGH");
    expect(root.querySelector("svg.qr")).not.toBeNull();
    act(() => ws.receive({ type: "screen-room", room: screenRoom({ status: "lobby", snapshot: undefined }) }));
    expect(root.querySelector("[data-testid=tv-room-code]")?.textContent).toBe("ABC234");
    expect(root.textContent).toContain("Anna");
    expect(root.querySelector("[data-testid=tv-options]")).toBeNull();
    const tempo = { spec: { tempo: { label: "Tempo", type: "choice" as const, default: 1, choices: [{ value: 1, label: "gemütlich" }, { value: 2, label: "flott" }] }, joker: { label: "Joker", type: "boolean" as const, default: false } }, values: { tempo: 2, joker: false } };
    act(() => ws.receive({ type: "screen-room", room: screenRoom({ status: "lobby", snapshot: undefined, options: tempo }) }));
    expect(root.querySelector("[data-testid=tv-options]")?.textContent).toBe("TempoflottJokerNein");
    act(() => ws.receive({ type: "screen-room", room: screenRoom({ live: { state: "countdown", remainingMs: 1000, missingSeats: [], screenMissing: false, byHost: false } }) }));
    expect(root.querySelector("[data-testid=tv-game] iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });
});
