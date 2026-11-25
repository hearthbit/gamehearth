export const maxTextPlaceholderLength = 8_000;
export const maxPlaceholderChars = 1_000;

export interface TextSpec {
  min?: number;
  max: number;
  chars?: string;
}

export interface IntSpec {
  min: number;
  max: number;
}

export type Placeholder = { $text: TextSpec } | { $int: IntSpec };

export interface PlaceholderRandom {
  next(): number;
}

export function text(spec: TextSpec): string {
  const copy: TextSpec = { max: spec.max };
  if (spec.min !== undefined) copy.min = spec.min;
  if (spec.chars !== undefined) copy.chars = spec.chars;
  return { $text: copy } as unknown as string;
}

export function int(spec: IntSpec): number {
  return { $int: { min: spec.min, max: spec.max } } as unknown as number;
}

export function isPlaceholder(value: unknown): value is Placeholder {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "$text" || keys[0] === "$int");
}

export function hasPlaceholder(value: unknown): boolean {
  if (isPlaceholder(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasPlaceholder);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasPlaceholder);
  }
  return false;
}

export function placeholderProblem(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = placeholderProblem(value[i], `${path}[${i}]`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const marker = keys.find((key) => key === "$text" || key === "$int");
  if (marker !== undefined) {
    if (keys.length !== 1) {
      return `${path} has the key ${marker} and other keys; an object with ${marker} is a placeholder, create it with ${marker === "$text" ? "text()" : "int()"} and nothing else`;
    }
    return marker === "$text" ? textSpecProblem(record[marker], `${path}`) : intSpecProblem(record[marker], `${path}`);
  }
  for (const key of keys) {
    const problem = placeholderProblem(record[key], `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function textSpecProblem(spec: unknown, path: string): string | undefined {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return `${path} is a broken text placeholder, create it with text({ max })`;
  }
  const record = spec as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "min" && key !== "max" && key !== "chars") {
      return `${path}: text() knows only min, max and chars, not ${key}`;
    }
  }
  const max = record["max"];
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > maxTextPlaceholderLength) {
    return `${path}: text() needs max as a whole number from 1 to ${maxTextPlaceholderLength}, got ${JSON.stringify(max)}`;
  }
  const min = record["min"];
  if (min !== undefined && (!Number.isSafeInteger(min) || (min as number) < 0 || (min as number) > (max as number))) {
    return `${path}: text() needs min as a whole number from 0 to max (${String(max)}), got ${JSON.stringify(min)}`;
  }
  const chars = record["chars"];
  if (chars !== undefined) {
    if (typeof chars !== "string" || chars.length === 0) {
      return `${path}: chars in text() must be a non-empty text of the allowed characters`;
    }
    const points = codePoints(chars);
    if (points === undefined || points.length > maxPlaceholderChars) {
      return `${path}: chars in text() must be at most ${maxPlaceholderChars} characters without broken surrogates`;
    }
    const control = points.find(isControl);
    if (control !== undefined) {
      return `${path}: chars in text() contains the control character U+${control.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;
    }
    const unstable = points.find((point) => point.normalize("NFC") !== point);
    if (unstable !== undefined) {
      return `${path}: chars in text() contains ${JSON.stringify(unstable)}, which texts never contain because they arrive normalized to NFC; write ${JSON.stringify(unstable.normalize("NFC"))} instead`;
    }
  }
  return undefined;
}

function intSpecProblem(spec: unknown, path: string): string | undefined {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return `${path} is a broken int placeholder, create it with int({ min, max })`;
  }
  const record = spec as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "min" && key !== "max") {
      return `${path}: int() knows only min and max, not ${key}`;
    }
  }
  const { min, max } = record;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || (min as number) > (max as number)) {
    return `${path}: int() needs min and max as whole numbers with min <= max, got ${JSON.stringify(min)} and ${JSON.stringify(max)}`;
  }
  return undefined;
}

export function longestFill(template: unknown): number {
  return JSON.stringify(widest(template)).length;
}

function widest(template: unknown): unknown {
  if (isPlaceholder(template)) {
    if ("$text" in template) {
      return '"'.repeat(template.$text.max);
    }
    return String(template.$int.min).length > String(template.$int.max).length ? template.$int.min : template.$int.max;
  }
  if (Array.isArray(template)) {
    return template.map(widest);
  }
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, widest(value)]));
  }
  return template;
}

export function fillPlaceholders(template: unknown, action: unknown): { ok: true; value: unknown } | { ok: false } {
  if (isPlaceholder(template)) {
    return "$text" in template ? fillText(template.$text, action) : fillInt(template.$int, action);
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(action) || action.length !== template.length) {
      return { ok: false };
    }
    const filled: unknown[] = [];
    for (let i = 0; i < template.length; i++) {
      const item = fillPlaceholders(template[i], action[i]);
      if (!item.ok) return item;
      filled.push(item.value);
    }
    return { ok: true, value: filled };
  }
  if (template !== null && typeof template === "object") {
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
      return { ok: false };
    }
    const keys = Object.keys(template);
    const given = Object.keys(action);
    if (given.length !== keys.length || !given.every((key) => Object.hasOwn(template, key))) {
      return { ok: false };
    }
    const filled = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const item = fillPlaceholders((template as Record<string, unknown>)[key], (action as Record<string, unknown>)[key]);
      if (!item.ok) return item;
      filled[key] = item.value;
    }
    return { ok: true, value: filled };
  }
  return template === action ? { ok: true, value: action } : { ok: false };
}

export function textProblem(spec: TextSpec, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "is not a text";
  }
  const normalized = value.normalize("NFC");
  const points = codePoints(normalized);
  if (points === undefined) {
    return "contains a broken surrogate";
  }
  const min = spec.min ?? 0;
  if (points.length < min || points.length > spec.max) {
    return `has ${points.length} characters, allowed are ${min} to ${spec.max}`;
  }
  if (spec.chars !== undefined) {
    const allowed = new Set(codePoints(spec.chars) ?? []);
    const outside = points.find((point) => !allowed.has(point));
    if (outside !== undefined) {
      return `contains ${JSON.stringify(outside)}, which is not in chars`;
    }
  } else if (points.some(isControl)) {
    return "contains a control character or line break";
  }
  return undefined;
}

function fillText(spec: TextSpec, value: unknown): { ok: true; value: string } | { ok: false } {
  return textProblem(spec, value) === undefined ? { ok: true, value: (value as string).normalize("NFC") } : { ok: false };
}

function fillInt(spec: IntSpec, value: unknown): { ok: true; value: number } | { ok: false } {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
    ? { ok: true, value: value === 0 ? 0 : value }
    : { ok: false };
}

const defaultPool = codePoints(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789      äöüÄÖÜßéèêçñåøæ-'.,!?:;()&@#%/\"_+=*~<>{}[]$€😀🎨👍🏽字ש",
) as string[];

export function sampleMove(template: unknown, random: PlaceholderRandom): unknown {
  if (isPlaceholder(template)) {
    return "$text" in template ? sampleText(template.$text, random) : sampleInt(template.$int, random);
  }
  if (Array.isArray(template)) {
    return template.map((item) => sampleMove(item, random));
  }
  if (template !== null && typeof template === "object") {
    const filled = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(template)) {
      filled[key] = sampleMove((template as Record<string, unknown>)[key], random);
    }
    return filled;
  }
  return template;
}

function between(random: PlaceholderRandom, min: number, max: number): number {
  return min + Math.floor(random.next() * (max - min + 1));
}

function sampleText(spec: TextSpec, random: PlaceholderRandom): string {
  const min = spec.min ?? 0;
  const pool = spec.chars === undefined ? defaultPool : (codePoints(spec.chars) ?? defaultPool);
  const roll = random.next();
  const length =
    roll < 0.15 ? min : roll < 0.25 ? spec.max : roll < 0.75 ? between(random, min, Math.min(spec.max, min + 12)) : between(random, min, spec.max);
  for (let attempt = 0; attempt < 8; attempt++) {
    let value = "";
    for (let i = 0; i < length; i++) {
      value += pool[Math.floor(random.next() * pool.length)];
    }
    if (textProblem(spec, value) === undefined) {
      return value.normalize("NFC");
    }
  }
  return (pool[0] ?? "a").repeat(Math.max(min, 1));
}

function sampleInt(spec: IntSpec, random: PlaceholderRandom): number {
  const roll = random.next();
  if (roll < 0.1) return spec.min;
  if (roll < 0.2) return spec.max;
  return spec.min + Math.floor(random.next() * (spec.max - spec.min + 1));
}

export function placeholderTexts(template: unknown, action: unknown, into: Set<string>): void {
  if (isPlaceholder(template)) {
    if ("$text" in template && typeof action === "string") {
      into.add(action);
    }
    return;
  }
  if (Array.isArray(template) && Array.isArray(action)) {
    template.forEach((item, index) => placeholderTexts(item, action[index], into));
    return;
  }
  if (template !== null && typeof template === "object" && action !== null && typeof action === "object") {
    for (const key of Object.keys(template)) {
      placeholderTexts((template as Record<string, unknown>)[key], (action as Record<string, unknown>)[key], into);
    }
  }
}

function codePoints(value: string): string[] | undefined {
  const points: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      points.push(value.slice(i, i + 2));
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined;
    } else {
      points.push(value[i] as string);
    }
  }
  return points;
}

function isControl(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}
