// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command, CommandResult, MemberView, RoomView } from "../src/protocol";
import { Play } from "../src/screens/play";
import { errorText, setLanguage } from "../src/texts";
import { isMyTurn, pageTitle } from "../src/turn";

const reihum = { id: "reihum", name: "Reihum", version: "0.1.0", client: "/games/reihum/0.1.0+abcdefabcdef/", bots: true as const };
const anna: MemberView = { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true };
const ben: MemberView = { id: 2, name: "Ben", seat: "p2", host: false, guest: true, deleted: false, you: false, connected: false };

function room(overrides: Partial<RoomView> = {}): RoomView {
  return {
    code: "ABC234",
    game: reihum,
    status: "running",
    round: 1,
    players: { min: 2, max: 4 },
    maxMembers: 4,
    members: [anna, ben],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [{ type: "pick" }], version: 3 },
    ...overrides,
  } as unknown as RoomView;
}

let container: HTMLElement | undefined;

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container as HTMLElement));
  return container;
}

function recorder(answer: CommandResult = { ok: true }) {
  const commands: Command[] = [];
  return { commands, command: async (next: Command) => (commands.push(next), answer) };
}

async function openMenu(root: HTMLElement): Promise<string[]> {
  await act(async () => (root.querySelector("[aria-haspopup=menu]") as HTMLButtonElement).click());
  return [...root.querySelectorAll("[role=menu] button")].map((item) => item.textContent?.trim() ?? "");
}

beforeEach(() => setLanguage("de"));

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
  setLanguage("de");
});

describe("Review 15", () => {
  it("does not say it is your turn while a bot plays your seat", () => {
    const own = room();
    expect(isMyTurn(own)).toBe(true);
    const autopilot = room({ you: { ...own.you, autopilot: true } });
    expect(isMyTurn(autopilot)).toBe(false);
    expect(pageTitle(autopilot)).not.toContain("Du bist dran");
  });

  it("has a text for bot-playing in both languages", () => {
    expect(errorText("bot-playing", "A bot is playing your seat; take it back first")).toBe("Gerade spielt ein Bot für dich. Hol dir deinen Platz zurück, um selbst zu spielen.");
    setLanguage("en");
    expect(errorText("bot-playing", "A bot is playing your seat; take it back first")).toBe("A bot is playing for you right now. Take your seat back to play yourself.");
  });

  it("lets a host on autopilot resume a paused or halted realtime match from the menu", async () => {
    for (const state of ["paused", "halted"] as const) {
      const { commands, command } = recorder();
      const paused = room({
        you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, autopilot: true },
        members: [{ ...anna, autopilot: true }, ben],
        snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 3, tick: 9 } as unknown as NonNullable<RoomView["snapshot"]>,
        live: { state, missingSeats: [], screenMissing: false, byHost: state === "paused", ...(state === "halted" ? { incident: "abc123" } : {}) },
      });
      const root = mount(<Play room={paused} online command={command} notify={() => {}} onLeave={async () => {}} />);
      const items = await openMenu(root);
      expect(items).toContain("Weiterspielen");
      const resume = [...root.querySelectorAll<HTMLButtonElement>("[role=menu] button")].find((item) => item.textContent?.trim() === "Weiterspielen");
      await act(async () => resume?.click());
      expect(commands).toEqual([{ type: "resume" }]);
      act(() => render(null, container as HTMLElement));
      container?.remove();
      container = undefined;
    }
  });

  it("asks differently before a bot takes over a deleted seat", async () => {
    const root = mount(<Play room={room({ members: [anna, { ...ben, deleted: true, name: "" }] })} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    await openMenu(root);
    const item = [...root.querySelectorAll<HTMLButtonElement>("[role=menu] button")].find((candidate) => candidate.textContent?.trim() === "An Bot geben: Gelöscht");
    await act(async () => item?.click());
    const text = root.querySelector("[role=alertdialog]")?.textContent ?? "";
    expect(text).toContain("Einen Bot für diesen gelöschten Platz spielen lassen?");
    expect(text).not.toContain("Gelöschts");
  });
});
