import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sdkVersion } from "@gamehearth/sdk/platform";
import { buildPackage, contentHash, devtoolVersion, inspectPackage, maxPackageBytes, normalizedManifest, PackageError, sha256 } from "../src/package";
import { readZip, writeZip, type ZipEntry } from "../src/zip";
import { mauMauSource, withStubClient } from "./mau-mau";

function gameDir(): string {
  const dir = withStubClient(mauMauSource);
  writeFileSync(join(dir, "LICENSE"), "MIT License\n");
  writeFileSync(join(dir, "README.md"), "# Mau-Mau\n");
  return dir;
}

const built = await buildPackage(gameDir(), { warnings: 2 });

function entries(): ZipEntry[] {
  return readZip(built.archive, { maxEntries: 100, maxBytes: maxPackageBytes });
}

function repack(change: (files: Map<string, Buffer>) => void): Buffer {
  const files = new Map(entries().map((entry) => [entry.path, entry.data]));
  change(files);
  return writeZip([...files].map(([path, data]) => ({ path, data })));
}

function problems(archive: Buffer): string[] {
  try {
    inspectPackage(archive);
  } catch (error) {
    if (error instanceof PackageError) {
      return error.problems;
    }
    throw error;
  }
  return [];
}

describe("game package", () => {
  it("contains manifest, reducer, client, license, README and pack.json", () => {
    expect(entries().map((entry) => entry.path)).toEqual(["LICENSE", "README.md", "client/index.html", "game.mjs", "manifest.json", "pack.json"]);
    const pkg = inspectPackage(built.archive);
    expect(pkg.manifest.id).toBe("mau-mau");
    expect(pkg.info).toEqual({ format: 1, sdk: sdkVersion, devtool: devtoolVersion, warnings: 2 });
    expect(pkg.license).toBe("MIT License\n");
    expect(pkg.readme).toBe("# Mau-Mau\n");
    expect(pkg.client.map((file) => file.path)).toEqual(["index.html"]);
    expect(pkg.code).toContain("export");
  });

  it("names the build like the server with the hash over manifest, code and client", () => {
    const pkg = inspectPackage(built.archive);
    const hash = contentHash(normalizedManifest(pkg.manifest), pkg.code, pkg.client);
    expect(pkg.build).toBe(`mau-mau@0.1.0+${hash}`);
    expect(built.pkg.build).toBe(pkg.build);
  });

  it("builds the same archive from the same state", async () => {
    const again = await buildPackage(gameDir(), { warnings: 2 });
    expect(sha256(again.archive)).toBe(sha256(built.archive));
  });

  it("requires a license in the game folder", async () => {
    const dir = gameDir();
    rmSync(join(dir, "LICENSE"));
    await expect(buildPackage(dir, { warnings: 0 })).rejects.toThrow("LICENSE is missing");
  });

  it("requires a built client", async () => {
    const dir = withStubClient(mauMauSource, false);
    writeFileSync(join(dir, "LICENSE"), "MIT");
    await expect(buildPackage(dir, { warnings: 0 })).rejects.toThrow("is missing");
  });

  it.each<[string, (files: Map<string, Buffer>) => void, string]>([
    ["foreign file", (files) => files.set("install.sh", Buffer.from("rm -rf /")), "install.sh does not belong in a game package"],
    ["file in a subfolder outside client", (files) => files.set("src/index.ts", Buffer.from("")), "src/index.ts does not belong"],
    ["without a manifest", (files) => files.delete("manifest.json"), "has no manifest.json"],
    ["broken manifest", (files) => files.set("manifest.json", Buffer.from("{ id: mau")), "is not valid JSON"],
    ["manifest with errors", (files) => files.set("manifest.json", Buffer.from('{"id":"Mau Mau"}')), "manifest.json: id must"],
    [
      "manifest for a newer SDK",
      (files) => {
        const manifest = JSON.parse((files.get("manifest.json") as Buffer).toString()) as Record<string, unknown>;
        files.set("manifest.json", Buffer.from(JSON.stringify({ ...manifest, sdk: "^0.2.0" })));
      },
      "sdk requires ^0.2.0",
    ],
    ["without a reducer", (files) => files.delete("game.mjs"), "has no game.mjs"],
    ["reducer not UTF-8", (files) => files.set("game.mjs", Buffer.from([0xff, 0xfe, 0x00])), "game.mjs is not valid UTF-8"],
    ["reducer too large", (files) => files.set("game.mjs", Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)), "game.mjs is larger than 5 MB"],
    ["without a license", (files) => files.delete("LICENSE"), "has no LICENSE"],
    ["README too large", (files) => files.set("README.md", Buffer.alloc(256 * 1024 + 1, 0x20)), "README.md is larger than 256 KB"],
    ["without pack.json", (files) => files.delete("pack.json"), "has no pack.json"],
    ["pack.json wrong", (files) => files.set("pack.json", Buffer.from('{"format":2}')), "pack.json does not have the form"],
    ["without index.html", (files) => files.delete("client/index.html"), "has no client/index.html"],
    ["odd file name in the client", (files) => files.set("client/a$b.js", Buffer.from("")), "client/a$b.js: file names"],
  ])("rejects: %s", (_name, change, message) => {
    expect(problems(repack(change)).join("\n")).toContain(message);
  });

  it("names all problems at once", () => {
    const found = problems(
      repack((files) => {
        files.delete("LICENSE");
        files.delete("pack.json");
      }),
    );
    expect(found).toEqual(expect.arrayContaining(["The package has no LICENSE", expect.stringContaining("The package has no pack.json")]));
  });

  it("rejects packages above 60 MB without reading them", () => {
    expect(problems(Buffer.alloc(maxPackageBytes + 1))).toEqual(["The package is larger than 60 MB"]);
  });

  it("passes on ZIP errors as package errors", () => {
    expect(problems(Buffer.from("no zip, just a bit of text"))).toEqual([expect.stringContaining("not a ZIP archive")]);
  });

  it("reads a manifest with a BOM", () => {
    const archive = repack((files) => files.set("manifest.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), files.get("manifest.json") as Buffer])));
    expect(inspectPackage(archive).build).toBe(built.pkg.build);
  });

  it("takes description and repository from the manifest", () => {
    const archive = repack((files) => {
      const manifest = JSON.parse((files.get("manifest.json") as Buffer).toString()) as Record<string, unknown>;
      files.set("manifest.json", Buffer.from(JSON.stringify({ ...manifest, description: "Card game", repository: "https://example.org/mau" })));
    });
    expect(inspectPackage(archive).manifest).toMatchObject({ description: "Card game", repository: "https://example.org/mau" });
    const bad = repack((files) => {
      const manifest = JSON.parse((files.get("manifest.json") as Buffer).toString()) as Record<string, unknown>;
      files.set("manifest.json", Buffer.from(JSON.stringify({ ...manifest, repository: "http://example.org/mau" })));
    });
    expect(problems(bad).join()).toContain("repository must be the https URL");
  });

  it("keeps to the limits for the client like check", () => {
    const manifest = readFileSync(join(gameDir(), "manifest.json"));
    const archive = writeZip([
      { path: "manifest.json", data: manifest },
      { path: "game.mjs", data: Buffer.from("export default {}") },
      { path: "LICENSE", data: Buffer.from("MIT") },
      { path: "pack.json", data: Buffer.from('{"format":1,"sdk":"0.1.0","devtool":"0.1.0","warnings":0}') },
      { path: "client/index.html", data: Buffer.from("") },
      ...Array.from({ length: 5001 }, (_, index) => ({ path: `client/f${index}.js`, data: Buffer.from("") })),
    ]);
    expect(problems(archive).join()).toMatch(/entries|more than 5000 files/);
  });
});
