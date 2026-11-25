import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, userVersion } from "../src/db";
import { RoomError } from "../src/rooms";
import { createSetup, hostRoom, joinRoom, mauMauDir, takt, type Seat, type Setup } from "./helpers";

const zugbot = fileURLToPath(new URL("./fixtures/zugbot", import.meta.url));
const reihum = fileURLToPath(new URL("./fixtures/reihum", import.meta.url));

let setup: Setup;
let now = 1_000_000;

function expectRoomError(work: () => unknown, code: string): void {
  let error: unknown;
  try {
    work();
  } catch (failure) {
    error = failure;
  }
  expect(error).toBeInstanceOf(RoomError);
  expect((error as RoomError).code).toBe(code);
}

async function expectRejected(work: Promise<unknown>, code: string): Promise<void> {
  const error = await work.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(RoomError);
  expect((error as RoomError).code).toBe(code);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function state(code: string): { public: Record<string, unknown> } {
  const row = setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(code) as { match: string };
  return (JSON.parse(row.match) as { state: { public: Record<string, unknown> } }).state;
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    now += 50;
    await setup.rooms.realtime.tickAll();
  }
}

function present(code: string, seats: string[]): void {
  setup.rooms.realtime.presence(code, { seats: new Set(seats), screens: 0 });
}

describe("Migration to schema 13", () => {
  it("backs up, then gives members a bot number and an autopilot flag, empty for existing people", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-migration13-"));
    try {
      const raw = new DatabaseSync(join(dir, "v12.sqlite"));
      migrate(raw, 12);
      raw.prepare("INSERT INTO users (kind, display_name, created_at, active_at) VALUES ('guest', 'Anna', 1, 1)").run();
      raw.prepare("INSERT INTO rooms (code, game_id, build, status, version, created_at, updated_at) VALUES ('ABCDEF', 'zugbot', 'zugbot@1.0.0+000000000000', 'lobby', 0, 1, 1)").run();
      raw.prepare("INSERT INTO members (room_code, user_id, host, seat, joined_at) VALUES ('ABCDEF', 1, 1, NULL, 1)").run();
      raw.close();
      const db = openDatabase(join(dir, "v12.sqlite"), { backupDir: join(dir, "backups") });
      expect(userVersion(db)).toBe(13);
      expect(readdirSync(join(dir, "backups"))).toEqual([expect.stringMatching(/-migration-v12\.sqlite$/)]);
      expect(db.prepare("SELECT user_id, bot, autopilot FROM members").all()).toEqual([{ user_id: 1, bot: null, autopilot: 0 }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Bots in the lobby", () => {
  beforeEach(async () => {
    setup = await createSetup(undefined, {}, { botDelayMs: 0 });
    await setup.library.install(zugbot);
    await setup.library.install(mauMauDir);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it("lets the host add bots with their own numbers, which count toward the player count", async () => {
    const host = hostRoom(setup, "zugbot", "Anna");
    expect(await setup.rooms.hasBots("zugbot")).toBe(true);
    await setup.rooms.addBot(host.code, host.user);
    await setup.rooms.addBot(host.code, host.user);
    const view = await setup.rooms.view(host.code, host.user);
    expect(view.game.bots).toBe(true);
    expect(view.members.map((member) => ({ name: member.name, bot: member.bot, deleted: member.deleted, guest: member.guest }))).toEqual([
      { name: "Anna", bot: undefined, deleted: false, guest: false },
      { name: "", bot: 1, deleted: false, guest: false },
      { name: "", bot: 2, deleted: false, guest: false },
    ]);
    expect(view.canStart).toBe(true);
    const bot = view.members[1]?.id as number;
    setup.rooms.kick(host.code, host.user, bot);
    await setup.rooms.addBot(host.code, host.user);
    const again = await setup.rooms.view(host.code, host.user);
    expect(again.members.map((member) => member.bot)).toEqual([undefined, 2, 1]);
  });

  it("refuses bots for others than the host, outside the lobby, in a full room and for games without bot", async () => {
    const host = hostRoom(setup, "zugbot", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    await expectRejected(setup.rooms.addBot(host.code, ben.user), "not-host");
    await setup.rooms.addBot(host.code, host.user);
    await setup.rooms.addBot(host.code, host.user);
    await expectRejected(setup.rooms.addBot(host.code, host.user), "room-full");
    await setup.rooms.start(host.code, host.user);
    await expectRejected(setup.rooms.addBot(host.code, host.user), "not-in-lobby");
    const mau = hostRoom(setup, "mau-mau", "Clara");
    expect(await setup.rooms.hasBots("mau-mau")).toBe(false);
    expect((await setup.rooms.view(mau.code, mau.user)).game.bots).toBeUndefined();
    await expectRejected(setup.rooms.addBot(mau.code, mau.user), "no-bots");
  });

  it("keeps bots across a new round and closes the room when the last person leaves", async () => {
    const host = hostRoom(setup, "zugbot", "Anna");
    await setup.rooms.addBot(host.code, host.user);
    await setup.rooms.start(host.code, host.user);
    setup.rooms.abort(host.code, host.user);
    const lobby = await setup.rooms.view(host.code, host.user);
    expect(lobby.members.map((member) => member.bot)).toEqual([undefined, 1]);
    setup.rooms.leave(host.code, host.user);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM rooms WHERE code = ?").get(host.code)).toEqual({ count: 0 });
  });
});

describe("Bots in turn-based matches", () => {
  beforeEach(async () => {
    setup = await createSetup(undefined, {}, { botDelayMs: 0 });
    await setup.library.install(zugbot);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  async function started(option?: "kaputt" | "falsch" | "absturz"): Promise<{ host: Seat; ben: Seat }> {
    const host = hostRoom(setup, "zugbot", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    if (option !== undefined) {
      await setup.rooms.setOption(host.code, host.user, "bot", option);
    }
    await setup.rooms.addBot(host.code, host.user);
    await setup.rooms.start(host.code, host.user);
    return { host, ben };
  }

  it("lets a lobby bot move on its turn with the game's choice and leaves the people's turns alone", async () => {
    const { host, ben } = await started();
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
    await setup.rooms.move(host.code, ben.user, { type: "pick", n: 2 });
    await until(() => (state(host.code).public["log"] as string[]).length === 3, "the bot's move");
    expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:2", "p3:3"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state(host.code).public["log"]).toHaveLength(3);
    const history = setup.db.prepare("SELECT seat, action FROM history WHERE room_code = ? AND kind = 'move' ORDER BY version").all(host.code);
    expect(history.at(-1)).toEqual({ seat: "p3", action: JSON.stringify({ type: "pick", n: 3 }) });
  });

  it("takes a random legal move when the bot throws or picks an illegal move, and logs the reason once", async () => {
    for (const option of ["kaputt", "falsch"] as const) {
      const { host, ben } = await started(option);
      await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
      await setup.rooms.move(host.code, ben.user, { type: "pick", n: 1 });
      await until(() => (state(host.code).public["log"] as string[]).length === 3, "the bot's move");
      expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:1", expect.stringMatching(/^p3:[123]$/)]);
      expect(setup.logs.filter((line) => line.includes(`Room ${host.code}`) && line.includes("[Bots]"))).toEqual([
        expect.stringMatching(option === "kaputt" ? /seat p3: bot for p3 failed: .*bot kaputt/ : /seat p3: bot for p3 chose a move that is not legal/),
      ]);
    }
  });

  it("plays a random legal move when the bot's move fails in the game, instead of stopping", async () => {
    const { host, ben } = await started("absturz");
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
    await setup.rooms.move(host.code, ben.user, { type: "pick", n: 1 });
    await until(() => (state(host.code).public["log"] as string[]).length === 3, "a fallback move of the bot");
    expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:1", expect.stringMatching(/^p3:[12]$/)]);
    expect(setup.logs.filter((line) => line.includes(`Room ${host.code}, zugbot`) && line.includes("[Bots]"))).toEqual([
      expect.stringMatching(/seat p3: the move \{"n":3,"type":"pick"\} failed: An error occurred in the game, the move was not made \(incident/),
    ]);
  });

  it("drops a bot move that was still in the sandbox when the person took the seat back", async () => {
    const { host, ben } = await started();
    const benId = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.name === "Ben")?.id as number;
    const sandbox = setup.sandbox as unknown as { run: (...args: unknown[]) => Promise<unknown> };
    const original = sandbox.run.bind(setup.sandbox);
    let tookBack = false;
    sandbox.run = async (...args: unknown[]) => {
      if (args[2] === "applyMove" && !tookBack && String(args[3]).includes('"player":"p2"')) {
        tookBack = true;
        setup.rooms.takeBack(host.code, ben.user);
      }
      return original(...args);
    };
    await setup.rooms.handOver(host.code, ben.user, benId, new Set([benId]));
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
    await until(() => tookBack, "the take-back during the bot's move");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state(host.code).public["log"]).toEqual(["p1:1"]);
    await setup.rooms.move(host.code, ben.user, { type: "pick", n: 2 });
    expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:2"]);
  });

  it("lets everyone hand over their own seat and the host the seats of people without a device", async () => {
    const { host, ben } = await started();
    const view = await setup.rooms.view(host.code, host.user);
    const benId = view.members.find((member) => member.name === "Ben")?.id as number;
    const annaId = view.members.find((member) => member.name === "Anna")?.id as number;
    await expectRejected(setup.rooms.handOver(host.code, ben.user, annaId, new Set()), "not-host");
    await expectRejected(setup.rooms.handOver(host.code, host.user, benId, new Set([benId])), "member-connected");
    await expectRejected(setup.rooms.handOver(host.code, host.user, view.members[2]?.id as number, new Set()), "unknown-member");
    await setup.rooms.handOver(host.code, ben.user, benId, new Set([benId]));
    await expectRejected(setup.rooms.handOver(host.code, host.user, benId, new Set()), "already-bot");
    expect((await setup.rooms.view(host.code, ben.user)).you.autopilot).toBe(true);
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
    await until(() => (state(host.code).public["log"] as string[]).length === 3, "both bots' moves");
    expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:3", "p3:3"]);
  });

  it("refuses moves of a person on autopilot until they take the seat back, and sends them no turn alert", async () => {
    const { host, ben } = await started();
    const benId = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.name === "Ben")?.id as number;
    await setup.rooms.handOver(host.code, host.user, benId, new Set());
    expect(setup.rooms.alertDue(host.code, ben.user, "turn", 1)).toBe(false);
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 1 });
    await until(() => (state(host.code).public["log"] as string[]).length === 3, "bot moves for Ben and the lobby bot");
    expect(state(host.code).public["log"]).toEqual(["p1:1", "p2:3", "p3:3"]);
    await expectRejected(setup.rooms.move(host.code, ben.user, { type: "pick", n: 1 }), "bot-playing");
    expectRoomError(() => setup.rooms.takeBack(host.code, host.user), "not-handed-over");
    setup.rooms.takeBack(host.code, ben.user);
    expect((await setup.rooms.view(host.code, ben.user)).you.autopilot).toBeUndefined();
    const rooms = setup.rooms.rooms(ben.user);
    expect(rooms[0]?.yourTurn).toBe(false);
  });

  it("lets the host hand the seat of a deleted user to a bot", async () => {
    const { host, ben } = await started();
    setup.rooms.removeUser(ben.user);
    const deleted = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.deleted);
    expect(deleted?.seat).toBe("p2");
    await setup.rooms.handOver(host.code, host.user, deleted?.id as number, new Set());
    await setup.rooms.move(host.code, host.user, { type: "pick", n: 2 });
    await until(() => (state(host.code).public["log"] as string[]).length === 3, "bot moves for the deleted seat and the lobby bot");
    expect(state(host.code).public["log"]).toEqual(["p1:2", "p2:3", "p3:3"]);
  });

  it("ends autopilot with a new round", async () => {
    const { host, ben } = await started();
    const benId = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.name === "Ben")?.id as number;
    await setup.rooms.handOver(host.code, ben.user, benId, new Set([benId]));
    setup.rooms.abort(host.code, host.user);
    expect((await setup.rooms.view(host.code, ben.user)).you.autopilot).toBeUndefined();
  });

  it("refuses handing over in games without bots and outside a match", async () => {
    await setup.library.install(mauMauDir);
    const host = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    const benId = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.name === "Ben")?.id as number;
    await expectRejected(setup.rooms.handOver(host.code, ben.user, benId, new Set()), "not-running");
    await setup.rooms.start(host.code, host.user);
    await expectRejected(setup.rooms.handOver(host.code, ben.user, benId, new Set()), "no-bots");
  });
});

describe("Bots and away seats in realtime", () => {
  beforeEach(async () => {
    now = 1_000_000;
    setup = await createSetup(undefined, {}, { clock: () => now, realtime: { timers: false } });
    await setup.library.install(reihum);
    await setup.library.install(takt);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  async function running(game: string, bots = 0): Promise<{ host: Seat; ben: Seat }> {
    const host = hostRoom(setup, game, "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    for (let i = 0; i < bots; i++) {
      await setup.rooms.addBot(host.code, host.user);
    }
    await setup.rooms.start(host.code, host.user);
    present(host.code, ["p1", "p2"]);
    await ticks(70);
    return { host, ben };
  }

  function live(code: string) {
    return setup.rooms.realtime.view(code);
  }

  function publicState(code: string): { presses: Record<string, number>; skipped: string[]; turn: number } {
    return setup.rooms.realtime.match(code)?.state.public as { presses: Record<string, number>; skipped: string[]; turn: number };
  }

  it("lets a bot seat press on its turn inside the tick", async () => {
    const { host, ben } = await running("reihum", 1);
    expect(live(host.code)?.state).toBe("running");
    await Promise.all([setup.rooms.move(host.code, host.user, { type: "press" }), ticks(1)]);
    await Promise.all([setup.rooms.move(host.code, ben.user, { type: "press" }), ticks(1)]);
    await ticks(1);
    expect(publicState(host.code).presses).toEqual({ p1: 1, p2: 1, p3: 1 });
  });

  it("plays on without a seat that is away, tells the game, and pauses only when every person is away", async () => {
    const { host } = await running("reihum");
    present(host.code, ["p1"]);
    await ticks(10);
    expect(live(host.code)?.state).toBe("running");
    expect(live(host.code)?.awaySeats).toBeUndefined();
    await ticks(40);
    expect(live(host.code)).toMatchObject({ state: "running", awaySeats: ["p2"], missingSeats: [] });
    await Promise.all([setup.rooms.move(host.code, host.user, { type: "press" }), ticks(1)]);
    await ticks(2);
    expect(publicState(host.code).skipped).toContain("p2");
    present(host.code, []);
    await ticks(50);
    expect(live(host.code)).toMatchObject({ state: "paused", missingSeats: ["p1", "p2"] });
    present(host.code, ["p1", "p2"]);
    await ticks(1);
    expect(live(host.code)?.state).toBe("countdown");
    expect(live(host.code)?.awaySeats).toBeUndefined();
  });

  it("still pauses games that do not play on, and not for seats handed to a bot", async () => {
    const { host, ben } = await running("takt");
    expect(await setup.rooms.hasBots("takt")).toBe(false);
    present(host.code, ["p1"]);
    await ticks(50);
    expect(live(host.code)).toMatchObject({ state: "paused", missingSeats: ["p2"] });
    await expectRejected(setup.rooms.handOver(host.code, ben.user, 2, new Set()), "no-bots");
  });

  it("does not pause for a seat handed to a bot and moves it in the tick", async () => {
    const { host, ben } = await running("reihum");
    const benId = (await setup.rooms.view(host.code, host.user)).members.find((member) => member.name === "Ben")?.id as number;
    await setup.rooms.handOver(host.code, ben.user, benId, new Set([benId]));
    present(host.code, ["p1"]);
    await ticks(50);
    expect(live(host.code)).toMatchObject({ state: "running", missingSeats: [] });
    expect(live(host.code)?.awaySeats).toBeUndefined();
    await Promise.all([setup.rooms.move(host.code, host.user, { type: "press" }), ticks(1)]);
    await ticks(1);
    expect(publicState(host.code).presses).toMatchObject({ p1: 1, p2: 1 });
    await expectRejected(setup.rooms.move(host.code, ben.user, { type: "press" }), "bot-playing");
  });
});
