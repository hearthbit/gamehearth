// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeUpdate } from "../src/game-bridge";
import type { Command, RoomOptions, RoomView } from "../src/protocol";
import { Lobby } from "../src/screens/lobby";

const options: RoomOptions = {
  spec: {
    runden: {
      label: "Runden",
      type: "choice",
      default: 3,
      choices: [
        { value: 2, label: "2 Runden" },
        { value: 3, label: "3 Runden" },
      ],
    },
    joker: { label: "Joker", type: "boolean", default: false },
  },
  values: { runden: 3, joker: true },
};

function room(host: boolean, extra: Partial<RoomView> = {}): RoomView {
  return {
    code: "ABC234",
    game: { id: "gluecksrad", name: "Glücksrad", version: "0.1.0", client: "/games/gluecksrad/0.1.0+abcdefabcdef/" },
    status: "lobby",
    round: 1,
    players: { min: 1, max: 4 },
    maxMembers: 4,
    members: [
      { id: 1, name: "Anna", seat: null, host: true, guest: false, deleted: false, you: host, connected: true },
      { id: 2, name: "Ben", seat: null, host: false, guest: true, deleted: false, you: !host, connected: true },
    ],
    you: host ? { id: 1, name: "Anna", seat: null, host: true, guest: false, deleted: false } : { id: 2, name: "Ben", seat: null, host: false, guest: true, deleted: false },
    canStart: host,
    options,
    ...extra,
  };
}

let container: HTMLElement | undefined;

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container as HTMLElement));
  return container;
}

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

describe("Options in the lobby", () => {
  it("lets the host choose and sends only real changes", async () => {
    const commands: Command[] = [];
    const root = mount(<Lobby room={room(true)} online command={async (command) => (commands.push(command), { ok: true })} notify={() => {}} onLeave={async () => {}} />);
    const runden = root.querySelector("#option-runden") as HTMLSelectElement;
    const joker = root.querySelector("#option-joker") as HTMLSelectElement;
    expect(runden.value).toBe("3");
    expect(joker.value).toBe("true");
    expect([...runden.options].map((option) => option.textContent)).toEqual(["2 Runden", "3 Runden"]);
    await act(async () => {
      runden.value = "2";
      runden.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      joker.value = "false";
      joker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      joker.value = "true";
      joker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(commands).toEqual([
      { type: "set-option", name: "runden", value: 2 },
      { type: "set-option", name: "joker", value: false },
    ]);
  });

  it("only shows the choice to other players", () => {
    const root = mount(<Lobby room={room(false)} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(root.querySelector("select")).toBeNull();
    expect(root.querySelector("[data-testid=option-runden]")?.textContent).toBe("3 Runden");
    expect(root.querySelector("[data-testid=option-joker]")?.textContent).toBe("Ja");
    expect(root.querySelector("[data-testid=room-options]")?.textContent).toContain("Anna stellt die Optionen ein.");
  });

  it("shows no card for games without options", () => {
    const { options: _options, ...plain } = room(true);
    const root = mount(<Lobby room={plain} online command={async () => ({ ok: true })} notify={() => {}} onLeave={async () => {}} />);
    expect(root.querySelector("[data-testid=room-options]")).toBeNull();
  });
});

describe("Options in the bridge", () => {
  it("gives the game the options of the match, and an empty object without options", () => {
    const snapshot = { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 1 };
    const seated = { ...room(true), status: "running" as const, you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false }, snapshot };
    seated.members = seated.members.map((member) => (member.id === 1 ? { ...member, seat: "p1" } : member));
    expect(bridgeUpdate(seated, true)?.options).toEqual({ runden: 3, joker: true });
    const { options: _options, ...plain } = seated;
    expect(bridgeUpdate(plain, true)?.options).toEqual({});
  });
});
