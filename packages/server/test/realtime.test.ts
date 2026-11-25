import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomError } from "../src/rooms";
import { createSetup, hostRoom, joinRoom, mauMauDir, tickfehler, wettlaufDir, type Seat, type Setup } from "./helpers";

let setup: Setup;
let now = 1_000_000;
const events: string[] = [];

beforeEach(async () => {
  now = 1_000_000;
  events.length = 0;
  setup = await createSetup(undefined, {}, { clock: () => now, realtime: { timers: false } });
  setup.rooms.on({
    frame: (code) => events.push(`frame:${code}`),
    changed: (code) => events.push(`changed:${code}`),
  });
  await setup.library.install(wettlaufDir);
  await setup.library.install(tickfehler);
  await setup.library.install(mauMauDir);
});

afterEach(async () => {
  await setup.cleanup();
});

async function expectRoomError(work: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    return;
  }
  throw new Error(`expected RoomError ${code}`);
}

async function ticks(count: number, stepMs = 50): Promise<void> {
  for (let i = 0; i < count; i++) {
    now += stepMs;
    await setup.rooms.realtime.tickAll();
  }
}

function present(code: string, seats: string[], screens = 1): void {
  setup.rooms.realtime.presence(code, { seats: new Set(seats), screens });
}

async function race(names = ["Anna", "Ben"]): Promise<Seat[]> {
  const host = hostRoom(setup, "wettlauf", names[0] as string);
  const others: Seat[] = [];
  for (const name of names.slice(1)) {
    others.push(await joinRoom(setup, host.code, name));
  }
  await setup.rooms.addScreen(host.code, host.user, "fernseher-1");
  return [host, ...others];
}

async function running(names = ["Anna", "Ben"]): Promise<Seat[]> {
  const seats = await race(names);
  const code = (seats[0] as Seat).code;
  present(code, seats.map((_, index) => `p${index + 1}`));
  await setup.rooms.start(code, (seats[0] as Seat).user);
  await ticks(60);
  expect(setup.rooms.realtime.view(code)?.state).toBe("running");
  return seats;
}

describe("Realtime rooms", () => {
  it("starts a game with a TV only when one is connected", async () => {
    const [anna] = await race();
    const code = anna!.code;
    expect((await setup.rooms.view(code, anna!.user)).canStart).toBe(false);
    await expectRoomError(setup.rooms.start(code, anna!.user), "screen-missing");
    present(code, []);
    expect((await setup.rooms.view(code, anna!.user)).canStart).toBe(true);
    await setup.rooms.start(code, anna!.user);
    const view = await setup.rooms.view(code, anna!.user);
    expect(view.live).toMatchObject({ state: "countdown", remainingMs: 3000 });
    expect(view.snapshot?.tick).toBe(0);
    expect(view.game).toMatchObject({ mode: "realtime", roles: ["screen", "controller"] });
  });

  it("counts down 3 seconds, then computes 20 ticks per second and sends snapshots", async () => {
    const [anna] = await race();
    const code = anna!.code;
    present(code, ["p1", "p2"]);
    await setup.rooms.start(code, anna!.user);
    await ticks(59);
    expect(setup.rooms.realtime.view(code)?.state).toBe("countdown");
    expect(setup.rooms.realtime.match(code)?.tick).toBe(0);
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
    expect(setup.rooms.realtime.match(code)?.tick).toBe(1);
    events.length = 0;
    await ticks(5);
    expect(setup.rooms.realtime.match(code)?.tick).toBe(6);
    expect(events.filter((event) => event === `frame:${code}`)).toHaveLength(5);
    expect((await setup.rooms.view(code, anna!.user)).snapshot?.tick).toBe(6);
  });

  it("catches up late ticks, but at most 200 ms of backlog", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const start = setup.rooms.realtime.match(code)?.tick ?? 0;
    now += 150;
    for (let i = 0; i < 5; i++) {
      await setup.rooms.realtime.tickAll();
    }
    expect(setup.rooms.realtime.match(code)?.tick).toBe(start + 3);
    now += 5000;
    for (let i = 0; i < 10; i++) {
      await setup.rooms.realtime.tickAll();
    }
    expect(setup.rooms.realtime.match(code)?.tick).toBe(start + 8);
  });

  it("collects inputs until the next tick and answers only afterwards", async () => {
    const [anna, ben] = await running();
    const code = anna!.code;
    let answered = false;
    const move = setup.rooms.move(code, anna!.user, { type: "run" }).then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    await ticks(1);
    await move;
    await ticks(9);
    const match = setup.rooms.realtime.match(code);
    expect(match?.state.public).toMatchObject({ pos: { p1: 10, p2: 0 }, running: { p1: true, p2: false } });
    const stop = setup.rooms.move(code, ben!.user, { type: "stop" });
    await ticks(1);
    await expectRoomError(stop, "illegal-move");
  });

  it("rejects illegal inputs without holding up the tick", async () => {
    const [anna, ben] = await running();
    const code = anna!.code;
    const bad = setup.rooms.move(code, ben!.user, { type: "stop" }).catch((error: unknown) => error);
    const good = setup.rooms.move(code, anna!.user, { type: "run" });
    await ticks(1);
    expect(((await bad) as RoomError).code).toBe("illegal-move");
    await good;
    expect((setup.rooms.realtime.match(code)?.state.public as { pos: unknown } | undefined)?.pos).toEqual({ p1: 1, p2: 0 });
  });

  it("Review 3: holds at most 4 inputs per seat until the tick and drops the oldest, not the newest", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const moves = [
      ...Array.from({ length: 4 }, () => setup.rooms.move(code, anna!.user, { type: "run" })),
      setup.rooms.move(code, anna!.user, { type: "stop" }),
    ].map((move) => move.then(() => "ok", (error: unknown) => (error as RoomError).code));
    await ticks(1);
    expect(await Promise.all(moves)).toEqual(["too-many-inputs", "ok", "illegal-move", "illegal-move", "ok"]);
    expect(setup.rooms.realtime.match(code)?.state.public).toMatchObject({ running: { p1: false } });
  });

  it("pauses after 2 seconds without a seat and continues after a countdown", async () => {
    const [anna, ben] = await running();
    const code = anna!.code;
    present(code, ["p1"]);
    await ticks(39);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
    await ticks(1);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: ["p2"], screenMissing: false });
    const frozen = setup.rooms.realtime.match(code)?.tick;
    await ticks(20);
    expect(setup.rooms.realtime.match(code)?.tick).toBe(frozen);
    const saved = JSON.parse((setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(code) as { match: string }).match) as { tick: number };
    expect(saved.tick).toBe(frozen);
    present(code, ["p1", "p2"]);
    await ticks(1);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "countdown", missingSeats: [] });
    await ticks(60);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
  });

  it("Review 3: remembers each seat's last input during a pause so a release is not lost", async () => {
    const [anna, ben] = await running();
    const code = anna!.code;
    const run = setup.rooms.move(code, ben!.user, { type: "run" });
    await ticks(1);
    await run;
    setup.rooms.pause(code, anna!.user, true);
    await setup.rooms.move(code, ben!.user, { type: "stop" });
    await setup.rooms.move(code, anna!.user, { type: "run" });
    await setup.rooms.move(code, anna!.user, { type: "stop" });
    await ticks(10);
    expect(setup.rooms.realtime.match(code)?.state.public).toMatchObject({ running: { p1: false, p2: true } });
    setup.rooms.pause(code, anna!.user, false);
    await ticks(61);
    const after = setup.rooms.realtime.match(code)?.state.public as { running: Record<string, boolean>; pos: Record<string, number> };
    expect(after.running).toEqual({ p1: false, p2: false });
    const pos = after.pos["p2"];
    await ticks(5);
    expect((setup.rooms.realtime.match(code)?.state.public as { pos: Record<string, number> }).pos["p2"]).toBe(pos);
  });

  it("Review 3: carries inputs that were still waiting for the tick when pausing over to after the pause", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const waiting = setup.rooms.move(code, anna!.user, { type: "run" });
    setup.rooms.pause(code, anna!.user, true);
    await expect(waiting).resolves.toBeUndefined();
    setup.rooms.pause(code, anna!.user, false);
    await ticks(62);
    expect(setup.rooms.realtime.match(code)?.state.public).toMatchObject({ running: { p1: true } });
  });

  it("Review 7: keeps no presence for rooms without connections and without a running match", async () => {
    const [anna] = await race();
    present(anna!.code, [], 1);
    expect(setup.rooms.realtime.presenceEntries).toBe(1);
    present(anna!.code, [], 0);
    expect(setup.rooms.realtime.presenceEntries).toBe(0);
  });

  it("pauses without a TV, but not because of a short dropout", async () => {
    const [anna] = await running();
    const code = anna!.code;
    present(code, ["p1", "p2"], 0);
    await ticks(20);
    present(code, ["p1", "p2"], 1);
    await ticks(40);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
    present(code, ["p1", "p2"], 0);
    await ticks(41);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: [], screenMissing: true });
  });

  it("lets only the host pause and resume", async () => {
    const [anna, ben] = await running();
    const code = anna!.code;
    await expectRoomError(() => setup.rooms.pause(code, ben!.user, true), "not-host");
    setup.rooms.pause(code, anna!.user, true);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", byHost: true });
    await ticks(10);
    expect(setup.rooms.realtime.view(code)?.state).toBe("paused");
    setup.rooms.pause(code, anna!.user, false);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "countdown", byHost: false });
  });

  it("saves every 10 seconds and continues paused after a restart", async () => {
    const [anna] = await running();
    const code = anna!.code;
    await ticks(201);
    const saved = JSON.parse((setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(code) as { match: string }).match) as { tick: number };
    expect(saved.tick).toBeGreaterThan(100);
    expect(saved.tick).toBeLessThan(setup.rooms.realtime.match(code)?.tick ?? 0);
    setup = await setup.reopen();
    await setup.library.restore();
    expect(await setup.rooms.restoreRealtime()).toEqual([code]);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: ["p1", "p2"], screenMissing: true });
    expect(setup.rooms.realtime.match(code)?.tick).toBe(saved.tick);
    present(code, ["p1", "p2"]);
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("countdown");
  });

  it("ends the match, records the round and stops ticking", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const move = setup.rooms.move(code, anna!.user, { type: "run" });
    await ticks(1);
    await move;
    await ticks(99);
    const view = await setup.rooms.view(code, anna!.user);
    expect(view.status).toBe("finished");
    expect(view.snapshot?.result).toEqual({ winners: ["p1"] });
    expect(view.live).toBeUndefined();
    expect(setup.rooms.realtime.has(code)).toBe(false);
    expect((setup.db.prepare("SELECT outcome FROM rounds WHERE room_code = ?").get(code) as { outcome: string }).outcome).toBe("finished");
    expect(setup.rooms.rooms(anna!.user)[0]).toMatchObject({ status: "finished", yourTurn: false, screen: true });
  });

  it("Acceptance run: repeats a tick after a single timeout instead of halting the match", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const original = setup.sandbox.run.bind(setup.sandbox);
    let failures = 1;
    const tolerated: unknown[] = [];
    setup.sandbox.run = async (...args: Parameters<typeof original>) => {
      if (args[2] === "stepMatch") {
        tolerated.push(args[5]?.tolerate);
      }
      if (args[2] === "stepMatch" && failures > 0) {
        failures -= 1;
        return { ok: false, failure: { kind: "timeout", message: "time limit of 100 ms exceeded" } };
      }
      return original(...args);
    };
    const before = setup.rooms.realtime.match(code)?.tick ?? 0;
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
    expect(setup.rooms.realtime.match(code)?.tick).toBe(before + 1);
    expect(tolerated).toEqual([["timeout", "memory"], undefined]);
    failures = 2;
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("halted");
  });

  it("Review 8b: does not recompute a tick whose worker was stopped at the hard limit", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const original = setup.sandbox.run.bind(setup.sandbox);
    let calls = 0;
    setup.sandbox.run = async (...args: Parameters<typeof original>) => {
      if (args[2] === "stepMatch") {
        calls += 1;
        return { ok: false, failure: { kind: "killed", message: "hard limit of 500 ms exceeded during a call" } };
      }
      return original(...args);
    };
    await ticks(1);
    expect(calls).toBe(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("halted");
  });

  it("halts on an error in tick, names the incident and allows abort or retry", async () => {
    const host = hostRoom(setup, "tickfehler", "Anna");
    const code = host.code;
    present(code, ["p1"], 0);
    await setup.rooms.start(code, host.user);
    await ticks(61);
    const boom = setup.rooms.move(code, host.user, { type: "boom" }).catch((error: unknown) => error);
    await ticks(1);
    expect(((await boom) as RoomError).code).toBe("game-error");
    const live = setup.rooms.realtime.view(code);
    expect(live).toMatchObject({ state: "halted", incident: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(setup.logs.join("\n")).toMatch(/Tick explodiert/);
    const halted = setup.rooms.realtime.match(code)?.tick;
    await ticks(10);
    expect(setup.rooms.realtime.match(code)?.tick).toBe(halted);
    setup.rooms.pause(code, host.user, false);
    expect(setup.rooms.realtime.view(code)?.state).toBe("countdown");
    setup.rooms.abort(code, host.user);
    expect(setup.rooms.realtime.has(code)).toBe(false);
    expect((await setup.rooms.view(code, host.user)).status).toBe("lobby");
  });

  it('shows turn-based rooms no realtime state and never sends realtime rooms "Your turn"', async () => {
    const host = hostRoom(setup, "tickfehler", "Anna");
    present(host.code, ["p1"], 0);
    await setup.rooms.start(host.code, host.user);
    expect(setup.rooms.rooms(host.user)[0]).toMatchObject({ status: "running", yourTurn: false, screen: false });
    const mau = hostRoom(setup, "mau-mau", "Cleo");
    await joinRoom(setup, mau.code, "Dan");
    await setup.rooms.start(mau.code, mau.user);
    expect((await setup.rooms.view(mau.code, mau.user)).live).toBeUndefined();
    expect(setup.rooms.isRealtime(mau.code)).toBe(false);
  });
});

describe("TVs in the room", () => {
  it("pairs only for games with a TV, only for members and at most 4", async () => {
    const [anna, ben] = await race();
    const code = anna!.code;
    const mau = hostRoom(setup, "mau-mau", "Cleo");
    await expectRoomError(setup.rooms.addScreen(mau.code, mau.user, "fernseher-x"), "no-screen-role");
    await expectRoomError(setup.rooms.addScreen(code, mau.user, "fernseher-x"), "not-member");
    for (const device of ["fernseher-2", "fernseher-3", "fernseher-4"]) {
      await setup.rooms.addScreen(code, ben!.user, device);
    }
    await expectRoomError(setup.rooms.addScreen(code, ben!.user, "fernseher-5"), "too-many-screens");
    await setup.rooms.addScreen(code, ben!.user, "fernseher-1");
    expect((await setup.rooms.view(code, anna!.user)).screens).toHaveLength(4);
  });

  it("moves a TV to the new room and tells the old one", async () => {
    const [anna] = await race();
    const other = hostRoom(setup, "wettlauf", "Cleo");
    const moves: string[] = [];
    setup.rooms.on({
      screenPaired: (device, code) => moves.push(`+${device}@${code}`),
      screenRemoved: (device, code) => moves.push(`-${device}@${code}`),
    });
    await setup.rooms.addScreen(other.code, other.user, "fernseher-1");
    expect(moves).toEqual([`-fernseher-1@${anna!.code}`, `+fernseher-1@${other.code}`]);
    expect(setup.rooms.screen("fernseher-1")?.code).toBe(other.code);
    expect((await setup.rooms.view(anna!.code, anna!.user)).screens).toEqual([]);
  });

  it("lets only the host remove a TV", async () => {
    const [anna, ben] = await race();
    const code = anna!.code;
    const id = setup.rooms.screen("fernseher-1")?.id as number;
    await expectRoomError(() => setup.rooms.removeScreen(code, ben!.user, id), "not-host");
    await expectRoomError(() => setup.rooms.removeScreen(code, anna!.user, id + 100), "unknown-screen");
    setup.rooms.removeScreen(code, anna!.user, id);
    expect(setup.rooms.screen("fernseher-1")).toBeUndefined();
  });

  it("forgets TVs after 24 hours without a connection, but not connected ones", async () => {
    const [anna] = await race();
    await setup.rooms.addScreen(anna!.code, anna!.user, "fernseher-2");
    const connected = setup.rooms.screen("fernseher-2")?.id as number;
    now += 25 * 60 * 60 * 1000;
    expect(setup.rooms.expireScreens(24 * 60 * 60 * 1000, new Set([connected]))).toBe(1);
    expect(setup.rooms.screen("fernseher-1")).toBeUndefined();
    expect(setup.rooms.screen("fernseher-2")).toBeDefined();
  });

  it("disappears with the room", async () => {
    const [anna] = await race();
    setup.rooms.close(anna!.code);
    expect(setup.rooms.screen("fernseher-1")).toBeUndefined();
  });

  it("shows the TV only public data", async () => {
    const [anna] = await running();
    const code = anna!.code;
    const view = await setup.rooms.screenView(code, 1, { members: new Set(), screens: new Set([1]) });
    expect(view.snapshot).toEqual({ players: ["p1", "p2"], public: expect.any(Object), version: expect.any(Number), tick: expect.any(Number) });
    expect(view).not.toHaveProperty("you");
    expect(view.live?.state).toBe("running");
    expect(view.members.map((member) => [member.name, member.you])).toEqual([
      ["Anna", false],
      ["Ben", false],
    ]);
  });
});
