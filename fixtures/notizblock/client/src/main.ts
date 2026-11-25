import { connect, isPlaceholder, type GameConnection, type ScreenConnection } from "@gamehearth/sdk/client";
import type { PadAction, PadState } from "../../src/index";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.dataset["testid"] = testid;
  node.textContent = text;
  return node;
}

function renderNotes(list: HTMLElement, state: PadState["public"], names: Record<string, { name: string }>): void {
  list.replaceChildren(
    ...state.notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = `${names[note.by]?.name ?? note.by}: ${note.text}`;
      return item;
    }),
  );
}

function startScreen(app: HTMLElement, game: ScreenConnection<PadState>): void {
  const title = element("h1", "tv-title", "Notizblock");
  const notes = element("ul", "tv-notes");
  const ink = element("p", "tv-ink");
  app.append(title, notes, ink);
  game.onUpdate(({ snapshot, players }) => {
    renderNotes(notes, snapshot.public, players);
    ink.textContent = `Tinte: ${snapshot.public.ink.length}`;
  });
}

function startPlayer(app: HTMLElement, game: GameConnection<PadState, PadAction>): void {
  const row = document.createElement("div");
  const input = element("input", "note-input");
  input.type = "text";
  input.autocomplete = "off";
  input.enterKeyHint = "send";
  input.setAttribute("aria-label", "Notiz");
  const send = element("button", "note-send", "Notieren");
  send.type = "button";
  row.append(input, send);
  const inkButton = element("button", "ink", "Tinte");
  inkButton.type = "button";
  const finish = element("button", "finish", "Fertig");
  finish.type = "button";
  const status = element("p", "status");
  const notes = element("ul", "notes");
  const ink = element("p", "ink-length");
  app.append(row, inkButton, finish, status, notes, ink);
  let drops = 0;
  const submit = () => {
    const text = input.value;
    void game.move({ type: "note", text }).then((result) => {
      status.textContent = result.ok ? "" : result.code;
      if (result.ok) {
        input.value = "";
      }
    });
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      submit();
    }
  });
  const spill = async (points: string, attempt: number): Promise<void> => {
    const result = await game.move({ type: "ink", points });
    if (!result.ok && result.code !== "game-over" && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      await spill(points, attempt + 1);
    }
  };
  inkButton.addEventListener("click", () => {
    drops += 1;
    const points = Array.from({ length: 40 }, (_, index) => "0123456789abcdef"[(drops + index) % 16]).join("");
    void spill(points, 1);
  });
  finish.addEventListener("click", () => void game.move({ type: "finish" }));
  game.onUpdate(({ snapshot, players }) => {
    const note = snapshot.moves.find((move) => move.type === "note");
    const limit = note !== undefined && isPlaceholder(note.text) && "$text" in note.text ? note.text.$text.max : 0;
    input.maxLength = limit;
    input.disabled = note === undefined;
    renderNotes(notes, snapshot.public, players);
    ink.textContent = `Tinte: ${snapshot.public.ink.length}`;
    if (snapshot.result !== undefined) {
      status.textContent = "Vorbei";
    }
  });
}

const app = document.getElementById("app") as HTMLElement;
const game = await connect<PadState, PadAction>({ screen: true });
if (game.role === "screen") {
  startScreen(app, game);
} else {
  startPlayer(app, game);
}
