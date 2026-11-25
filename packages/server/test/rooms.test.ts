import { SeededRandom, randomStateFromSeed } from "@gamehearth/sdk/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomError } from "../src/rooms";
import { account, createSetup, guest, hostRoom, joinRoom, mauMauDir, startfehler, zaehlenV1, zaehlenV2, type Seat, type Setup } from "./helpers";

let setup: Setup;

beforeEach(async () => {
  setup = await createSetup();
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

async function mauMauRoom(names: string[]): Promise<Seat[]> {
  const host = hostRoom(setup, "mau-mau", names[0] as string);
  const others = [];
  for (const name of names.slice(1)) {
    others.push(await joinRoom(setup, host.code, name));
  }
  return [host, ...others];
}

describe("Creating and joining rooms", () => {
  it("creates a room with a code and makes the creator the host", async () => {
    const [anna] = await mauMauRoom(["Anna"]);
    expect(anna?.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const view = await setup.rooms.view(anna!.code, anna!.user);
    expect(view).toMatchObject({
      status: "lobby",
      game: { id: "mau-mau", name: "Mau-Mau", version: "0.1.0" },
      members: [{ name: "Anna", host: true, you: true, seat: null, guest: false, deleted: false }],
      canStart: false,
      maxMembers: 6,
    });
  });

  it("allows joining by code, also in lowercase, and adds each user only once", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code.toLowerCase(), "  Ben  ");
    expect(ben.code).toBe(anna.code);
    const view = await setup.rooms.view(anna.code, ben.user);
    expect(view.members.map((member) => [member.name, member.host, member.you, member.guest])).toEqual([
      ["Anna", true, false, false],
      ["Ben", false, true, true],
    ]);
    expect((await setup.rooms.view(anna.code, anna.user)).canStart).toBe(true);
    expect(await setup.rooms.joinRoom(anna.code, ben.user)).toEqual({ code: anna.code, joined: false });
    expect(await setup.rooms.joinRoom(anna.code, anna.user)).toEqual({ code: anna.code, joined: false });
    expect((await setup.rooms.view(anna.code, anna.user)).members).toHaveLength(2);
  });

  it("rejects unknown games, rooms, users and non-members and lets only accounts create rooms", async () => {
    const anna = account(setup, "Anna");
    const ben = guest(setup, "Ben");
    await expectRoomError(() => setup.rooms.createRoom("schach", anna.user), "unknown-game");
    await expectRoomError(() => setup.rooms.createRoom("mau-mau", ben.user), "account-required");
    await expectRoomError(() => setup.rooms.createRoom("mau-mau", 999_999), "account-required");
    await expectRoomError(setup.rooms.joinRoom("ZZZZZZ", ben.user), "unknown-room");
    const room = setup.rooms.createRoom("mau-mau", anna.user);
    await expectRoomError(() => setup.rooms.member(room.code, ben.user), "not-member");
    await expectRoomError(() => setup.rooms.member("ZZZZZZ", anna.user), "unknown-room");
    await expectRoomError(setup.rooms.joinRoom(room.code, 999_999), "unknown-user");
    expect(setup.rooms.member(room.code.toLowerCase(), anna.user)).toMatchObject({ name: "Anna", host: true, guest: false, deleted: false });
  });

  it("admits no more members than the game has players", async () => {
    const members = await mauMauRoom(["A", "B", "C", "D", "E", "F"]);
    await expectRoomError(joinRoom(setup, members[0]!.code, "G"), "room-full");
  });
});

describe("Starting a match", () => {
  it("only the host starts, and only with an allowed player count", async () => {
    const [anna] = await mauMauRoom(["Anna"]);
    await expectRoomError(setup.rooms.start(anna!.code, anna!.user), "wrong-player-count");
    const ben = await joinRoom(setup, anna!.code, "Ben");
    await expectRoomError(setup.rooms.start(anna!.code, ben.user), "not-host");
    await setup.rooms.start(anna!.code, anna!.user);
    await expectRoomError(setup.rooms.start(anna!.code, anna!.user), "already-started");
    await expectRoomError(joinRoom(setup, anna!.code, "Cem"), "already-started");
  });

  it("assigns seats in join order and shows everyone only their own hand", async () => {
    const [anna, ben] = await mauMauRoom(["Anna", "Ben"]);
    await setup.rooms.start(anna!.code, anna!.user);
    const annaView = await setup.rooms.view(anna!.code, anna!.user);
    const benView = await setup.rooms.view(anna!.code, ben!.user);
    expect(annaView.status).toBe("running");
    expect(annaView.members.map((member) => member.seat)).toEqual(["p1", "p2"]);
    expect(annaView.snapshot?.player).toBe("p1");
    expect(benView.snapshot?.player).toBe("p2");
    const annaHand = (annaView.snapshot?.me as { hand: string[] }).hand;
    const benHand = (benView.snapshot?.me as { hand: string[] }).hand;
    expect(annaHand).toHaveLength(5);
    for (const card of benHand) {
      expect(JSON.stringify(annaView)).not.toContain(`"${card}"`);
    }
    expect(JSON.stringify(annaView)).not.toContain('"deck":');
    expect(JSON.stringify(annaView)).not.toContain("seed");
    expect(JSON.stringify(annaView)).not.toContain("token");
    expect(JSON.stringify(annaView)).not.toContain(anna!.token);
    expect(JSON.stringify(annaView)).not.toContain(ben!.token);
  });

  it("reports an error in the game at the start and leaves the room in the lobby", async () => {
    await setup.library.install(startfehler);
    const host = hostRoom(setup, "startfehler", "Anna");
    await joinRoom(setup, host.code, "Ben");
    await expectRoomError(setup.rooms.start(host.code, host.user), "game-error");
    expect((await setup.rooms.view(host.code, host.user)).status).toBe("lobby");
    expect(setup.logs.join(" ")).toContain("Startfehler");
  });
});

describe("Moves", () => {
  it("applies moves, checks order, validity and version, and stores the history", async () => {
    const [anna, ben] = await mauMauRoom(["Anna", "Ben"]);
    await setup.rooms.start(anna!.code, anna!.user);
    const view = await setup.rooms.view(anna!.code, anna!.user);
    const move = view.snapshot?.moves[0];
    await expectRoomError(setup.rooms.move(anna!.code, ben!.user, move), "not-your-turn");
    await expectRoomError(setup.rooms.move(anna!.code, anna!.user, { type: "play", card: "herz-99" }), "illegal-move");
    await expectRoomError(setup.rooms.move(anna!.code, anna!.user, move, 5), "stale");
    await setup.rooms.move(anna!.code, anna!.user, move, 0);
    const after = await setup.rooms.view(anna!.code, anna!.user);
    expect(after.snapshot?.version).toBe(1);
    const logged = setup.db.prepare("SELECT version, kind, seat, action, now, profiles FROM history WHERE room_code = ?").all(anna!.code);
    expect(logged).toEqual([{ version: 1, kind: "move", seat: "p1", action: JSON.stringify(move), now: expect.any(Number), profiles: null }]);
  });

  it("logs errors in the game code and leaves the match unchanged", async () => {
    await setup.library.install(zaehlenV1);
    const host = hostRoom(setup, "zaehlen", "Anna");
    await joinRoom(setup, host.code, "Ben");
    await setup.rooms.start(host.code, host.user);
    await expectRoomError(setup.rooms.move(host.code, host.user, { type: "kaputt" }), "game-error");
    expect(setup.logs.join("\n")).toContain("absichtlich kaputt");
    expect((await setup.rooms.view(host.code, host.user)).snapshot?.version).toBe(0);
  });

  it("plays a whole three-player match of Mau-Mau to the end", async () => {
    const players = await mauMauRoom(["Anna", "Ben", "Cem"]);
    const code = players[0]!.code;
    await setup.rooms.start(code, players[0]!.user);
    const bot = new SeededRandom(randomStateFromSeed("server-partie"));
    for (let step = 0; step < 2000; step++) {
      const views = await Promise.all(players.map((player) => setup.rooms.view(code, player.user)));
      if (views[0]?.status === "finished") {
        break;
      }
      const index = views.findIndex((view) => (view.snapshot?.moves.length ?? 0) > 0);
      expect(index).toBeGreaterThanOrEqual(0);
      const view = views[index]!;
      await setup.rooms.move(code, players[index]!.user, bot.pick(view.snapshot?.moves ?? []), view.snapshot?.version);
    }
    const final = await setup.rooms.view(code, players[0]!.user);
    expect(final.status).toBe("finished");
    expect(final.snapshot?.result?.winners.length).toBeGreaterThan(0);
    await expectRoomError(setup.rooms.move(code, players[0]!.user, { type: "draw" }), "game-over");
  });
});

describe("Persistence and game versions", () => {
  it("continues a match after a restart without reinstalling the game", async () => {
    const [anna, ben] = await mauMauRoom(["Anna", "Ben"]);
    await setup.rooms.start(anna!.code, anna!.user);
    const before = await setup.rooms.view(anna!.code, anna!.user);
    await setup.rooms.move(anna!.code, anna!.user, before.snapshot?.moves[0]);
    setup = await setup.reopen();
    const after = await setup.rooms.view(anna!.code, anna!.user);
    expect(after.snapshot?.version).toBe(1);
    expect(after.snapshot?.me).toBeDefined();
    const benView = await setup.rooms.view(anna!.code, ben!.user);
    expect(benView.snapshot?.player).toBe("p2");
    expect(setup.accounts.session(ben!.token)?.user.id).toBe(ben!.user);
  });

  it("keeps a room on its build while new rooms get the new one", async () => {
    await setup.library.install(zaehlenV1);
    const old = hostRoom(setup, "zaehlen", "Anna");
    const oldBen = await joinRoom(setup, old.code, "Ben");
    await setup.rooms.start(old.code, old.user);
    await setup.library.install(zaehlenV2);
    const fresh = hostRoom(setup, "zaehlen", "Cem");
    await joinRoom(setup, fresh.code, "Dora");
    await setup.rooms.start(fresh.code, fresh.user);

    await setup.rooms.move(old.code, old.user, { type: "add" });
    await setup.rooms.move(fresh.code, fresh.user, { type: "add" });
    const count = async (code: string, user: number) => ((await setup.rooms.view(code, user)).snapshot?.public as { count: number }).count;
    expect(await count(old.code, old.user)).toBe(1);
    expect(await count(fresh.code, fresh.user)).toBe(2);
    expect((await setup.rooms.view(old.code, old.user)).game.version).toBe("1.0.0");
    expect((await setup.rooms.view(fresh.code, fresh.user)).game.version).toBe("1.1.0");

    setup = await setup.reopen();
    await setup.rooms.move(old.code, oldBen.user, { type: "add" });
    expect(await count(old.code, old.user)).toBe(2);
    expect((await setup.rooms.view(old.code, old.user)).game.version).toBe("1.0.0");
  });

  it("does not build the same build twice", async () => {
    const first = await setup.library.install(zaehlenV1);
    const second = await setup.library.install(zaehlenV1);
    expect(second.build).toBe(first.build);
    expect(first.build).toMatch(/^zaehlen@1\.0\.0\+[0-9a-f]{12}$/);
  });
});
