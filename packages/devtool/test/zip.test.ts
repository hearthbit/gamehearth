import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip, writeZip, type ZipEntry } from "../src/zip";

const limits = { maxEntries: 100, maxBytes: 1024 * 1024 };

interface RawRecord {
  name: string;
  nameBytes?: Buffer;
  data: Buffer;
  method?: number;
  flags?: number;
  madeBy?: number;
  external?: number;
  crc?: number;
  size?: number;
  localName?: string;
  offset?: number;
  skipLocal?: boolean;
}

function rawZip(records: RawRecord[], options: { prefix?: Buffer; gap?: Buffer; comment?: Buffer; entryCount?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = options.prefix?.length ?? 0;
  if (options.prefix !== undefined) {
    parts.push(options.prefix);
  }
  const offsets: number[] = [];
  for (const record of records) {
    const method = record.method ?? 8;
    const body = method === 8 ? deflateRawSync(record.data) : record.data;
    const crc = record.crc ?? crc32(record.data);
    const size = record.size ?? record.data.length;
    const flags = record.flags ?? 0x0800;
    const name = record.nameBytes ?? Buffer.from(record.name, "utf8");
    const localName = record.localName === undefined ? name : Buffer.from(record.localName, "utf8");
    offsets.push(offset);
    if (record.skipLocal !== true) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(localName.length, 26);
      parts.push(local, localName, body);
      offset += 30 + localName.length + body.length;
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(record.madeBy ?? 0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(record.external ?? ((0o100644 << 16) >>> 0), 38);
    header.writeUInt32LE(record.offset ?? (offsets.at(-1) as number), 42);
    central.push(header, name);
  }
  if (options.gap !== undefined) {
    parts.push(options.gap);
    offset += options.gap.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.entryCount ?? records.length, 8);
  end.writeUInt16LE(options.entryCount ?? records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, ...central, end, comment]);
}

const text = (value: string) => Buffer.from(value, "utf8");

describe("ZIP", () => {
  it("reads back what it writes, sorted by path", () => {
    const entries: ZipEntry[] = [
      { path: "manifest.json", data: text('{"id":"x"}') },
      { path: "client/index.html", data: text("<!doctype html>".repeat(50)) },
      { path: "client/assets/empty.txt", data: Buffer.alloc(0) },
    ];
    const archive = writeZip(entries);
    expect(readZip(archive, limits).map((entry) => [entry.path, entry.data.toString("utf8")])).toEqual([
      ["client/assets/empty.txt", ""],
      ["client/index.html", "<!doctype html>".repeat(50)],
      ["manifest.json", '{"id":"x"}'],
    ]);
  });

  it("writes the same archive for the same content in another order", () => {
    const a = writeZip([
      { path: "b.txt", data: text("b") },
      { path: "a.txt", data: text("a") },
    ]);
    const b = writeZip([
      { path: "a.txt", data: text("a") },
      { path: "b.txt", data: text("b") },
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it("also reads archives of other tools with a Windows host", () => {
    const archive = rawZip([{ name: "a.txt", data: text("hello"), madeBy: 20, external: 0x20 }]);
    expect(readZip(archive, limits)[0]?.data.toString()).toBe("hello");
  });

  it.each([
    ["no ZIP", Buffer.from("this is no archive, just text, long enough"), "not a ZIP archive"],
    ["too short", Buffer.alloc(5), "not a ZIP archive"],
    ["comment at the end", rawZip([{ name: "a.txt", data: text("a") }], { comment: text("hi") }), "not a ZIP archive from gamehearth pack"],
    ["data before it", rawZip([{ name: "a.txt", data: text("a") }], { prefix: text("MZ-program") }), "without gaps"],
    ["gap before the central directory", rawZip([{ name: "a.txt", data: text("a") }], { gap: text("hidden") }), "foreign data"],
    ["path upwards", rawZip([{ name: "../evil.txt", data: text("a") }]), "contains empty segments"],
    ["path upwards in the middle", rawZip([{ name: "client/../../x", data: text("a") }]), "contains empty segments"],
    ["absolute path", rawZip([{ name: "/etc/passwd", data: text("a") }]), "is not an allowed path"],
    ["Backslash", rawZip([{ name: "client\\..\\x", data: text("a") }]), "is not an allowed path"],
    ["drive letter", rawZip([{ name: "C:/x", data: text("a") }]), "is not an allowed path"],
    ["control character", rawZip([{ name: "a\u0000.txt", data: text("a") }]), "is not an allowed path"],
    ["folder entry", rawZip([{ name: "client/", data: Buffer.alloc(0), method: 0 }]), "folder entry"],
    ["symlink", rawZip([{ name: "client/x", data: text("/etc/passwd"), external: ((0o120777 << 16) >>> 0) }]), "symlink"],
    ["device file", rawZip([{ name: "client/x", data: text("a"), external: ((0o020644 << 16) >>> 0) }]), "is not a regular file"],
    ["Windows folder", rawZip([{ name: "x", data: Buffer.alloc(0), madeBy: 20, external: 0x10, method: 0 }]), "marked as a folder"],
    ["encrypted", rawZip([{ name: "a.txt", data: text("a"), flags: 0x0801 }]), "encrypted"],
    ["data descriptor", rawZip([{ name: "a.txt", data: text("a"), flags: 0x0808 }]), "never writes"],
    ["other method", rawZip([{ name: "a.txt", data: text("a"), method: 12 }]), "method 12"],
    ["duplicate name", rawZip([{ name: "a.txt", data: text("a") }, { name: "a.txt", data: text("b") }]), "more than once"],
    ["duplicate with other case", rawZip([{ name: "A.txt", data: text("a") }, { name: "a.txt", data: text("b") }]), "more than once"],
    ["file and folder at once", rawZip([{ name: "client", data: text("a") }, { name: "client/x", data: text("b") }]), "both a file and a folder"],
    ["wrong checksum", rawZip([{ name: "a.txt", data: text("abc"), crc: 1234 }]), "checksum"],
    ["declared smaller than unpacked", rawZip([{ name: "a.txt", data: Buffer.alloc(100_000), size: 10 }]), "larger than declared"],
    ["local header with another name", rawZip([{ name: "a.txt", data: text("a"), localName: "b.txt" }]), "contradict each other"],
  ])("rejects: %s", (_name, archive, message) => {
    expect(() => readZip(archive, limits)).toThrow(message);
  });

  it("rejects names that are not UTF-8", () => {
    const archive = rawZip([{ name: "", nameBytes: Buffer.from([0x61, 0xff, 0xfe]), data: text("a") }]);
    expect(() => readZip(archive, limits)).toThrow("UTF-8");
  });

  it("rejects entries that point to the same data", () => {
    const archive = rawZip([
      { name: "a.txt", data: text("x".repeat(1000)) },
      { name: "b.txt", data: text("x".repeat(1000)), offset: 0, skipLocal: true },
    ]);
    expect(() => readZip(archive, limits)).toThrow("without gaps");
  });

  it("checks number and size of the entries before unpacking", () => {
    const many = rawZip(Array.from({ length: 5 }, (_, index) => ({ name: `${index}.txt`, data: text("a") })));
    expect(() => readZip(many, { maxEntries: 4, maxBytes: 1000 })).toThrow("5 entries, allowed are 4");
    const bomb = rawZip([{ name: "bomb.txt", data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => readZip(bomb, { maxEntries: 4, maxBytes: 1024 * 1024 })).toThrow("larger than 1 MB");
  });

  it("rejects ZIP64 markers", () => {
    const archive = rawZip([{ name: "a.txt", data: text("a") }], { entryCount: 0xffff });
    expect(() => readZip(archive, { maxEntries: 100_000, maxBytes: 1000 })).toThrow("ZIP64");
  });

  it("writes no unsafe paths", () => {
    expect(() => writeZip([{ path: "../x", data: text("a") }])).toThrow("contains empty segments");
    expect(() => writeZip([{ path: "a", data: text("a") }, { path: "A", data: text("b") }])).toThrow("more than once");
  });
});
