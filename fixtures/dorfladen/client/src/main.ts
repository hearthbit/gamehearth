import { connect, type GameUpdate } from "@gamehearth/sdk/client";
import type { Ids, Options, ShopAction, ShopState } from "../../src/index";

const labels: Record<ShopAction["type"], string> = { arbeiten: "Arbeiten (+2 Münzen)", kaufen: "Apfel kaufen (3 Münzen)", essen: "Apfel essen (+3 Punkte)" };

function render(app: HTMLElement, language: string, update: GameUpdate<ShopState, ShopAction, Options, Ids>, move: (action: ShopAction) => void): void {
  const { snapshot, players, profile } = update;
  const state = snapshot.public;
  const name = (seat: string) => players[seat]?.name ?? seat;
  app.replaceChildren();

  const own = document.createElement("p");
  own.className = "profile";
  own.dataset["testid"] = "profile";
  const title = profile.flags.titel;
  own.textContent = `Münzen: ${profile.items.muenze ?? 0} · Äpfel: ${profile.items.apfel ?? 0} · Siege: ${profile.stats.siege ?? 0}${typeof title === "string" ? ` · ${title}` : ""}`;

  const status = document.createElement("p");
  status.dataset["testid"] = "status";
  if (snapshot.result !== undefined) {
    status.textContent = `Gewonnen: ${snapshot.result.winners.map(name).join(", ") || "niemand"}`;
  } else {
    const round = `Runde ${Math.min(state.round, state.lastRound)} von ${state.lastRound}`;
    status.textContent = state.current === snapshot.player ? `${round}: Du bist dran` : `${round}: ${name(state.current)} ist dran`;
  }

  const scores = document.createElement("ul");
  scores.className = "scores";
  for (const seat of snapshot.players) {
    const item = document.createElement("li");
    item.dataset["testid"] = `score-${seat}`;
    item.textContent = `${name(seat)}: ${state.points[seat] ?? 0} Punkte`;
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

  const shown = document.createElement("p");
  shown.className = "language";
  shown.dataset["testid"] = "language";
  shown.textContent = `Sprache: ${language}`;

  app.append(own, status, scores, moves, shown);
}

const app = document.getElementById("app");
if (app !== null) {
  const game = await connect<ShopState, ShopAction, Options, Ids>();
  app.dataset["language"] = game.language;
  document.documentElement.lang = game.language;
  let busy = false;
  const move = (action: ShopAction) => {
    if (busy) {
      return;
    }
    busy = true;
    void game.move(action).finally(() => {
      busy = false;
    });
  };
  game.onUpdate((update) => render(app, game.language, update, move));
}
