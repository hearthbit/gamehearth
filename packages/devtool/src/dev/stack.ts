import { SourceMap } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface MappedFile {
  map: SourceMap;
  dir: string;
}

export type MapResolver = (file: string) => MappedFile | undefined;

const location = /^(.*?)(\(?)([^\s()]+?):(\d+):(\d+)(\)?)\s*$/;
const platformSource = /[\\/]node_modules[\\/]@gamehearth[\\/]sdk[\\/]|[\\/]packages[\\/]sdk[\\/]src[\\/]/;

export function sourceMapOf(text: string): SourceMap | undefined {
  try {
    return new SourceMap(JSON.parse(text) as ConstructorParameters<typeof SourceMap>[0]);
  } catch {
    return undefined;
  }
}

export function mapStack(stack: string, resolveMap: MapResolver, gameDir: string): string {
  const lines: string[] = [];
  for (const line of stack.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = location.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    const [, before = "", open = "", located = "", row = "0", column = "0", close = ""] = match;
    const named = /^(.*@)((?:[a-z][a-z0-9+.-]*:\/\/|game\.mjs).*)$/i.exec(located);
    const prefix = `${before}${open}${named?.[1] ?? ""}`;
    const file = named?.[2] ?? located;
    if (file.includes("gamehearth-runner.js")) {
      continue;
    }
    const mapped = resolveMap(file);
    if (mapped === undefined) {
      lines.push(line);
      continue;
    }
    const entry = mapped.map.findEntry(Number(row) - 1, Math.max(Number(column) - 1, 0)) as { originalSource?: string; originalLine?: number; originalColumn?: number };
    if (entry.originalSource === undefined || entry.originalLine === undefined) {
      lines.push(line);
      continue;
    }
    const source = entry.originalSource.replace(/^file:\/\/\/?/, "");
    const absolute = isAbsolute(source) ? source : resolve(mapped.dir, source);
    if (platformSource.test(absolute)) {
      continue;
    }
    const shown = relative(gameDir, absolute);
    const display = shown.startsWith("..") ? absolute : shown.split(sep).join("/");
    lines.push(`${prefix}${display}:${entry.originalLine + 1}:${(entry.originalColumn ?? 0) + 1}${close}`);
  }
  return lines.join("\n");
}
