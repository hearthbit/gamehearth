import { connect, createTimeline, lerp, type GameConnection, type ScreenConnection } from "@gamehearth/sdk/client";
import { goal, type RaceAction, type RaceState } from "../../src/index";

const colors = ["#ffb703", "#8ecae6", "#90be6d", "#f28482"];

function color(seat: string): string {
  return colors[(Number(seat.slice(1)) - 1) % colors.length] ?? "#ffffff";
}

function winnerText(winners: readonly string[], names: Record<string, { name: string }>): string {
  return winners.length === 0 ? "Niemand gewinnt" : `Gewonnen: ${winners.map((seat) => names[seat]?.name ?? seat).join(", ")}`;
}

function startScreen(app: HTMLElement, game: ScreenConnection<RaceState>): void {
  const timeline = createTimeline(game);
  const lanes = new Map<string, { runner: HTMLElement; name: HTMLElement; lane: HTMLElement }>();
  const result = document.createElement("p");
  result.className = "result";
  result.dataset["testid"] = "result";
  const build = () => {
    const { snapshot, players } = game.current;
    for (const seat of snapshot.players) {
      if (!lanes.has(seat)) {
        const lane = document.createElement("div");
        lane.className = "lane";
        lane.dataset["testid"] = `lane-${seat}`;
        const runner = document.createElement("div");
        runner.className = "runner";
        runner.style.background = color(seat);
        runner.textContent = seat.slice(1);
        const name = document.createElement("span");
        name.className = "name";
        lane.append(runner, name);
        app.append(lane);
        lanes.set(seat, { runner, name, lane });
      }
      const entry = lanes.get(seat);
      if (entry !== undefined) {
        entry.name.textContent = players[seat]?.name ?? seat;
      }
    }
    app.append(result);
    result.textContent = snapshot.result === undefined ? "" : winnerText(snapshot.result.winners, players);
  };
  game.onUpdate(build);
  const draw = () => {
    const frame = timeline.frame();
    if (frame !== undefined) {
      for (const [seat, entry] of lanes) {
        const pos = lerp(frame.from.public.pos[seat] ?? 0, frame.to.public.pos[seat] ?? 0, frame.alpha);
        const width = entry.lane.clientWidth - 48;
        entry.runner.style.transform = `translateX(${(pos / goal) * Math.max(width, 0)}px)`;
        entry.lane.dataset["pos"] = pos.toFixed(2);
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

function startController(app: HTMLElement, game: GameConnection<RaceState, RaceAction>): void {
  const status = document.createElement("p");
  status.dataset["testid"] = "status";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "run";
  button.dataset["testid"] = "run";
  button.textContent = "Laufen";
  button.style.background = color(game.seat);
  button.setAttribute("aria-pressed", "false");
  app.append(status, button);
  let held = false;
  const send = (run: boolean) => {
    if (held === run) {
      return;
    }
    held = run;
    button.setAttribute("aria-pressed", String(run));
    void game.move({ type: run ? "run" : "stop" });
  };
  button.addEventListener("pointerdown", (event) => {
    button.setPointerCapture(event.pointerId);
    send(true);
  });
  button.addEventListener("pointerup", () => send(false));
  button.addEventListener("pointercancel", () => send(false));
  addEventListener("keydown", (event) => event.key === " " && send(true));
  addEventListener("keyup", (event) => event.key === " " && send(false));
  game.onUpdate(({ snapshot, players }) => {
    const pos = snapshot.public.pos[game.seat] ?? 0;
    status.textContent =
      snapshot.result === undefined ? `${players[game.seat]?.name ?? game.seat}: ${pos} von ${goal}` : winnerText(snapshot.result.winners, players);
    status.dataset["pos"] = String(pos);
  });
}

async function start(): Promise<void> {
  const app = document.getElementById("app");
  if (app === null) {
    return;
  }
  try {
    const game = await connect<RaceState, RaceAction>({ screen: true });
    if (game.role === "screen") {
      startScreen(app, game);
    } else {
      startController(app, game);
    }
  } catch (error) {
    app.textContent = `Wettlauf läuft nur in Gamehearth. ${error instanceof Error ? error.message : ""}`;
  }
}

void start();
