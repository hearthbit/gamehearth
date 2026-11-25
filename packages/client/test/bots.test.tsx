// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeUpdate } from "../src/game-bridge";
import { botName, memberName, seatName } from "../src/language";
import type { Command, CommandResult, LiveView, MemberView, RoomView, ScreenView } from "../src/protocol";
import { Lobby } from "../src/screens/lobby";
import { Play } from "../src/screens/play";
import { TvScreen } from "../src/screens/tv";
import { errorText, setLanguage } from "../src/texts";
import { de } from "../src/texts/de";
import { en } from "../src/texts/en";
import { RoomConnection, type SocketLike } from "../src/connection";
import { LiveOverlay } from "../src/ui/live";

const mauMau = { id: "mau-mau", name: "Mau-Mau", version: "0.5.0", client: "/games/mau-mau/0.5.0+abcdefabcdef/", bots: true as const };

const anna: MemberView = { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true };
const ben: MemberView = { id: 2, name: "Ben", seat: "p2", host: false, guest: true, deleted: false, you: false, connected: false };
const clara: MemberView = { id: 3, name: "Clara", seat: "p3", host: false, guest: false, deleted: false, you: false, connected: true };
const rita: MemberView = { id: 4, name: "", seat: "p4", host: false, guest: false, deleted: false, you: false, connected: false, bot: 1 };
const dora: MemberView = { id: 5, name: "Dora", seat: "p5", host: false, guest: false, deleted: false, you: false, connected: false, autopilot: true };
const watcher: MemberView = { id: 6, name: "Emil", seat: null, host: false, guest: false, deleted: false, you: false, connected: false };

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

function room(overrides: Loose<RoomView> = {}): RoomView {
  const value: Record<string, unknown> = {
    code: "ABC234",
    game: mauMau,
    status: "running",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [anna, ben, clara, rita],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2", "p3", "p4"], public: {}, me: {}, moves: [], version: 3 },
    ...overrides,
  };
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as RoomView;
}

function lobbyRoom(overrides: Loose<RoomView> = {}): RoomView {
  return room({ status: "lobby", snapshot: undefined, canStart: true, members: [anna, { ...ben, connected: true }, { ...rita, seat: null }], ...overrides });
}

function guestView(base: RoomView): RoomView {
  return {
    ...base,
    members: base.members.map((member) => ({ ...member, you: member.id === 2, ...(member.id === 2 ? { connected: true } : {}) })),
    you: { id: 2, name: "Ben", seat: "p2", host: false, guest: true, deleted: false },
  };
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

beforeEach(() => setLanguage("de"));

afterEach(() => {
  unmount();
  setLanguage("de");
  vi.restoreAllMocks();
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const button = (root: HTMLElement, text: string) => buttons(root).find((candidate) => candidate.textContent?.replace("🤖", "").trim() === text);
const labels = (root: HTMLElement) => buttons(root).map((candidate) => candidate.textContent?.trim() ?? "");

function recorder(answer: CommandResult = { ok: true }) {
  const commands: Command[] = [];
  return { commands, command: async (next: Command) => (commands.push(next), answer) };
}

async function openMenu(root: HTMLElement): Promise<string[]> {
  await act(async () => (root.querySelector("[aria-haspopup=menu]") as HTMLButtonElement).click());
  return [...root.querySelectorAll("[role=menu] button")].map((item) => item.textContent?.trim() ?? "");
}

async function choose(root: HTMLElement, label: string): Promise<void> {
  const item = [...root.querySelectorAll<HTMLButtonElement>("[role=menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(item, label).toBeDefined();
  await act(async () => item?.click());
}

async function answer(root: HTMLElement, label: string): Promise<void> {
  const dialog = root.querySelector("[role=alertdialog]") as HTMLElement;
  expect(dialog).not.toBeNull();
  await act(async () => button(dialog, label)?.click());
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Bot names", () => {
  it("names bots with playful names and a robot sign in German and English, with a counter beyond the list", () => {
    for (const table of [de, en]) {
      expect(table.botNames.length).toBeGreaterThanOrEqual(8);
      expect(new Set(table.botNames).size).toBe(table.botNames.length);
    }
    expect(botName(1)).toBe("Robo-Rita 🤖");
    expect(botName(2)).toBe("Blechbert 🤖");
    expect(botName(de.botNames.length)).toBe(`${de.botNames.at(-1)} 🤖`);
    expect(botName(de.botNames.length + 1)).toBe("Robo-Rita 2 🤖");
    expect(botName(de.botNames.length + 2)).toBe("Blechbert 2 🤖");
    expect(botName(2 * de.botNames.length + 1)).toBe("Robo-Rita 3 🤖");
    setLanguage("en");
    expect(botName(2)).toBe("Tin Tim 🤖");
    expect(botName(en.botNames.length + 3)).toBe("Bolt Betty 2 🤖");
  });

  it("uses the bot name for lobby bots and keeps the person's name plus a robot sign on autopilot", () => {
    expect(memberName(rita)).toBe("Robo-Rita 🤖");
    expect(memberName(ben)).toBe("Ben");
    expect(memberName({ ...ben, deleted: true })).toBe("Gelöscht");
    expect(seatName(dora)).toBe("Dora 🤖");
    expect(seatName(rita)).toBe("Robo-Rita 🤖");
    expect(seatName(ben)).toBe("Ben");
    expect(memberName(dora)).toBe("Dora");
  });

  it("gives the game bot seats and autopilot seats as bots that are always there", () => {
    const update = bridgeUpdate(room({ members: [anna, ben, rita, dora] }), true);
    expect(update?.players).toEqual({
      p1: { name: "Anna", connected: true, you: true },
      p2: { name: "Ben", connected: false, you: false },
      p4: { name: "Robo-Rita 🤖", connected: true, you: false, bot: true },
      p5: { name: "Dora 🤖", connected: true, you: false, bot: true },
    });
    setLanguage("en");
    expect(bridgeUpdate(room({ members: [anna, { ...rita, bot: 2 }] }), true)?.players["p4"]).toEqual({ name: "Tin Tim 🤖", connected: true, you: false, bot: true });
  });

  it("has a text for every new error code in both languages", () => {
    const codes = ["not-in-lobby", "no-bots", "member-connected", "already-bot", "not-handed-over", "unknown-member", "room-full", "not-host", "not-running"];
    for (const language of ["de", "en"] as const) {
      setLanguage(language);
      for (const code of codes) {
        expect(errorText(code, "fallback"), `${language} ${code}`).not.toBe("fallback");
      }
    }
    expect(errorText("not-in-lobby", "x")).toBe("That only works in the lobby, before the start.");
    expect(errorText("made-up", "fallback")).toBe("fallback");
  });
});

describe("Bots in the lobby", () => {
  it("lets the host add a bot and remove one without asking, and counts bots as players", async () => {
    const { commands, command } = recorder();
    const root = mount(<Lobby room={lobbyRoom()} online command={command} notify={() => {}} onLeave={async () => {}} />);
    const row = [...root.querySelectorAll(".members li")].find((item) => item.textContent?.includes("Robo-Rita"));
    expect(row?.textContent).toContain("Robo-Rita 🤖");
    expect(row?.textContent).toContain("Bot");
    expect(row?.textContent).not.toContain("nicht verbunden");
    expect(root.textContent).toContain("2–6 Spieler nötig, 3 dabei");
    await act(async () => button(root, "Bot hinzufügen")?.click());
    await act(async () => button(row as HTMLElement, "Entfernen")?.click());
    expect(root.querySelector("[role=alertdialog]")).toBeNull();
    expect(commands).toEqual([{ type: "add-bot" }, { type: "kick", member: 4 }]);
  });

  it("still asks before the host removes a person", async () => {
    const { commands, command } = recorder();
    const root = mount(<Lobby room={lobbyRoom()} online command={command} notify={() => {}} onLeave={async () => {}} />);
    const row = [...root.querySelectorAll(".members li")].find((item) => item.textContent?.includes("Ben")) as HTMLElement;
    await act(async () => button(row, "Entfernen")?.click());
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("Ben aus der Lobby entfernen?");
    expect(commands).toEqual([]);
  });

  it("disables adding a bot when the room is full and reports errors from the server", async () => {
    const notices: string[] = [];
    const { commands, command } = recorder({ ok: false, code: "room-full", message: "full" });
    const full = mount(<Lobby room={lobbyRoom({ maxMembers: 3 })} online command={command} notify={(text) => notices.push(text)} onLeave={async () => {}} />);
    expect(button(full, "Bot hinzufügen")?.disabled).toBe(true);
    unmount();
    const free = mount(<Lobby room={lobbyRoom({ maxMembers: 4 })} online command={command} notify={(text) => notices.push(text)} onLeave={async () => {}} />);
    expect(button(free, "Bot hinzufügen")?.disabled).toBe(false);
    await act(async () => button(free, "Bot hinzufügen")?.click());
    expect(commands).toEqual([{ type: "add-bot" }]);
    expect(notices).toEqual(["Der Raum ist voll."]);
  });

  it("offers bots only to the host and only for games with a bot", () => {
    const guest = mount(<Lobby room={guestView(lobbyRoom())} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(button(guest, "Bot hinzufügen")).toBeUndefined();
    expect(labels(guest)).not.toContain("Entfernen");
    expect(guest.textContent).toContain("Robo-Rita 🤖");
    unmount();
    const { bots: _bots, ...plain } = mauMau;
    const host = mount(<Lobby room={lobbyRoom({ game: plain })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(button(host, "Bot hinzufügen")).toBeUndefined();
    expect(labels(host)).toContain("Entfernen");
  });

  it("speaks English too", () => {
    setLanguage("en");
    const root = mount(<Lobby room={lobbyRoom()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(button(root, "Add bot")).toBeDefined();
    expect(root.textContent).toContain("Robo-Rita 🤖");
  });
});

describe("Handing seats over to a bot", () => {
  it("lets you hand your own seat to a bot after asking", async () => {
    const { commands, command } = recorder();
    const root = mount(<Play room={guestView(room())} online command={command} notify={() => {}} onLeave={async () => {}} />);
    expect(await openMenu(root)).toContain("Bot spielt für mich");
    await choose(root, "Bot spielt für mich");
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("Ab jetzt spielt ein Bot deinen Platz");
    await answer(root, "Abbrechen");
    expect(commands).toEqual([]);
    await openMenu(root);
    await choose(root, "Bot spielt für mich");
    await answer(root, "Bot spielen lassen");
    expect(commands).toEqual([{ type: "hand-over", member: 2 }]);
  });

  it("gives the host one entry per seated member without a connected device", async () => {
    const { commands, command } = recorder();
    const root = mount(<Play room={room({ members: [anna, ben, clara, rita, dora, watcher] })} online command={command} notify={() => {}} onLeave={async () => {}} />);
    const items = await openMenu(root);
    expect(items.filter((item) => item.startsWith("An Bot geben"))).toEqual(["An Bot geben: Ben"]);
    expect(items).toContain("Bot spielt für mich");
    await choose(root, "An Bot geben: Ben");
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("Einen Bot für Ben spielen lassen?");
    await answer(root, "An Bot geben");
    expect(commands).toEqual([{ type: "hand-over", member: 2 }]);
  });

  it("offers a deleted seat to the host as well", async () => {
    const root = mount(<Play room={room({ members: [anna, { ...ben, deleted: true, name: "" }] })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(await openMenu(root)).toContain("An Bot geben: Gelöscht");
  });

  it("offers no hand-over to other members, in games without bots, after the match or while a bot already plays", async () => {
    const guest = mount(<Play room={guestView(room({ members: [anna, ben, clara, { ...watcher, seat: "p6" }] }))} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const items = await openMenu(guest);
    expect(items.some((item) => item.startsWith("An Bot geben"))).toBe(false);
    unmount();
    const { bots: _bots, ...plain } = mauMau;
    const without = mount(<Play room={room({ game: plain })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect((await openMenu(without)).some((item) => item.includes("Bot"))).toBe(false);
    unmount();
    const finished = mount(<Play room={room({ status: "finished" })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect((await openMenu(finished)).some((item) => item.includes("Bot"))).toBe(false);
    unmount();
    const autopilot = mount(
      <Play room={room({ you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, autopilot: true } })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />,
    );
    const onAutopilot = await openMenu(autopilot);
    expect(onAutopilot).not.toContain("Bot spielt für mich");
    expect(onAutopilot).toContain("An Bot geben: Ben");
  });

  it("offers the host a hand-over in the pause overlay only for missing seats without a connected device", () => {
    const handed: number[] = [];
    const live: LiveView = { state: "paused", missingSeats: ["p2", "p3"], screenMissing: false, byHost: false };
    const members = [anna, ben, clara];
    const root = mount(<LiveOverlay live={live} members={members} host bots onHandOver={(member) => handed.push(member.id)} />);
    expect(root.textContent).toContain("Warte auf Ben");
    expect(root.textContent).toContain("Warte auf Clara");
    expect(labels(root)).toEqual(["An Bot geben: Ben"]);
    act(() => button(root, "An Bot geben: Ben")?.click());
    expect(handed).toEqual([2]);
    unmount();
    const guest = mount(<LiveOverlay live={live} members={members} bots onHandOver={() => undefined} />);
    expect(labels(guest)).toEqual([]);
    unmount();
    const noBots = mount(<LiveOverlay live={live} members={members} host onHandOver={() => undefined} />);
    expect(labels(noBots)).toEqual([]);
  });

  it("hands over from the pause overlay of the game page after asking", async () => {
    const { commands, command } = recorder();
    const paused = room({ live: { state: "paused", missingSeats: ["p2"], screenMissing: false, byHost: false } });
    const root = mount(<Play room={paused} online command={command} notify={() => {}} onLeave={async () => {}} />);
    act(() => {
      root.querySelector("iframe")?.dispatchEvent(new Event("load"));
    });
    await act(async () => button(root, "An Bot geben: Ben")?.click());
    await answer(root, "An Bot geben");
    expect(commands).toEqual([{ type: "hand-over", member: 2 }]);
  });

  it("names the hand-over in English", async () => {
    setLanguage("en");
    const root = mount(<Play room={room()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const items = await openMenu(root);
    expect(items).toContain("Let a bot play for me");
    expect(items).toContain("Hand to a bot: Ben");
  });
});

describe("Autopilot", () => {
  const onAutopilot = () => room({ you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, autopilot: true }, members: [{ ...anna, autopilot: true }, ben] });

  it("shows that a bot plays for you and takes the seat back", async () => {
    const { commands, command } = recorder();
    const root = mount(<Play room={onAutopilot()} online command={command} notify={() => {}} onLeave={async () => {}} />);
    const overlay = root.querySelector("[data-testid=autopilot]") as HTMLElement;
    expect(overlay.textContent).toContain("Ein Bot spielt für dich");
    expect(root.querySelector("iframe")).not.toBeNull();
    await act(async () => button(overlay, "Zurück ins Spiel")?.click());
    expect(commands).toEqual([{ type: "take-back" }]);
  });

  it("shows nothing of the kind without autopilot or after the match", () => {
    const root = mount(<Play room={room()} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(root.querySelector("[data-testid=autopilot]")).toBeNull();
    unmount();
    const finished = mount(<Play room={{ ...onAutopilot(), status: "finished" }} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(finished.querySelector("[data-testid=autopilot]")).toBeNull();
  });

  it("reports a failed take-back and speaks English", async () => {
    setLanguage("en");
    const notices: string[] = [];
    const root = mount(<Play room={onAutopilot()} online command={async () => ({ ok: false, code: "not-handed-over", message: "no" })} notify={(text) => notices.push(text)} onLeave={async () => {}} />);
    expect(root.textContent).toContain("A bot is playing for you");
    await act(async () => button(root, "Back into the game")?.click());
    expect(notices).toEqual(["No bot is playing for you right now."]);
  });
});

describe("Away seats in a play-on match", () => {
  const playOn = { ...mauMau, mode: "realtime", away: "play-on" as const };

  it("names away seats quietly in the game page's bar, without a pause", () => {
    const live: LiveView = { state: "running", missingSeats: [], awaySeats: ["p2", "p5"], screenMissing: false, byHost: false };
    const root = mount(<Play room={room({ game: playOn, live, members: [anna, ben, dora] })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    act(() => {
      root.querySelector("iframe")?.dispatchEvent(new Event("load"));
    });
    expect(root.querySelector(".bar .away")?.textContent).toBe(" · weg: Ben, Dora 🤖");
    expect(root.querySelector("[data-testid=live-paused]")).toBeNull();
    unmount();
    const none = mount(<Play room={room({ game: playOn, live: { ...live, awaySeats: [] } })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(none.querySelector(".bar .away")).toBeNull();
  });

  it("names away seats on the TV", async () => {
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
    const screen: ScreenView = {
      code: "ABC234",
      screen: 7,
      game: playOn,
      status: "running",
      round: 1,
      players: { min: 2, max: 6 },
      maxMembers: 6,
      members: [anna, ben, rita].map((member) => ({ ...member, you: false })),
      screens: [{ id: 7, connected: true }],
      live: { state: "running", missingSeats: [], awaySeats: ["p2"], screenMissing: false, byHost: false },
      snapshot: { players: ["p1", "p2", "p4"], public: {}, version: 3, tick: 3 },
    };
    act(() => socket.receive({ type: "screen-room", room: screen }));
    expect(root.querySelector("[data-testid=tv-game] .strip .away")?.textContent).toBe("weg: Ben");
    act(() => socket.receive({ type: "screen-room", room: { ...screen, status: "lobby", live: undefined, snapshot: undefined } }));
    expect(root.querySelector(".tv-members")?.textContent).toContain("Robo-Rita 🤖");
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
