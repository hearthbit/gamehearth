// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, RoomConnection } from "../src/connection";
import type { Command, CommandResult, Me, RoomView } from "../src/protocol";
import { Lobby } from "../src/screens/lobby";
import { Play } from "../src/screens/play";
import { RoomScreen } from "../src/screens/room";
import { SessionContext } from "../src/session";
import { DeviceStorage, type KeyValueStore } from "../src/storage";
import { pageTitle } from "../src/turn";

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function withSession(element: preact.JSX.Element, user: Me | undefined, refresh: () => Promise<void> = async () => undefined): preact.JSX.Element {
  return (
    <SessionContext.Provider value={{ me: { state: "ready", user }, user, refresh, setUser: () => undefined, reload: () => undefined }}>
      {element}
    </SessionContext.Provider>
  );
}

function lobby(overrides: Partial<RoomView> = {}): RoomView {
  return {
    code: "ABC234",
    game: { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", client: "/games/mau-mau/0.1.0+abcdefabcdef/" },
    status: "lobby",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [
      { id: 1, name: "Anna", seat: null, host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Ben", seat: null, host: false, guest: false, deleted: false, you: false, connected: false },
    ],
    you: { id: 1, name: "Anna", seat: null, host: true, guest: false, deleted: false },
    canStart: true,
    ...overrides,
  };
}

function running(moves: unknown[] = []): RoomView {
  return lobby({
    status: "running",
    members: [
      { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Ben", seat: "p2", host: false, guest: false, deleted: false, you: false, connected: true },
    ],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves, version: 3 },
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
  act(() => render(null, container));
  container.remove();
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const button = (root: HTMLElement, text: string) => buttons(root).find((candidate) => candidate.textContent?.trim() === text);

describe("Lobby", () => {
  it("shows code, QR and members and lets the host start", async () => {
    const commands: Command[] = [];
    const root = mount(
      <Lobby room={lobby()} online command={async (command) => (commands.push(command), { ok: true })} notify={() => {}} onLeave={async () => {}} />,
    );
    expect(root.querySelector("[data-testid=room-code]")?.textContent).toBe("ABC234");
    expect(root.querySelector("svg.qr path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(root.textContent).toContain("Anna");
    expect(root.textContent).toContain("nicht verbunden");
    expect(root.textContent).toContain("2–6 Spieler nötig, 2 dabei");
    await act(async () => button(root, "Partie starten")?.click());
    expect(commands).toEqual([{ type: "start" }]);
  });

  it("shows other players a note about the host instead of start, and no remove buttons", () => {
    const root = mount(
      <Lobby
        room={lobby({ you: { id: 2, name: "Ben", seat: null, host: false, guest: false, deleted: false } })}
        online
        command={async () => ({ ok: true })}
        notify={() => {}}
        onLeave={async () => {}}
      />,
    );
    expect(button(root, "Partie starten")).toBeUndefined();
    expect(button(root, "Entfernen")).toBeUndefined();
    expect(root.textContent).toContain("Warte, bis Anna die Partie startet");
  });

  it("asks before removing and reports errors", async () => {
    const notices: string[] = [];
    const commands: Command[] = [];
    const root = mount(
      <Lobby
        room={lobby()}
        online
        command={async (command): Promise<CommandResult> => (commands.push(command), { ok: false, code: "already-started", message: "x" })}
        notify={(text) => notices.push(text)}
        onLeave={async () => {}}
      />,
    );
    await act(async () => button(root, "Entfernen")?.click());
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("Ben aus der Lobby entfernen?");
    const dialogButtons = [...(root.querySelector("[role=alertdialog]")?.querySelectorAll("button") ?? [])];
    await act(async () => dialogButtons.find((candidate) => candidate.textContent === "Entfernen")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands).toEqual([{ type: "kick", member: 2 }]);
    expect(notices).toEqual(["Die Partie in diesem Raum läuft schon."]);
  });

  it("disables actions without connection", () => {
    const root = mount(<Lobby room={lobby()} online={false} command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(button(root, "Partie starten")?.disabled).toBe(true);
    expect(root.textContent).toContain("verbinde neu");
  });
});

describe("Game view", () => {
  it("embeds the game isolated and shows when it is your turn", () => {
    const root = mount(<Play room={running([{ type: "draw" }])} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const frame = root.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBe("/games/mau-mau/0.1.0+abcdefabcdef/");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(root.querySelector(".turn")?.textContent).toBe("Du bist dran");
  });

  it("offers the host abort with confirmation, and a new round after the end", async () => {
    const commands: Command[] = [];
    const command = async (next: Command): Promise<CommandResult> => (commands.push(next), { ok: true });
    const root = mount(<Play room={running()} online command={command} notify={() => {}} onLeave={async () => {}} />);
    await act(async () => root.querySelector<HTMLButtonElement>("button[aria-label=Menü]")?.click());
    await act(async () => button(root, "Partie abbrechen")?.click());
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("Partie für alle abbrechen?");
    const confirmButton = [...(root.querySelector("[role=alertdialog]")?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Partie abbrechen");
    await act(async () => confirmButton?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands).toEqual([{ type: "abort" }]);
    act(() => render(<Play room={{ ...running(), status: "finished" }} online command={command} notify={() => {}} onLeave={async () => {}} />, container));
    expect(root.textContent).toContain("Partie vorbei");
    await act(async () => button(root, "Neue Runde")?.click());
    expect(commands).toEqual([{ type: "abort" }, { type: "new-round" }]);
  });
});

describe("Room", () => {
  const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };

  function fakeConnection(state: ConnectionState = { status: "connecting", room: undefined, fatal: undefined }, command = vi.fn()) {
    return { start: vi.fn(), dispose: vi.fn(), reconnectNow: vi.fn(), command, state } as unknown as RoomConnection;
  }

  it("shows that you were removed and offers the home page", () => {
    let handlers: { onState: (state: ConnectionState) => void } | undefined;
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={() => {}}
          createConnection={(_code, given) => {
            handlers = given;
            return fakeConnection();
          }}
        />,
        anna,
      ),
    );
    expect(root.textContent).toContain("Verbinde");
    act(() => handlers?.onState({ status: "offline", room: undefined, fatal: { code: "removed", message: "x" } }));
    expect(root.textContent).toContain("Du wurdest aus dem Raum entfernt.");
    expect(button(root, "Startseite")).toBeDefined();
  });

  it("goes to the home page after leaving without an error message, even if the server sends removed first", async () => {
    history.replaceState(null, "", "/r/ABC234");
    let handlers: { onState: (state: ConnectionState) => void } | undefined;
    let state: ConnectionState = { status: "online", room: lobby(), fatal: undefined };
    const fake = {
      start: vi.fn(),
      dispose: vi.fn(),
      reconnectNow: vi.fn(),
      get state() {
        return state;
      },
      command: vi.fn(async (): Promise<CommandResult> => {
        state = { status: "offline", room: state.room, fatal: { code: "removed", message: "Du bist nicht mehr Mitglied dieses Raums" } };
        handlers?.onState(state);
        return { ok: false, code: "offline", message: "Die Verbindung zum Server ist abgebrochen." };
      }),
    } as unknown as RoomConnection;
    const notices: string[] = [];
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={(text) => notices.push(text)}
          createConnection={(_code, given) => {
            handlers = given;
            return fake;
          }}
        />,
        anna,
      ),
    );
    act(() => handlers?.onState(state));
    await act(async () => root.querySelector<HTMLButtonElement>("button[aria-label=Menü]")?.click());
    await act(async () => button(root, "Raum verlassen")?.click());
    const confirmButton = [...(root.querySelector("[role=alertdialog]")?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Raum verlassen");
    await act(async () => confirmButton?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(notices).toEqual([]);
    expect(root.textContent).not.toContain("entfernt");
    expect(location.pathname).toBe("/");
  });

  it("stays in the room and reports it when leaving fails without connection", async () => {
    history.replaceState(null, "", "/r/ABC234");
    let handlers: { onState: (state: ConnectionState) => void } | undefined;
    const state: ConnectionState = { status: "online", room: running(), fatal: undefined };
    const fake = fakeConnection(state, vi.fn(async (): Promise<CommandResult> => ({ ok: false, code: "offline", message: "weg" })));
    const notices: string[] = [];
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={(text) => notices.push(text)}
          createConnection={(_code, given) => {
            handlers = given;
            return fake;
          }}
        />,
        anna,
      ),
    );
    act(() => handlers?.onState({ ...state, room: { ...running(), status: "finished" } }));
    await act(async () => root.querySelector<HTMLButtonElement>("button[aria-label=Menü]")?.click());
    await act(async () => button(root, "Raum verlassen")?.click());
    const confirmButton = [...(root.querySelector("[role=alertdialog]")?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Raum verlassen");
    await act(async () => confirmButton?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(notices).toEqual(["Keine Verbindung zum Server."]);
    expect(location.pathname).toBe("/r/ABC234");
  });

  it("shows an error on entering instead of connecting endlessly, and offers ways out", async () => {
    history.replaceState(null, "", "/r/ABC234");
    let handlers: { onState: (state: ConnectionState) => void; onNotice: (code: string, message: string) => void } | undefined;
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={() => {}}
          createConnection={(_code, given) => {
            handlers = given;
            return fakeConnection();
          }}
        />,
        anna,
      ),
    );
    expect(root.querySelector("button[aria-label=Startseite]")).not.toBeNull();
    act(() => handlers?.onNotice("game-unavailable", "Die Spielfassung dieses Raums ist nicht installiert oder beschädigt"));
    expect(root.textContent).toContain("Dieses Spiel ist gerade gesperrt");
    await act(async () => button(root, "Startseite")?.click());
    expect(location.pathname).toBe("/");
  });

  it("offers joining as a guest with the remembered name, sign-in and (review 12a) the language switch, without a session", async () => {
    const storage = new DeviceStorage(memory());
    storage.saveName("Clara");
    const created = vi.fn();
    const root = mount(withSession(<RoomScreen code="XYZ789" storage={storage} notify={() => {}} createConnection={created} />, undefined));
    expect(root.textContent).toContain("Raum XYZ789 beitreten");
    expect(root.querySelector<HTMLInputElement>("#join-name")?.value).toBe("Clara");
    expect(button(root, "Als Gast beitreten")).toBeDefined();
    expect([...root.querySelectorAll(".language-switch button")].map((entry) => entry.textContent)).toEqual(["DE", "EN"]);
    await act(async () => button(root, "Ich habe einen Account")?.click());
    expect(root.querySelector("#login-username")).not.toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("offers an account that is not yet a member joining with its name", () => {
    let handlers: { onState: (state: ConnectionState) => void } | undefined;
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={() => {}}
          createConnection={(_code, given) => {
            handlers = given;
            return fakeConnection();
          }}
        />,
        anna,
      ),
    );
    act(() => handlers?.onState({ status: "offline", room: undefined, fatal: { code: "not-member", message: "x" } }));
    expect(button(root, "Beitreten als Anna")).toBeDefined();
    expect(root.querySelector("#join-name")).toBeNull();
  });

  it("reloads the session when the device was signed out, and reconnects afterwards", async () => {
    let handlers: { onState: (state: ConnectionState) => void } | undefined;
    const refresh = vi.fn(async () => undefined);
    const notices: string[] = [];
    let created = 0;
    const root = mount(
      withSession(
        <RoomScreen
          code="ABC234"
          storage={new DeviceStorage(memory())}
          notify={(text) => notices.push(text)}
          createConnection={(_code, given) => {
            handlers = given;
            created += 1;
            return fakeConnection();
          }}
        />,
        anna,
        refresh,
      ),
    );
    await act(async () => {
      handlers?.onState({ status: "offline", room: undefined, fatal: { code: "signed-out", message: "x" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(["Du wurdest auf diesem Gerät abgemeldet."]);
    expect(created).toBe(2);
    expect(root.textContent).toContain("Verbinde");
  });
});

describe("Title", () => {
  it("shows in the title when it is your turn", () => {
    expect(pageTitle(running([{ type: "draw" }]))).toBe("● Du bist dran · Mau-Mau");
    expect(pageTitle(running())).toBe("Mau-Mau · Gamehearth");
    expect(pageTitle(undefined)).toBe("Gamehearth");
  });
});
