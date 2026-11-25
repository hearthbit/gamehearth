import { describe, expect, it } from "vitest";
import { addToCatalog, compareVersions, formatCatalog, parseCatalog, validateCatalog, versionEntry, type Catalog, type CatalogVersion } from "../src/catalog";
import type { Manifest } from "../src/manifest";
import { sha256, type GamePackage } from "../src/package";

const manifest: Manifest = {
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

function pkg(overrides: Partial<Manifest> = {}): GamePackage {
  return {
    manifest: { ...manifest, ...overrides },
    manifestText: "",
    code: "",
    client: [],
    license: "MIT",
    readme: undefined,
    info: { format: 1, sdk: "0.1.0", devtool: "0.1.0", warnings: 0 },
    build: "mau-mau@0.1.0+000000000000",
  };
}

function entry(version: string, content = version): CatalogVersion {
  const archive = Buffer.from(content);
  return versionEntry(pkg({ version }), archive, `https://example.org/mau-mau-${version}.zip`);
}

const empty: Catalog = { format: 1, name: "Test", games: [] };

describe("catalog", () => {
  it("builds a valid entry from a package", () => {
    const version = entry("0.1.0", "zip");
    expect(version).toEqual({
      version: "0.1.0",
      sdk: "^0.1.0",
      mode: "turn-based",
      players: { min: 2, max: 6 },
      roles: { player: { inputs: ["touch", "mouse"], screen: "small" } },
      license: { code: "MIT", assets: "CC0-1.0" },
      size: 3,
      url: "https://example.org/mau-mau-0.1.0.zip",
      sha256: sha256(Buffer.from("zip")),
    });
    const catalog = addToCatalog(empty, pkg({ description: "Card game", repository: "https://example.org/mau" }), version);
    expect(parseCatalog(formatCatalog(catalog))).toEqual({ ok: true, catalog });
    expect(catalog.games[0]).toMatchObject({ id: "mau-mau", name: "Mau-Mau", description: "Card game", repository: "https://example.org/mau" });
  });

  it("leaves an optional TV out of the catalog, so older servers can still read it", () => {
    const roles: Manifest["roles"] = { player: { inputs: ["touch"], screen: "small" }, screen: { inputs: [], screen: "large", optional: true } };
    const version = versionEntry(pkg({ sdk: "^0.1.7", mode: "realtime", roles }), Buffer.from("zip"), "https://example.org/mau-mau-0.1.0.zip");
    expect(version.roles).toEqual({ player: { inputs: ["touch"], screen: "small" }, screen: { inputs: [], screen: "large" } });
    expect(roles.screen?.optional).toBe(true);
    expect(validateCatalog({ format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...version, roles }] }] })).toMatchObject({ ok: true });
  });

  it("leaves away out of the catalog, because older servers reject a version entry with an unknown field", () => {
    const playOn = pkg({ sdk: "^0.1.8", mode: "realtime", away: "play-on" });
    const version = versionEntry(playOn, Buffer.from("zip"), "https://example.org/mau-mau-0.1.0.zip");
    expect(version).not.toHaveProperty("away");
    const catalog = addToCatalog(empty, playOn, version);
    expect(formatCatalog(catalog)).not.toContain("away");
    expect(parseCatalog(formatCatalog(catalog))).toEqual({ ok: true, catalog });
    expect(validateCatalog({ format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...version, away: "play-on" }] }] })).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/away is unknown/)],
    });
  });

  it("sorts versions in descending order and takes name and description from the newest", () => {
    let catalog = addToCatalog(empty, pkg({ version: "0.2.0", name: "Mau-Mau 2" }), entry("0.2.0"));
    catalog = addToCatalog(catalog, pkg({ version: "0.1.0", name: "Old Mau-Mau", description: "old" }), entry("0.1.0"));
    catalog = addToCatalog(catalog, pkg({ version: "0.10.0", name: "Mau-Mau 10" }), entry("0.10.0"));
    expect(catalog.games[0]?.versions.map((version) => version.version)).toEqual(["0.10.0", "0.2.0", "0.1.0"]);
    expect(catalog.games[0]?.name).toBe("Mau-Mau 10");
    expect(catalog.games[0]?.description).toBeUndefined();
  });

  it("changes nothing for the same version and refuses a different checksum", () => {
    const catalog = addToCatalog(empty, pkg(), entry("0.1.0", "a"));
    expect(addToCatalog(catalog, pkg(), entry("0.1.0", "a"))).toBe(catalog);
    expect(() => addToCatalog(catalog, pkg(), entry("0.1.0", "b"))).toThrow("--replace");
    const replaced = addToCatalog(catalog, pkg(), entry("0.1.0", "b"), { replace: true });
    expect(replaced.games[0]?.versions).toHaveLength(1);
    expect(replaced.games[0]?.versions[0]?.sha256).toBe(sha256(Buffer.from("b")));
  });

  it("compares versions with prereleases", () => {
    expect(["1.0.0", "1.0.0-beta.1", "0.9.9", "1.0.1", "1.0.0-alpha"].sort(compareVersions)).toEqual(["0.9.9", "1.0.0-alpha", "1.0.0-beta.1", "1.0.0", "1.0.1"]);
  });

  it.each<[string, unknown, string]>([
    ["not an object", [], "JSON object"],
    ["wrong format", { format: 2, name: "x", games: [] }, "format must be 1"],
    ["unknown field", { format: 1, name: "x", games: [], extra: 1 }, "extra is unknown"],
    ["without a name", { format: 1, games: [] }, "name must"],
    ["game twice", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [entry("1.0.0")] }, { id: "a", name: "A", versions: [entry("1.0.0")] }] }, "more than once in the catalog"],
    ["version twice", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [entry("1.0.0"), entry("1.0.0")] }] }, "version 1.0.0 is listed more than once"],
    ["without versions", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [] }] }, "non-empty list"],
    ["wrong id", { format: 1, name: "x", games: [{ id: "A B", name: "A", versions: [entry("1.0.0")] }] }, ".id must"],
    ["http URL", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), url: "http://example.org/a.zip" }] }] }, "only come over https"],
    ["wrong checksum", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), sha256: "ABC" }] }] }, "sha256 must"],
    ["too large", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), size: 61 * 1024 * 1024 }] }] }, "size must"],
    ["broken player count", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), players: { min: 0 } }] }] }, "players"],
    ["foreign license", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), license: { code: "proprietary", assets: "CC0-1.0" } }] }] }, "license.code"],
    ["unknown version field", { format: 1, name: "x", games: [{ id: "a", name: "A", versions: [{ ...entry("1.0.0"), script: "x" }] }] }, "script is unknown"],
  ])("rejects: %s", (_name, raw, message) => {
    const checked = validateCatalog(raw);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.problems.join("\n")).toContain(message);
  });

  it("rejects catalogs that are too large and broken JSON", () => {
    expect(parseCatalog("{")).toEqual({ ok: false, problems: ["The catalog is not valid JSON"] });
    expect(parseCatalog(" ".repeat(1024 * 1024 + 1))).toEqual({ ok: false, problems: ["The catalog is larger than 1024 KB"] });
  });
});
