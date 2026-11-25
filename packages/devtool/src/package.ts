import { sdkVersion } from "@gamehearth/sdk/platform";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleGameModule } from "./bundle";
import { clientEntry, inspectClient, maxClientBytes, maxClientFiles, safeSegment } from "./client-files";
import { coverProblems } from "./cover";
import { validateManifest, type Manifest } from "./manifest";
import { readZip, writeZip, ZipError, type ZipEntry } from "./zip";

export const maxPackageBytes = 60 * 1024 * 1024;
export const maxCodeBytes = 5 * 1024 * 1024;
export const maxTextBytes = 256 * 1024;
export const packageFiles = { manifest: "manifest.json", code: "game.mjs", license: "LICENSE", readme: "README.md", info: "pack.json", client: "client" } as const;

export const devtoolVersion: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface PackInfo {
  format: 1;
  sdk: string;
  devtool: string;
  warnings: number;
}

export interface PackageFile {
  path: string;
  data: Buffer;
  sha256: string;
}

export interface GamePackage {
  manifest: Manifest;
  manifestText: string;
  code: string;
  client: PackageFile[];
  license: string;
  readme: string | undefined;
  info: PackInfo;
  build: string;
}

export class PackageError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("; "));
    this.problems = problems;
  }
}

export function contentHash(manifestText: string, code: string, files: readonly { path: string; sha256: string }[]): string {
  const hash = createHash("sha256").update(manifestText).update("\n").update(code);
  for (const file of files) {
    hash.update(`\n${file.path}\u0000${file.sha256}`);
  }
  return hash.digest("hex").slice(0, 12);
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizedManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function utf8(data: Buffer, name: string, problems: string[]): string | undefined {
  try {
    return decoder.decode(data);
  } catch {
    problems.push(`${name} is not valid UTF-8`);
    return undefined;
  }
}

export function inspectPackage(archive: Buffer, installedSdk: string = sdkVersion): GamePackage {
  if (archive.length > maxPackageBytes) {
    throw new PackageError([`The package is larger than ${maxPackageBytes / 1024 / 1024} MB`]);
  }
  let entries: ZipEntry[];
  try {
    entries = readZip(archive, { maxEntries: maxClientFiles + 5, maxBytes: maxPackageBytes });
  } catch (error) {
    throw new PackageError([error instanceof ZipError ? error.message : `Cannot read the package: ${String(error)}`]);
  }
  const problems: string[] = [];
  const files = new Map<string, Buffer>();
  const client: PackageFile[] = [];
  let clientBytes = 0;
  const clientPrefix = `${packageFiles.client}/`;
  const topLevel = new Set<string>([packageFiles.manifest, packageFiles.code, packageFiles.license, packageFiles.readme, packageFiles.info]);
  for (const entry of entries) {
    if (entry.path.startsWith(clientPrefix)) {
      const path = entry.path.slice(clientPrefix.length);
      if (!path.split("/").every((segment) => safeSegment.test(segment))) {
        problems.push(`${entry.path}: file names may only contain letters, digits, spaces and ._@+~()-`);
        continue;
      }
      client.push({ path, data: entry.data, sha256: sha256(entry.data) });
      clientBytes += entry.data.length;
    } else if (topLevel.has(entry.path)) {
      files.set(entry.path, entry.data);
    } else {
      problems.push(`${entry.path} does not belong in a game package (allowed are ${[...topLevel].join(", ")} and the folder ${clientPrefix})`);
    }
  }
  if (client.length > maxClientFiles) {
    problems.push(`The client has more than ${maxClientFiles} files`);
  }
  if (clientBytes > maxClientBytes) {
    problems.push(`The client is larger than ${maxClientBytes / 1024 / 1024} MB`);
  }
  if (!client.some((file) => file.path === clientEntry)) {
    problems.push(`The package has no ${clientPrefix}${clientEntry}`);
  }

  let manifest: Manifest | undefined;
  const manifestData = files.get(packageFiles.manifest);
  if (manifestData === undefined) {
    problems.push(`The package has no ${packageFiles.manifest}`);
  } else {
    const text = utf8(manifestData, packageFiles.manifest, problems);
    if (text !== undefined) {
      try {
        const checked = validateManifest(JSON.parse(text.replace(/^﻿/, "")), installedSdk);
        if (checked.ok) {
          manifest = checked.manifest;
        } else {
          problems.push(...checked.problems.map((problem) => `${packageFiles.manifest}: ${problem}`));
        }
      } catch {
        problems.push(`${packageFiles.manifest} is not valid JSON`);
      }
    }
  }

  if (manifest?.cover !== undefined) {
    const cover = manifest.cover;
    problems.push(...coverProblems(cover, client.find((file) => file.path === cover)?.data, `${clientPrefix} of the package`));
  }

  let code = "";
  const codeData = files.get(packageFiles.code);
  if (manifest !== undefined && manifest.server && codeData === undefined) {
    problems.push(`The package has no ${packageFiles.code}, although the manifest announces a reducer (server: true)`);
  }
  if (manifest !== undefined && !manifest.server && codeData !== undefined) {
    problems.push(`${packageFiles.code} only belongs in packages with a reducer (server: true)`);
  }
  if (codeData !== undefined) {
    if (codeData.length > maxCodeBytes) {
      problems.push(`${packageFiles.code} is larger than ${maxCodeBytes / 1024 / 1024} MB`);
    } else {
      code = utf8(codeData, packageFiles.code, problems) ?? "";
    }
  }

  let license = "";
  const licenseData = files.get(packageFiles.license);
  if (licenseData === undefined) {
    problems.push(`The package has no ${packageFiles.license}`);
  } else if (licenseData.length > maxTextBytes) {
    problems.push(`${packageFiles.license} is larger than ${maxTextBytes / 1024} KB`);
  } else {
    license = utf8(licenseData, packageFiles.license, problems) ?? "";
  }

  let readme: string | undefined;
  const readmeData = files.get(packageFiles.readme);
  if (readmeData !== undefined) {
    if (readmeData.length > maxTextBytes) {
      problems.push(`${packageFiles.readme} is larger than ${maxTextBytes / 1024} KB`);
    } else {
      readme = utf8(readmeData, packageFiles.readme, problems);
    }
  }

  let info: PackInfo | undefined;
  const infoData = files.get(packageFiles.info);
  if (infoData === undefined) {
    problems.push(`The package has no ${packageFiles.info}; packages are made with gamehearth pack`);
  } else {
    info = parsePackInfo(infoData, problems);
  }

  if (problems.length > 0 || manifest === undefined || info === undefined) {
    throw new PackageError(problems);
  }
  client.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestText = normalizedManifest(manifest);
  const build = `${manifest.id}@${manifest.version}+${contentHash(manifestText, code, client)}`;
  return { manifest, manifestText, code, client, license, readme, info, build };
}

function parsePackInfo(data: Buffer, problems: string[]): PackInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    problems.push(`${packageFiles.info} is not valid JSON`);
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${packageFiles.info} must be a JSON object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const version = (value: unknown) => typeof value === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value);
  const warnings = record["warnings"];
  if (record["format"] !== 1 || !version(record["sdk"]) || !version(record["devtool"]) || !Number.isSafeInteger(warnings) || (warnings as number) < 0) {
    problems.push(`${packageFiles.info} does not have the form { "format": 1, "sdk": "0.1.0", "devtool": "0.1.0", "warnings": 0 }`);
    return undefined;
  }
  return { format: 1, sdk: record["sdk"] as string, devtool: record["devtool"] as string, warnings: warnings as number };
}

export interface BuiltPackage {
  archive: Buffer;
  pkg: GamePackage;
}

export async function buildPackage(gameDir: string, options: { warnings: number }): Promise<BuiltPackage> {
  const manifestRaw = (await readFile(join(gameDir, packageFiles.manifest), "utf8")).replace(/^﻿/, "");
  const checked = validateManifest(JSON.parse(manifestRaw));
  if (!checked.ok) {
    throw new PackageError(checked.problems.map((problem) => `${packageFiles.manifest}: ${problem}`));
  }
  const manifest = checked.manifest;
  const client = await inspectClient(gameDir, manifest.client);
  if (!client.ok) {
    throw new PackageError(client.problems);
  }
  let license: Buffer;
  try {
    license = await readFile(join(gameDir, packageFiles.license));
  } catch {
    throw new PackageError([`${packageFiles.license} is missing in the game folder. Every package needs the license of the game.`]);
  }
  const entries: ZipEntry[] = [
    { path: packageFiles.manifest, data: Buffer.from(manifestRaw, "utf8") },
    { path: packageFiles.license, data: license },
    {
      path: packageFiles.info,
      data: Buffer.from(`${JSON.stringify({ format: 1, sdk: sdkVersion, devtool: devtoolVersion, warnings: options.warnings }, null, 2)}\n`, "utf8"),
    },
  ];
  if (manifest.server) {
    entries.push({ path: packageFiles.code, data: Buffer.from(await bundleGameModule(gameDir), "utf8") });
  }
  if (existsSync(join(gameDir, packageFiles.readme))) {
    entries.push({ path: packageFiles.readme, data: await readFile(join(gameDir, packageFiles.readme)) });
  }
  for (const file of client.files) {
    entries.push({ path: `${packageFiles.client}/${file.path}`, data: await readFile(join(client.dir, ...file.path.split("/"))) });
  }
  const archive = writeZip(entries);
  return { archive, pkg: inspectPackage(archive) };
}
