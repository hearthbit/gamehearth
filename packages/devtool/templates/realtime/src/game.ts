import { defineGame, type CatalogOf, type GameState, type PlayerId } from "@gamehearth/sdk";
import manifest from "../manifest.json";

export const fieldWidth = 400;
export const fieldHeight = 240;
export const radius = 10;
export const runnerSpeed = 4;
export const catcherSpeed = 5;
export const ticksPerSecond = 20;
export const freezeTicks = 10;
export const tagBackTicks = 20;

export const directions = ["up", "down", "left", "right", "none"] as const;
export type Direction = (typeof directions)[number];

export interface Point {
  x: number;
  y: number;
}

export interface Public {
  pos: Record<PlayerId, Point>;
  dir: Record<PlayerId, Direction>;
  catcher: PlayerId;
  frozen: number;
  tagBack: PlayerId | null;
  tagBackLeft: number;
  caught: Record<PlayerId, number>;
  ticksLeft: number;
}

export type TagState = GameState<Public, Record<string, never>, Record<string, never>>;

export type TagAction = { type: "steer"; dir: Direction };

export interface Options {
  duration: 30 | 60 | 90;
}

export type Ids = CatalogOf<typeof manifest>;

const steps: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  none: { x: 0, y: 0 },
};

export function startPoint(index: number, count: number): Point {
  const columns = Math.min(count, 3);
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: Math.round(((column + 1) * fieldWidth) / (columns + 1)),
    y: Math.round(((row + 1) * fieldHeight) / (rows + 1)),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function touching(a: Point, b: Point): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= (2 * radius) * (2 * radius);
}

export function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function towards(from: Point, to: Point): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return "none";
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx < 0 ? "left" : "right";
  }
  return dy < 0 ? "up" : "down";
}

export function fleeFrom(me: Point, hunter: Point, current: Direction): Direction {
  let best: Direction = "none";
  let farthest = -1;
  for (const dir of ["up", "down", "left", "right"] as const) {
    const step = steps[dir];
    const next = {
      x: clamp(me.x + step.x * runnerSpeed, radius, fieldWidth - radius),
      y: clamp(me.y + step.y * runnerSpeed, radius, fieldHeight - radius),
    };
    const distance = distanceSquared(next, hunter);
    if (distance > farthest || (distance === farthest && dir === current)) {
      best = dir;
      farthest = distance;
    }
  }
  return best;
}

export function shortestCatchers(caught: Record<PlayerId, number>): PlayerId[] {
  const times = Object.entries(caught);
  const best = Math.min(...times.map(([, ticks]) => ticks));
  return times.filter(([, ticks]) => ticks === best).map(([player]) => player);
}

export const tag = defineGame<TagState, TagAction, Options, Ids>({
  setup({ players, random, options }) {
    const pos: Record<PlayerId, Point> = {};
    const dir: Record<PlayerId, Direction> = {};
    const caught: Record<PlayerId, number> = {};
    players.forEach((player, index) => {
      pos[player] = startPoint(index, players.length);
      dir[player] = "none";
      caught[player] = 0;
    });
    return {
      public: { pos, dir, catcher: random.pick(players), frozen: freezeTicks, tagBack: null, tagBackLeft: 0, caught, ticksLeft: options.duration * ticksPerSecond },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },

  legalMoves(state) {
    if (state.public.ticksLeft <= 0) {
      return [];
    }
    return directions.map((dir) => ({ type: "steer", dir }));
  },

  apply(state, action, { player }) {
    state.public.dir[player] = action.dir;
  },

  tick(state, _dt, { players, profile }) {
    const view = state.public;
    view.ticksLeft -= 1;
    view.caught[view.catcher] = (view.caught[view.catcher] ?? 0) + 1;
    if (view.ticksLeft === 0) {
      for (const winner of shortestCatchers(view.caught)) {
        profile.stat(winner, "wins", 1);
      }
      return;
    }
    for (const player of players) {
      if (player === view.catcher && view.frozen > 0) {
        continue;
      }
      const step = steps[view.dir[player] ?? "none"];
      const speed = player === view.catcher ? catcherSpeed : runnerSpeed;
      const pos = view.pos[player]!;
      pos.x = clamp(pos.x + step.x * speed, radius, fieldWidth - radius);
      pos.y = clamp(pos.y + step.y * speed, radius, fieldHeight - radius);
    }
    if (view.frozen > 0) {
      view.frozen -= 1;
    }
    if (view.tagBackLeft > 0) {
      view.tagBackLeft -= 1;
      if (view.tagBackLeft === 0) {
        view.tagBack = null;
      }
    }
    if (view.frozen > 0) {
      return;
    }
    const hunter = view.pos[view.catcher]!;
    const caught = players.find((player) => player !== view.catcher && player !== view.tagBack && touching(hunter, view.pos[player]!));
    if (caught !== undefined) {
      view.tagBack = view.catcher;
      view.tagBackLeft = tagBackTicks;
      view.catcher = caught;
      view.frozen = freezeTicks;
    }
  },

  bot(state, player, moves, { players }) {
    const view = state.public;
    const me = view.pos[player];
    if (me === undefined) {
      return undefined;
    }
    let wanted: Direction;
    if (player === view.catcher) {
      const others = players.filter((seat) => seat !== player);
      const prey = others.filter((seat) => seat !== view.tagBack);
      const nearest = (prey.length > 0 ? prey : others).reduce<PlayerId | undefined>(
        (best, seat) => (best === undefined || distanceSquared(me, view.pos[seat]!) < distanceSquared(me, view.pos[best]!) ? seat : best),
        undefined,
      );
      wanted = nearest === undefined ? "none" : towards(me, view.pos[nearest]!);
    } else {
      wanted = fleeFrom(me, view.pos[view.catcher]!, view.dir[player] ?? "none");
    }
    if (wanted === view.dir[player]) {
      return undefined;
    }
    return moves.find((move) => move.dir === wanted);
  },

  result(state) {
    if (state.public.ticksLeft > 0) {
      return undefined;
    }
    return { winners: shortestCatchers(state.public.caught) };
  },
});
