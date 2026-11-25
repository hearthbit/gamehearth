import { connect } from "@gamehearth/sdk/client";
import type { TurnAction, TurnState } from "../../src/index";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.dataset["testid"] = testid;
  node.textContent = text;
  return node;
}

const app = document.getElementById("app") as HTMLElement;
const game = await connect<TurnState, TurnAction>();
const turn = element("p", "turn");
const press = element("button", "press", "Drücken");
press.type = "button";
const counts = element("ul", "presses");
const skipped = element("p", "skipped");
const sound = element("p", "sound");
const status = element("p", "status");
app.append(turn, press, counts, skipped, sound, status);

press.addEventListener("click", () => {
  game.sound("blip");
  void game.move({ type: "press" }).then((result) => {
    status.textContent = result.ok ? "" : result.code;
  });
});

const showSound = (on: boolean) => {
  sound.textContent = on ? "Ton: an" : "Ton: aus";
};
showSound(game.soundOn);
game.onSound(showSound);

let finished = false;
game.onUpdate(({ snapshot, players }) => {
  const state = snapshot.public;
  const name = (seat: string) => `${players[seat]?.name ?? seat}${players[seat]?.bot === true ? " (Bot)" : ""}`;
  turn.textContent = `Dran: ${name(state.turn)}`;
  press.disabled = snapshot.moves.length === 0;
  counts.replaceChildren(
    ...Object.entries(state.presses).map(([seat, count]) => {
      const item = document.createElement("li");
      item.textContent = `${name(seat)}: ${count}`;
      return item;
    }),
  );
  skipped.textContent = `Übersprungen: ${state.skipped.map(name).join(", ")}`;
  if (snapshot.result !== undefined && !finished) {
    finished = true;
    status.textContent = "Vorbei";
    game.sound(snapshot.result.winners.includes(game.seat) ? "win" : "lose");
  }
});
