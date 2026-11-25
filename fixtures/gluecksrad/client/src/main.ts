import { connect, type GameUpdate } from "@gamehearth/sdk/client";
import type { Options, WheelAction, WheelState } from "../../src/index";

const labels: Record<WheelAction["type"], string> = { spin: "Drehen", joker: "Mit Joker drehen" };

function render(app: HTMLElement, update: GameUpdate<WheelState, WheelAction, Options>, move: (action: WheelAction) => void): void {
  const { snapshot, players, options } = update;
  const state = snapshot.public;
  const name = (seat: string) => players[seat]?.name ?? seat;
  app.replaceChildren();

  const settings = document.createElement("p");
  settings.className = "options";
  settings.dataset["testid"] = "options";
  settings.textContent = `${options.runden} Runden, Joker ${options.joker ? "ja" : "nein"}`;

  const status = document.createElement("p");
  status.dataset["testid"] = "status";
  if (snapshot.result !== undefined) {
    status.textContent = `Gewonnen: ${snapshot.result.winners.map(name).join(", ") || "niemand"}`;
  } else {
    const round = `Runde ${Math.min(state.round, state.lastRound)} von ${state.lastRound}`;
    status.textContent = state.current === snapshot.player ? `${round}: Du bist dran` : `${round}: ${name(state.current)} ist dran`;
  }

  const last = document.createElement("p");
  last.dataset["testid"] = "last";
  last.textContent = state.last === null ? "" : `${name(state.last.player)} dreht ${state.last.segment}: ${state.last.points} Punkte`;

  const scores = document.createElement("ul");
  scores.className = "scores";
  for (const seat of snapshot.players) {
    const item = document.createElement("li");
    item.dataset["testid"] = `score-${seat}`;
    item.textContent = `${name(seat)}: ${state.points[seat] ?? 0}`;
    scores.append(item);
  }

  const moves = document.createElement("div");
  moves.className = "moves";
  for (const action of snapshot.moves) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["testid"] = action.type;
    button.textContent = labels[action.type];
    button.addEventListener("click", () => move(action));
    moves.append(button);
  }

  app.append(settings, status, last, scores, moves);
}

const app = document.getElementById("app");
if (app !== null) {
  const game = await connect<WheelState, WheelAction, Options>();
  let busy = false;
  const move = (action: WheelAction) => {
    if (busy) {
      return;
    }
    busy = true;
    void game.move(action).finally(() => {
      busy = false;
    });
  };
  game.onUpdate((update) => render(app, update, move));
}
