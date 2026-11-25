export const maxCoverBytes = 256 * 1024;
export const coverRatioTolerance = 0.03;

export interface CoverSize {
  width: number;
  height: number;
  from: string;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ratioHint = 'for example 640×480, 320×240, 128×96 pixels or an SVG with viewBox="0 0 64 48"';

export function coverProblems(cover: string, data: Buffer | undefined, folder: string): string[] {
  if (data === undefined) {
    return [
      `cover: ${cover} is missing in the built client folder ${folder}. Put the image where the build copies it into the client folder (with Vite: client/public/${cover}) and build again.`,
    ];
  }
  const problems: string[] = [];
  if (data.length > maxCoverBytes) {
    problems.push(
      `cover: ${cover} has ${Math.ceil(data.length / 1024)} KB, at most ${maxCoverBytes / 1024} KB are allowed. Make it smaller: fewer pixels or colors (pixel art stays small as PNG), or simpler shapes in an SVG.`,
    );
  }
  const size = coverSize(cover, data);
  if (typeof size === "string") {
    problems.push(size);
    return problems;
  }
  if (!(size.width > 0 && size.height > 0)) {
    problems.push(`cover: ${cover} has no usable size (${size.from} says ${size.width}×${size.height}).`);
    return problems;
  }
  if (Math.abs(size.width / size.height / (4 / 3) - 1) > coverRatioTolerance) {
    problems.push(
      `cover: ${cover} is ${formatNumber(size.width)}×${formatNumber(size.height)} (${size.from}), but a cover must have the aspect ratio 4:3 (width = height × 4/3, within ${coverRatioTolerance * 100} %), ${ratioHint}.`,
    );
  }
  return problems;
}

export function coverSize(cover: string, data: Buffer): CoverSize | string {
  const extension = cover.toLowerCase().slice(cover.lastIndexOf("."));
  if (extension === ".png") {
    return pngSize(cover, data);
  }
  if (extension === ".webp") {
    return webpSize(cover, data);
  }
  if (extension === ".svg") {
    return svgSize(cover, data);
  }
  return `cover: ${cover} must be a PNG, WebP or SVG file (.png, .webp, .svg).`;
}

function mismatch(cover: string, kind: string, detail: string): string {
  return `cover: ${cover} is not a real ${kind} file (${detail}). Save the image in the format its file name says, or rename the file and change cover in manifest.json to match its real format.`;
}

function pngSize(cover: string, data: Buffer): CoverSize | string {
  if (data.length < 24 || !data.subarray(0, 8).equals(pngSignature) || data.toString("latin1", 12, 16) !== "IHDR") {
    return mismatch(cover, "PNG", "it does not start with the PNG signature and an IHDR header");
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), from: "PNG header" };
}

function webpSize(cover: string, data: Buffer): CoverSize | string {
  if (data.length < 20 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP") {
    return mismatch(cover, "WebP", "it does not start with RIFF … WEBP");
  }
  const chunk = data.toString("latin1", 12, 16);
  if (chunk === "VP8 " && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, from: "WebP header" };
  }
  if (chunk === "VP8L" && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, from: "WebP header" };
  }
  if (chunk === "VP8X" && data.length >= 30) {
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1, from: "WebP header" };
  }
  return mismatch(cover, "WebP", "its image header (VP8, VP8L or VP8X) cannot be read");
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";

function svgSize(cover: string, data: Buffer): CoverSize | string {
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return mismatch(cover, "SVG", "it is not UTF-8 text");
  }
  const start = svgStart(text.replace(/^﻿/, ""));
  if (start === undefined) {
    return mismatch(cover, "SVG", "the first element must be <svg …>, optionally after <?xml …?>, a doctype and comments");
  }
  const attributes = new Map<string, string>();
  for (const match of start.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(match[1] as string, match[2] ?? match[3] ?? "");
  }
  const width = svgLength(attributes.get("width"));
  const height = svgLength(attributes.get("height"));
  if (width !== undefined && height !== undefined && width.unit === height.unit) {
    return { width: width.value, height: height.value, from: "width and height of the <svg> element" };
  }
  const viewBox = new RegExp(`^\\s*(${number})[\\s,]+(${number})[\\s,]+(${number})[\\s,]+(${number})\\s*$`).exec(attributes.get("viewBox") ?? "");
  if (viewBox !== null) {
    return { width: Number(viewBox[3]), height: Number(viewBox[4]), from: "viewBox of the <svg> element" };
  }
  return `cover: ${cover} gives no size, so its aspect ratio is unknown. Give the <svg> element a viewBox whose width and height are in the ratio 4:3, e.g. viewBox="0 0 64 48".`;
}

function svgStart(text: string): string | undefined {
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    const skipped =
      /^<\?[\s\S]*?\?>/.exec(rest) ?? /^<!--[\s\S]*?-->/.exec(rest) ?? /^<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/i.exec(rest);
    if (skipped === null) {
      break;
    }
    rest = rest.slice(skipped[0].length);
  }
  const tag = /^<svg((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/.exec(rest);
  return tag === null ? undefined : (tag[1] ?? "");
}

function svgLength(raw: string | undefined): { value: number; unit: string } | undefined {
  const match = raw === undefined ? null : new RegExp(`^\\s*(${number})\\s*(px|pt|pc|mm|cm|in)?\\s*$`, "i").exec(raw);
  if (match === null) {
    return undefined;
  }
  const unit = (match[2] ?? "px").toLowerCase();
  return { value: Number(match[1]), unit };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
