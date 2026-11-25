import { botMove, createMatch, stepMatch, tickMs, type Match, type ProfileChange } from "@gamehearth/sdk/platform";
import manifest from "../manifest.json";
import { describe, expect, it } from "vitest";
import tag, { catcherSpeed, fieldWidth, freezeTicks, radius, runnerSpeed, startPoint, tagBackTicks, ticksPerSecond, type Options, type TagAction, type TagState } from "../src/index";

type TagMatch = Match<TagState, TagAction>;

function start(players = 2, seed = "tag", options: Options = { duration: 60 }): TagMatch {
  const created = createMatch(tag, { playerCount: players, seed, options });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.match;
}

function step(match: TagMatch, inputs: { player: string; action: TagAction }[] = [], times = 1): TagMatch {
  let current = match;
  for (let i = 0; i < times; i++) {
    const outcome = stepMatch(tag, current, { inputs: i === 0 ? inputs : [], now: 0, dt: tickMs }, { catalog: manifest });
    if (!outcome.ok) {
      throw new Error(outcome.error.message);
    }
    current = outcome.match;
  }
  return current;
}

function steer(player: string, dir: TagAction["dir"]) {
  return { player, action: { type: "steer", dir } as TagAction };
}

function placed(match: TagMatch, changes: (state: TagState) => void): TagMatch {
  const copy = JSON.parse(JSON.stringify(match)) as TagMatch;
  changes(copy.state);
  return copy;
}

describe("Tag", () => {
  it("spreads everyone out, draws a catcher by lot and holds them back briefly to give the others a head start", () => {
    const match = start(3);
    expect(Object.keys(match.state.public.pos)).toEqual(["p1", "p2", "p3"]);
    expect(match.state.public.pos["p1"]).toEqual(startPoint(0, 3));
    expect(match.players).toContain(match.state.public.catcher);
    expect(match.state.public.frozen).toBe(freezeTicks);
    expect(match.state.public.ticksLeft).toBe(60 * ticksPerSecond);
  });

  it("takes the duration from the option", () => {
    expect(start(2, "short", { duration: 30 }).state.public.ticksLeft).toBe(30 * ticksPerSecond);
    expect(start(2, "long", { duration: 90 }).state.public.ticksLeft).toBe(90 * ticksPerSecond);
  });

  it("draws different catchers for different seeds", () => {
    const catchers = new Set(Array.from({ length: 20 }, (_, index) => start(4, `seed-${index}`).state.public.catcher));
    expect(catchers.size).toBeGreaterThan(1);
  });

  it("moves runners in the held direction and keeps them on the field", () => {
    let match = placed(start(2), (state) => {
      state.public.catcher = "p1";
      state.public.pos["p2"] = { x: fieldWidth - radius - 2, y: 100 };
    });
    match = step(match, [steer("p2", "right")]);
    expect(match.state.public.pos["p2"]).toEqual({ x: fieldWidth - radius, y: 100 });
    match = step(match, [steer("p2", "up")], 2);
    expect(match.state.public.pos["p2"]).toEqual({ x: fieldWidth - radius, y: 100 - 2 * runnerSpeed });
  });

  it("releases the catcher only after the head start and then lets them run faster", () => {
    let match = placed(start(2), (state) => {
      state.public.catcher = "p1";
      state.public.pos["p1"] = { x: 50, y: 50 };
      state.public.pos["p2"] = { x: 300, y: 200 };
    });
    match = step(match, [steer("p1", "right")], freezeTicks);
    expect(match.state.public.pos["p1"]).toEqual({ x: 50, y: 50 });
    match = step(match, [], 1);
    expect(match.state.public.pos["p1"]).toEqual({ x: 50 + catcherSpeed, y: 50 });
  });

  it("makes the touched player the catcher, freezes them briefly and protects the old catcher from being tagged straight back", () => {
    let match = placed(start(2), (state) => {
      state.public.catcher = "p1";
      state.public.frozen = 0;
      state.public.pos["p1"] = { x: 100, y: 100 };
      state.public.pos["p2"] = { x: 100 + 2 * radius + 3, y: 100 };
    });
    match = step(match, [steer("p1", "right")]);
    expect(match.state.public).toMatchObject({ catcher: "p2", frozen: freezeTicks, tagBack: "p1", tagBackLeft: tagBackTicks });
    match = step(match, [steer("p1", "none")], tagBackTicks - 1);
    expect(match.state.public.catcher).toBe("p2");
    match = step(match, [], 1);
    expect(match.state.public).toMatchObject({ catcher: "p1", tagBack: "p2" });
  });

  it("counts the time as catcher and lets the one with the shortest time win when time is up", () => {
    let match = placed(start(3), (state) => {
      state.public.catcher = "p2";
      state.public.ticksLeft = 3;
      state.public.caught = { p1: 0, p2: 10, p3: 0 };
    });
    match = step(match, [], 3);
    expect(match.state.public.caught).toEqual({ p1: 0, p2: 13, p3: 0 });
    expect(match.result).toEqual({ winners: ["p1", "p3"] });
  });

  it("gives everyone with the shortest time as catcher a win in the profile at the end", () => {
    let match = placed(start(3), (state) => {
      state.public.catcher = "p2";
      state.public.ticksLeft = 2;
      state.public.caught = { p1: 0, p2: 10, p3: 0 };
    });
    const changes: ProfileChange[] = [];
    for (let tick = 0; tick < 2; tick++) {
      const outcome = stepMatch(tag, match, { inputs: [], now: 0, dt: tickMs }, { catalog: manifest });
      if (!outcome.ok) {
        throw new Error(outcome.error.message);
      }
      changes.push(...(outcome.changes ?? []));
      match = outcome.match;
    }
    expect(changes).toEqual([
      { player: "p1", op: "stat", id: "wins", value: 1 },
      { player: "p3", op: "stat", id: "wins", value: 1 },
    ]);
  });

  it("lets the catcher's bot chase the nearest player and the other bots run away from the catcher", () => {
    const match = placed(start(3), (state) => {
      state.public.catcher = "p1";
      state.public.pos = { p1: { x: 200, y: 120 }, p2: { x: 260, y: 120 }, p3: { x: 200, y: 80 } };
    });
    const choice = (player: string) => botMove(tag, match, player, { now: 0 });
    expect(choice("p1")).toMatchObject({ chosen: "bot", action: { type: "steer", dir: "up" } });
    expect(choice("p2")).toMatchObject({ chosen: "bot", action: { type: "steer", dir: "right" } });
    expect(choice("p3")).toMatchObject({ chosen: "bot", action: { type: "steer", dir: "up" } });
    const steering = placed(match, (state) => {
      state.public.dir["p2"] = "right";
    });
    expect(botMove(tag, steering, "p2", { now: 0 })).toEqual({ ok: true, chosen: "none" });
  });

  it("lets a cornered runner's bot slip along the wall instead of pressing into it", () => {
    const match = placed(start(2), (state) => {
      state.public.catcher = "p1";
      state.public.pos = { p1: { x: 300, y: 120 }, p2: { x: fieldWidth - radius, y: 100 } };
    });
    expect(botMove(tag, match, "p2", { now: 0 })).toMatchObject({ chosen: "bot", action: { type: "steer", dir: "up" } });
  });

  it.each([2, 4, 6])("ends a match of %i bots without a single bot problem, and the catcher really catches", (players) => {
    let match = start(players, `bots-${players}`, { duration: 30 });
    for (let tick = 0; tick < 30 * ticksPerSecond + 5 && match.result === undefined; tick++) {
      const outcome = stepMatch(tag, match, { inputs: [], now: 0, dt: tickMs, bots: match.players }, { catalog: manifest });
      if (!outcome.ok) {
        throw new Error(outcome.error.message);
      }
      expect(outcome.bots).toBeUndefined();
      match = outcome.match;
    }
    expect(match.result).toBeDefined();
    expect(Object.values(match.state.public.caught).filter((ticks) => ticks > 0).length).toBeGreaterThan(1);
  });

  it("accepts no more inputs after the end", () => {
    const match = placed(start(2), (state) => {
      state.public.ticksLeft = 1;
    });
    const ended = step(match, [], 1);
    expect(ended.moves).toEqual({ p1: [], p2: [] });
  });
});
