import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest";

const valid = {
  id: "mau-mau",
  name: "Mau-Mau",
  version: "0.1.0",
  sdk: "^0.1.0",
  license: { code: "MIT", assets: "CC0-1.0" },
  mode: "turn-based",
  players: { min: 2, max: 6 },
  server: true,
  client: "dist/client",
  roles: { player: { inputs: ["touch", "mouse"], screen: "small" } },
};

function problemsOf(changes: Record<string, unknown>): string[] {
  const checked = validateManifest({ ...valid, ...changes });
  return checked.ok ? [] : checked.problems;
}

describe("validateManifest", () => {
  it("accepts a complete manifest", () => {
    expect(validateManifest(valid)).toEqual({ ok: true, manifest: valid });
  });

  it("accepts the manifest of Mau-Mau", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../fixtures/mau-mau/manifest.json", import.meta.url), "utf8")) as unknown;
    expect(validateManifest(raw).ok).toBe(true);
  });

  it("accepts a party game with a screen without input", () => {
    expect(
      problemsOf({
        mode: "realtime",
        sdk: "^0.1.1",
        roles: { screen: { inputs: [], screen: "large" }, controller: { inputs: ["touch"], screen: "small" } },
      }),
    ).toEqual([]);
  });

  it("requires an SDK with tick for realtime", () => {
    expect(problemsOf({ mode: "realtime", sdk: "^0.1.0" })).toEqual(['with mode "realtime", sdk must be at least "^0.1.1"; older servers do not know tick']);
    expect(problemsOf({ mode: "realtime", sdk: "^0.1.1" })).toEqual([]);
  });

  describe("optional TV", () => {
    const player = { inputs: ["touch"], screen: "small" };
    const tv = { inputs: [], screen: "large", optional: true };
    const party = { mode: "realtime", sdk: "^0.1.7", roles: { player, screen: tv } };

    function problemsWith(changes: Record<string, unknown>): string[] {
      const checked = validateManifest({ ...valid, ...party, ...changes }, "0.1.7");
      return checked.ok ? [] : checked.problems;
    }

    it("accepts an optional TV next to the role player with sdk ^0.1.7", () => {
      expect(problemsWith({})).toEqual([]);
      expect(problemsWith({ roles: { player, screen: { ...tv, optional: false } } })).toEqual([]);
      expect(problemsWith({ mode: "turn-based" })).toEqual([]);
    });

    it("requires sdk ^0.1.7 as soon as optional is given, also as false", () => {
      const message = 'with roles.screen.optional, sdk must be at least "^0.1.7"; older servers do not know an optional TV';
      expect(problemsWith({ sdk: "^0.1.6" })).toEqual([message]);
      expect(problemsWith({ sdk: "^0.1.6", roles: { player, screen: { ...tv, optional: false } } })).toEqual([message]);
      expect(problemsWith({ sdk: "^0.1.6", roles: { player, screen: { inputs: [], screen: "large" } } })).toEqual([]);
    });

    it("allows optional only on the TV", () => {
      expect(problemsWith({ roles: { player: { ...player, optional: true }, screen: tv } })).toEqual([
        "roles.player.optional is not allowed; only the TV (roles.screen) can be optional",
      ]);
      expect(problemsWith({ roles: { player, controller: { ...player, optional: false } } })).toEqual([
        "roles.controller.optional is not allowed; only the TV (roles.screen) can be optional",
      ]);
    });

    it("requires optional to be true or false", () => {
      expect(problemsWith({ roles: { player, screen: { ...tv, optional: "yes" } } })).toEqual(["roles.screen.optional must be true or false"]);
      expect(problemsWith({ roles: { player, screen: { ...tv, optional: 1 } } })).toEqual(["roles.screen.optional must be true or false"]);
    });

    it("requires the role player next to an optional TV, because controllers alone show no game", () => {
      const controller = { inputs: ["touch"], screen: "small" };
      expect(problemsWith({ roles: { controller, screen: tv } })).toEqual([
        "roles.screen.optional needs the role player; with controllers only, nobody would see the game without a TV",
      ]);
      expect(problemsWith({ roles: { controller, screen: { ...tv, optional: false } } })).toEqual([]);
      expect(problemsWith({ roles: { player, controller, screen: tv } })).toEqual([]);
    });

    it("names optional among the allowed fields of the TV only", () => {
      expect(problemsWith({ roles: { player, screen: { ...tv, size: 1 } } })).toEqual(["roles.screen.size is unknown, allowed are inputs, screen and optional"]);
      expect(problemsWith({ roles: { player: { ...player, size: 1 }, screen: tv } })).toEqual(["roles.player.size is unknown, allowed are inputs and screen"]);
    });
  });

  describe("options", () => {
    const options = {
      stapeln: { label: "Stack 7s", type: "boolean", default: true },
      duration: { label: "Duration", type: "choice", default: 90, choices: [{ value: 60, label: "1 minute" }, { value: 90, label: "1.5 minutes" }] },
    };

    it("accepts choice and yes/no in games with a reducer and SDK 0.1.3 or newer", () => {
      expect(problemsOf({ sdk: "^0.1.3", options })).toEqual([]);
      expect(problemsOf({ sdk: "^0.1.3", mode: "realtime", options })).toEqual([]);
    });

    it("requires an SDK that knows options", () => {
      expect(problemsOf({ sdk: "^0.1.2", options })).toEqual(['with options, sdk must be at least "^0.1.3"; older servers do not know options']);
    });

    it("rejects options in single-player games without a reducer", () => {
      expect(
        problemsOf({ sdk: "^0.1.3", mode: "single", server: false, players: { min: 1, max: 1 }, roles: { player: { inputs: ["touch"], screen: "small" } }, options }),
      ).toEqual(["options only exist for games with a reducer (server true); single-player games without a reducer build their own menu"]);
    });

    it("reports errors in the options with the path", () => {
      expect(problemsOf({ sdk: "^0.1.3", options: { stapeln: { label: "7er", type: "boolean", default: "ja" } } })).toEqual([
        'options.stapeln.default must be true or false for type "boolean"',
      ]);
    });
  });

  describe("single-player games without a reducer", () => {
    const solo = {
      mode: "single",
      server: false,
      sdk: "^0.1.2",
      players: { min: 1, max: 1 },
      roles: { player: { inputs: ["touch", "keyboard"], screen: "small" } },
      stats: {
        punkte: { label: "Punkte", better: "higher" },
        bestzeit: { label: "Bestzeit", better: "lower", format: "time" },
      },
    };

    it("accepts best scores with direction and format", () => {
      expect(problemsOf(solo)).toEqual([]);
      expect(problemsOf({ ...solo, stats: undefined })).toEqual([]);
    });

    it("requires an SDK with connectSolo", () => {
      expect(problemsOf({ ...solo, sdk: "^0.1.1" })).toEqual(['with mode "single" without a reducer, sdk must be at least "^0.1.2"; older servers do not know connectSolo']);
    });

    it("knows only the role player", () => {
      expect(problemsOf({ ...solo, roles: { player: { inputs: ["touch"], screen: "small" }, screen: { inputs: [], screen: "large" } } })).toEqual([
        'with mode "single" without a reducer there is only the role player, no TV and no controllers',
      ]);
    });

    it("rejects items and flags; inventory belongs in the save", () => {
      expect(problemsOf({ ...solo, items: { trank: { label: "Trank" } }, flags: { held: { label: "Held" } } })).toEqual([
        'items and flags only exist for games with a reducer; single-player games without a reducer (mode "single", server false) keep inventory and unlocks in their save and have only best scores under stats',
      ]);
    });

    it.each([
      ["no object", { stats: [] }, "stats must be an object"],
      ["capital letters in the name", { stats: { Punkte: { label: "P", better: "higher" } } }, "stats.Punkte: names consist"],
      ["names like constructor with an underscore", { stats: { __proto__x: { label: "P", better: "higher" } } }, "names consist"],
      ["a missing direction", { stats: { punkte: { label: "Punkte" } } }, "stats.punkte.better is missing"],
      ["a wrong direction", { stats: { punkte: { label: "Punkte", better: "mehr" } } }, 'stats.punkte.better must be "higher"'],
      ["an empty label", { stats: { punkte: { label: " ", better: "higher" } } }, "stats.punkte.label must"],
      ["an unknown format", { stats: { punkte: { label: "P", better: "higher", format: "prozent" } } }, "stats.punkte.format must"],
      ["an unknown field", { stats: { punkte: { label: "P", better: "higher", rang: true } } }, "stats.punkte.rang is unknown"],
      ["a name taken in JavaScript", { stats: { constructor: { label: "K", better: "higher" } } }, "stats.constructor: this name is already taken in JavaScript"],
      ["too many best scores", { stats: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`wert-${i}`, { label: "W", better: "higher" }])) }, "at most 10"],
    ])("reports %s", (_name, changes, expected) => {
      expect(problemsOf({ ...solo, ...changes })).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
    });
  });

  describe("catalog of the profiles in games with a reducer", () => {
    const catalog = {
      sdk: "^0.1.4",
      items: { "koeder-wurm": { label: "Wurm" }, "rute-alt": { label: "Alte Rute", deprecated: true } },
      stats: { siege: { label: "Siege", better: "higher" }, fische: { label: "Gefangene Fische" } },
      flags: { "buch-hecht": { label: "Hecht im Sammelbuch" } },
    };

    it("takes items, stats with and without better, and flags", () => {
      expect(problemsOf(catalog)).toEqual([]);
    });

    it("requires an SDK with profiles", () => {
      expect(problemsOf({ ...catalog, sdk: "^0.1.3" })).toEqual(['with items, stats or flags, sdk must be at least "^0.1.4"; older servers do not know profiles']);
    });

    it("reports errors in the catalog", () => {
      expect(problemsOf({ ...catalog, items: { "Koeder Wurm": { label: "Wurm" } }, flags: { held: { label: "Held", wert: 1 } } })).toEqual(
        expect.arrayContaining([expect.stringContaining("items.Koeder Wurm: names consist"), "flags.held.wert is unknown, allowed are label, deprecated"]),
      );
    });

    it("allows up to 200 stats", () => {
      const stats = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`s-${i}`, { label: "S" }]));
      expect(problemsOf({ ...catalog, stats })).toEqual([]);
      expect(problemsOf({ ...catalog, stats: { ...stats, zuviel: { label: "Z" } } })).toEqual(["stats has 201 entries, at most 200 are allowed"]);
    });
  });

  it("accepts the manifest of the realtime test game Wettlauf", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../fixtures/wettlauf/manifest.json", import.meta.url), "utf8")) as unknown;
    expect(validateManifest(raw).ok).toBe(true);
  });

  it.each([
    ["not an object", "manifest", "must be a JSON object"],
    ["a typo in the field name", { ...valid, nmae: "x" }, "nmae is unknown"],
  ])("reports %s", (_name, raw, expected) => {
    const checked = validateManifest(raw);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? [] : checked.problems).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it.each([
    ["an invalid id", { id: "Mau Mau" }, "id must consist of lowercase letters"],
    ["an empty name", { name: " " }, "name must"],
    ["an invalid version", { version: "1.0" }, "version must"],
    ["a missing SDK version", { sdk: undefined }, "sdk must"],
    ["a non-free code license", { license: { code: "proprietary", assets: "CC0-1.0" } }, "license.code must"],
    ["an NC license for assets", { license: { code: "MIT", assets: "CC-BY-NC-4.0" } }, "license.assets must"],
    ["an unknown mode", { mode: "async" }, "mode must"],
    ["a wrong player count", { players: { min: 3, max: 2 } }, "players.max must not be less"],
    ["server as a text", { server: "ja" }, "server must"],
    ["roles without players", { roles: { screen: { inputs: [], screen: "large" } } }, "at least player or controller"],
    ["an unknown role", { roles: { player: valid.roles.player, spectator: {} } }, "roles.spectator is unknown"],
    ["an unknown input", { roles: { player: { inputs: ["voice"], screen: "small" } } }, "roles.player.inputs must"],
    ["a player without input", { roles: { player: { inputs: [], screen: "small" } } }, "must not be empty"],
    ["an unknown screen class", { roles: { player: { inputs: ["touch"], screen: "huge" } } }, "roles.player.screen must"],
    ["single player with several players", { mode: "single", players: { min: 1, max: 2 } }, 'with mode "single"'],
    ["multiplayer without a server", { server: false }, "server must be true"],
    ["a missing client", { client: undefined }, "client must be the folder"],
    ["a client outside the game folder", { client: "../other/dist" }, "inside the game folder"],
    ["an absolute client path", { client: "/srv/client" }, "inside the game folder"],
    ["a client path with a backslash", { client: "dist\\client" }, "with / as separator"],
  ])("reports %s", (_name, changes, expected) => {
    expect(problemsOf(changes)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });
});
