import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxBytes: number;
}

export class ZipError extends Error {}

const localSignature = 0x04034b50;
const centralSignature = 0x02014b50;
const endSignature = 0x06054b50;
const localHeaderBytes = 30;
const centralHeaderBytes = 46;
const endBytes = 22;
const dosDate = (1 << 5) | 1;
const utf8Flag = 0x0800;
const allowedFlags = 0x0002 | 0x0004 | utf8Flag;
const unixHost = 3;
const regularFile = 0o100000;
const fileTypeMask = 0o170000;
const symbolicLink = 0o120000;
const maxNameBytes = 512;
const zip64Marker = 0xffffffff;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function zipPathProblem(path: string): string | undefined {
  if (path === "") {
    return "an entry has no name";
  }
  if (Buffer.byteLength(path, "utf8") > maxNameBytes) {
    return `${JSON.stringify(path.slice(0, 40))}… is longer than ${maxNameBytes} bytes`;
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || /[\u0000-\u001f\u007f]/.test(path)) {
    return `${JSON.stringify(path)} is not an allowed path (absolute, backslash, colon or control character)`;
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${JSON.stringify(path)} contains empty segments, . or ..`;
  }
  return undefined;
}

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => compare(a.path, b.path));
  checkNames(sorted.map((entry) => entry.path));
  if (sorted.length >= 0xffff) {
    throw new ZipError(`Too many entries for a ZIP without ZIP64: ${sorted.length}`);
  }
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(localHeaderBytes);
    local.writeUInt32LE(localSignature, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(centralHeaderBytes);
    header.writeUInt32LE(centralSignature, 0);
    header.writeUInt16LE((unixHost << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(utf8Flag, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((regularFile | 0o644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(header, name);
    offset += localHeaderBytes + name.length + body.length;
    if (offset >= zip64Marker) {
      throw new ZipError("The archive would be larger than 4 GB");
    }
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(endBytes);
  end.writeUInt32LE(endSignature, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

interface CentralRecord {
  path: string;
  name: Buffer;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

export function readZip(archive: Buffer, limits: ZipLimits): ZipEntry[] {
  if (archive.length < endBytes) {
    throw new ZipError("The file is not a ZIP archive");
  }
  const endOffset = archive.length - endBytes;
  if (archive.readUInt32LE(endOffset) !== endSignature) {
    throw new ZipError("The file is not a ZIP archive from gamehearth pack (no central directory at the end, or a comment after it)");
  }
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || commentLength !== 0) {
    throw new ZipError("Multi-part archives and comments do not occur in packages");
  }
  if (entryCount === 0xffff || centralSize === zip64Marker || centralOffset === zip64Marker) {
    throw new ZipError("ZIP64 is not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`The archive has ${entryCount} entries, allowed are ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new ZipError("The central directory of the archive is not where it is announced");
  }

  const records: CentralRecord[] = [];
  let position = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index++) {
    if (position + centralHeaderBytes > endOffset || archive.readUInt32LE(position) !== centralSignature) {
      throw new ZipError("The central directory of the archive is corrupt");
    }
    const madeBy = archive.readUInt16LE(position + 4);
    const flags = archive.readUInt16LE(position + 8);
    const method = archive.readUInt16LE(position + 10);
    const crc = archive.readUInt32LE(position + 16);
    const compressed = archive.readUInt32LE(position + 20);
    const size = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28);
    const extraLength = archive.readUInt16LE(position + 30);
    const entryComment = archive.readUInt16LE(position + 32);
    const startDisk = archive.readUInt16LE(position + 34);
    const external = archive.readUInt32LE(position + 38);
    const offset = archive.readUInt32LE(position + 42);
    const next = position + centralHeaderBytes + nameLength + extraLength + entryComment;
    if (next > endOffset) {
      throw new ZipError("The central directory of the archive is corrupt");
    }
    const name = archive.subarray(position + centralHeaderBytes, position + centralHeaderBytes + nameLength);
    let path: string;
    try {
      path = decoder.decode(name);
    } catch {
      throw new ZipError("A file name in the archive is not valid UTF-8");
    }
    if (startDisk !== 0) {
      throw new ZipError("Multi-part archives do not occur in packages");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new ZipError(`${path} is encrypted`);
    }
    if ((flags & ~allowedFlags) !== 0) {
      throw new ZipError(`${path} uses ZIP options that gamehearth pack never writes (flags ${flags.toString(16)})`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`${path} is packed with method ${method}, only deflate and uncompressed are allowed`);
    }
    if (compressed === zip64Marker || size === zip64Marker || offset === zip64Marker) {
      throw new ZipError("ZIP64 is not supported");
    }
    if (path.endsWith("/")) {
      throw new ZipError(`${path} is a folder entry; packages from gamehearth pack contain only files`);
    }
    const host = madeBy >> 8;
    if (host === unixHost) {
      const type = (external >>> 16) & fileTypeMask;
      if (type === symbolicLink) {
        throw new ZipError(`${path} is a symlink; the package may only contain real files`);
      }
      if (type !== 0 && type !== regularFile) {
        throw new ZipError(`${path} is not a regular file`);
      }
    } else if ((external & 0x10) !== 0) {
      throw new ZipError(`${path} is marked as a folder`);
    }
    const problem = zipPathProblem(path);
    if (problem !== undefined) {
      throw new ZipError(problem);
    }
    if (method === 0 && compressed !== size) {
      throw new ZipError(`${path} is uncompressed, but the sizes do not match`);
    }
    total += size;
    if (total > limits.maxBytes) {
      throw new ZipError(`The archive is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB unpacked`);
    }
    records.push({ path, name, method, flags, crc, compressed, size, offset });
    position = next;
  }
  if (position !== endOffset) {
    throw new ZipError("The central directory of the archive is corrupt");
  }
  checkNames(records.map((record) => record.path));

  const byOffset = [...records].sort((a, b) => a.offset - b.offset);
  let expected = 0;
  const entries: ZipEntry[] = [];
  for (const record of byOffset) {
    if (record.offset !== expected) {
      throw new ZipError("The entries of the archive do not follow each other without gaps (overlapping or with foreign data in between)");
    }
    const start = record.offset;
    if (start + localHeaderBytes > centralOffset || archive.readUInt32LE(start) !== localSignature) {
      throw new ZipError(`The entry ${record.path} is corrupt`);
    }
    const flags = archive.readUInt16LE(start + 6);
    const method = archive.readUInt16LE(start + 8);
    const crc = archive.readUInt32LE(start + 14);
    const compressed = archive.readUInt32LE(start + 18);
    const size = archive.readUInt32LE(start + 22);
    const nameLength = archive.readUInt16LE(start + 26);
    const extraLength = archive.readUInt16LE(start + 28);
    const dataStart = start + localHeaderBytes + nameLength + extraLength;
    const dataEnd = dataStart + record.compressed;
    if (dataEnd > centralOffset) {
      throw new ZipError(`The entry ${record.path} reaches beyond the archive`);
    }
    if (
      flags !== record.flags ||
      method !== record.method ||
      crc !== record.crc ||
      compressed !== record.compressed ||
      size !== record.size ||
      !archive.subarray(start + localHeaderBytes, start + localHeaderBytes + nameLength).equals(record.name)
    ) {
      throw new ZipError(`The local header and the central directory of the entry ${record.path} contradict each other`);
    }
    const body = archive.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (record.method === 0) {
      data = Buffer.from(body);
    } else {
      try {
        data = inflateRawSync(body, { maxOutputLength: Math.max(record.size, 1) });
      } catch {
        throw new ZipError(`${record.path} cannot be unpacked or is larger than declared when unpacked`);
      }
    }
    if (data.length !== record.size) {
      throw new ZipError(`${record.path} has ${data.length} instead of ${record.size} bytes unpacked`);
    }
    if (crc32(data) !== record.crc) {
      throw new ZipError(`The checksum of ${record.path} does not match`);
    }
    entries.push({ path: record.path, data });
    expected = dataEnd;
  }
  if (expected !== centralOffset) {
    throw new ZipError("There is foreign data between the entries and the central directory");
  }
  return entries.sort((a, b) => compare(a.path, b.path));
}

function checkNames(paths: readonly string[]): void {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const path of paths) {
    const problem = zipPathProblem(path);
    if (problem !== undefined) {
      throw new ZipError(problem);
    }
    const key = path.toLowerCase();
    if (files.has(key)) {
      throw new ZipError(`${path} occurs more than once (case does not count)`);
    }
    files.add(key);
    const segments = key.split("/");
    for (let length = 1; length < segments.length; length++) {
      folders.add(segments.slice(0, length).join("/"));
    }
  }
  for (const folder of folders) {
    if (files.has(folder)) {
      throw new ZipError(`${folder} is both a file and a folder`);
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
