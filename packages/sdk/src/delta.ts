export type JsonPath = (string | number)[];

export type JsonDeltaOp =
  | { op: "set"; path: JsonPath; value: unknown }
  | { op: "delete"; path: JsonPath }
  | { op: "append"; path: JsonPath; text: string }
  | { op: "push"; path: JsonPath; items: unknown[] }
  | { op: "truncate"; path: JsonPath; length: number };

export type JsonDelta = JsonDeltaOp[];

export type JsonDeltaResult = { ok: true; value: unknown } | { ok: false; message: string };

type Container = Record<string, unknown> | unknown[];

interface Builder {
  ops: JsonDeltaOp[];
  sizes: number[];
  path: JsonPath;
}

export function jsonDelta(base: unknown, next: unknown): JsonDelta {
  const builder: Builder = { ops: [], sizes: [], path: [] };
  walk(builder, base, next);
  return builder.ops;
}

export function applyJsonDelta(base: unknown, delta: unknown): JsonDeltaResult {
  if (!Array.isArray(delta)) {
    return { ok: false, message: "A delta must be a list of operations" };
  }
  const ops: JsonDeltaOp[] = [];
  for (let i = 0; i < delta.length; i++) {
    const op = parseOp(delta[i]);
    if (typeof op === "string") {
      return { ok: false, message: `Operation ${i} ${op}` };
    }
    ops.push(op);
  }
  const fresh = new Set<object>();
  let value = base;
  for (let i = 0; i < ops.length; i++) {
    try {
      value = applyOp(value, ops[i] as JsonDeltaOp, fresh);
    } catch (error) {
      if (error instanceof Misfit) {
        return { ok: false, message: `Operation ${i} does not fit: ${error.message}` };
      }
      throw error;
    }
  }
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key) && object[key] !== undefined;
}

function emit(builder: Builder, op: JsonDeltaOp): void {
  builder.ops.push(op);
  builder.sizes.push(JSON.stringify(op).length);
}

function setOp(builder: Builder, value: unknown): JsonDeltaOp {
  return { op: "set", path: builder.path.slice(), value };
}

function walk(builder: Builder, base: unknown, next: unknown): void {
  if (base === next) {
    return;
  }
  if (typeof base === "string" && typeof next === "string") {
    const grown = base.length > 2 && next.length > base.length && next.startsWith(base);
    emit(builder, grown ? { op: "append", path: builder.path.slice(), text: next.slice(base.length) } : setOp(builder, next));
    return;
  }
  const start = builder.ops.length;
  if (Array.isArray(base) && Array.isArray(next)) {
    walkArray(builder, base, next);
  } else if (isRecord(base) && isRecord(next) && keepsOrder(base, next)) {
    walkObject(builder, base, next);
  } else {
    emit(builder, setOp(builder, next));
    return;
  }
  collapse(builder, start, next);
}

function walkArray(builder: Builder, base: unknown[], next: unknown[]): void {
  if (next.length < base.length) {
    emit(builder, { op: "truncate", path: builder.path.slice(), length: next.length });
  }
  const common = Math.min(base.length, next.length);
  for (let i = 0; i < common; i++) {
    builder.path.push(i);
    walk(builder, base[i], next[i]);
    builder.path.pop();
  }
  if (next.length > base.length) {
    emit(builder, { op: "push", path: builder.path.slice(), items: next.slice(base.length) });
  }
}

function keepsOrder(base: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const kept = Object.keys(base).filter((key) => base[key] !== undefined && present(next, key));
  const added = Object.keys(next).filter((key) => next[key] !== undefined && !present(base, key));
  const rebuilt = Object.keys(Object.fromEntries([...kept, ...added].map((key) => [key, true])));
  const wanted = Object.keys(next).filter((key) => next[key] !== undefined);
  return rebuilt.length === wanted.length && rebuilt.every((key, index) => key === wanted[index]);
}

function walkObject(builder: Builder, base: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(base)) {
    if (base[key] !== undefined && !present(next, key)) {
      builder.path.push(key);
      emit(builder, { op: "delete", path: builder.path.slice() });
      builder.path.pop();
    }
  }
  for (const key of Object.keys(next)) {
    const value = next[key];
    if (value === undefined) {
      continue;
    }
    builder.path.push(key);
    if (present(base, key)) {
      walk(builder, base[key], value);
    } else {
      emit(builder, setOp(builder, value));
    }
    builder.path.pop();
  }
}

function collapse(builder: Builder, start: number, next: unknown): void {
  if (builder.ops.length === start) {
    return;
  }
  let changes = 0;
  for (let i = start; i < builder.sizes.length; i++) {
    changes += builder.sizes[i] as number;
  }
  const overhead = JSON.stringify(setOp(builder, null)).length - 4;
  const size = overhead + jsonLength(next, changes - overhead);
  if (size < changes) {
    builder.ops.length = start;
    builder.sizes.length = start;
    builder.ops.push(setOp(builder, next));
    builder.sizes.push(size);
  }
}

function jsonLength(value: unknown, limit: number): number {
  if (limit < 0) {
    return limit + 1;
  }
  if (typeof value === "string") {
    return value.length + 2 > limit ? limit + 1 : JSON.stringify(value).length;
  }
  if (Array.isArray(value)) {
    let total = 1 + Math.max(value.length, 1);
    for (const item of value) {
      if (total > limit) {
        return total;
      }
      total += jsonLength(item ?? null, limit - total);
    }
    return total;
  }
  if (isRecord(value)) {
    let total = 1;
    let fields = 0;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined) {
        continue;
      }
      if (total > limit) {
        return total;
      }
      fields++;
      total += jsonLength(key, limit - total) + 1;
      total += jsonLength(item, limit - total);
    }
    return total + Math.max(fields, 1);
  }
  return String(JSON.stringify(value)).length;
}

class Misfit extends Error {}

function parseOp(raw: unknown): JsonDeltaOp | string {
  if (!isRecord(raw)) {
    return "is not an object";
  }
  const field = (name: string) => (Object.hasOwn(raw, name) ? raw[name] : undefined);
  const path = field("path");
  if (!Array.isArray(path)) {
    return "has no path list";
  }
  for (const key of path) {
    if (typeof key !== "string" && !(Number.isSafeInteger(key) && (key as number) >= 0)) {
      return "has a path with something other than texts and whole numbers from 0";
    }
  }
  const keys = path as JsonPath;
  switch (field("op")) {
    case "set":
      return Object.hasOwn(raw, "value") && raw["value"] !== undefined ? { op: "set", path: keys, value: raw["value"] } : "sets no value";
    case "delete":
      return keys.length > 0 ? { op: "delete", path: keys } : "deletes the whole value";
    case "append": {
      const text = field("text");
      return typeof text === "string" ? { op: "append", path: keys, text } : "appends no text";
    }
    case "push": {
      const items = field("items");
      return Array.isArray(items) ? { op: "push", path: keys, items } : "pushes no items list";
    }
    case "truncate": {
      const length = field("length");
      return Number.isSafeInteger(length) && (length as number) >= 0 ? { op: "truncate", path: keys, length: length as number } : "truncates to no valid length";
    }
    default:
      return `has the unknown op ${JSON.stringify(field("op"))}`;
  }
}

function isContainer(value: unknown): value is Container {
  return value !== null && typeof value === "object";
}

function define(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

function writable(node: Container, fresh: Set<object>): Container {
  if (fresh.has(node)) {
    return node;
  }
  let copy: Container;
  if (Array.isArray(node)) {
    copy = node.slice();
  } else {
    copy = (Object.getPrototypeOf(node) === null ? Object.create(null) : {}) as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      define(copy, key, node[key]);
    }
  }
  fresh.add(copy);
  return copy;
}

function where(path: JsonPath, length: number): string {
  return JSON.stringify(path.slice(0, length));
}

function read(parent: Container, key: string | number, path: JsonPath, depth: number): unknown {
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key >= parent.length) {
      throw new Misfit(`${where(path, depth)} is not an element of the list`);
    }
    return parent[key];
  }
  if (typeof key !== "string" || !Object.hasOwn(parent, key)) {
    throw new Misfit(`${where(path, depth)} is not a field of the object`);
  }
  return parent[key];
}

function write(parent: Container, key: string | number, value: unknown): void {
  if (Array.isArray(parent)) {
    parent[key as number] = value;
  } else {
    define(parent, key as string, value);
  }
}

function changed(current: unknown, op: JsonDeltaOp, fresh: Set<object>, path: JsonPath): unknown {
  switch (op.op) {
    case "set":
      return op.value;
    case "append":
      if (typeof current !== "string") {
        throw new Misfit(`${where(path, path.length)} is not a text`);
      }
      return current + op.text;
    case "push": {
      if (!Array.isArray(current)) {
        throw new Misfit(`${where(path, path.length)} is not a list`);
      }
      const copy = writable(current, fresh) as unknown[];
      for (const item of op.items) {
        copy.push(item);
      }
      return copy;
    }
    case "truncate": {
      if (!Array.isArray(current) || op.length >= current.length) {
        throw new Misfit(`${where(path, path.length)} is not a list longer than ${op.length}`);
      }
      const copy = writable(current, fresh) as unknown[];
      copy.length = op.length;
      return copy;
    }
    case "delete":
      throw new Misfit("the whole value cannot be deleted");
  }
}

function applyOp(root: unknown, op: JsonDeltaOp, fresh: Set<object>): unknown {
  const path = op.path;
  if (path.length === 0) {
    return changed(root, op, fresh, path);
  }
  if (!isContainer(root)) {
    throw new Misfit("the value is neither an object nor a list");
  }
  const top = writable(root, fresh);
  let parent = top;
  for (let depth = 1; depth < path.length; depth++) {
    const key = path[depth - 1] as string | number;
    const child = read(parent, key, path, depth);
    if (!isContainer(child)) {
      throw new Misfit(`${where(path, depth)} is neither an object nor a list`);
    }
    const copy = writable(child, fresh);
    if (copy !== child) {
      write(parent, key, copy);
    }
    parent = copy;
  }
  const last = path[path.length - 1] as string | number;
  if (op.op === "set") {
    if (Array.isArray(parent) ? typeof last !== "number" || last >= parent.length : typeof last !== "string") {
      throw new Misfit(`${where(path, path.length)} cannot be set`);
    }
    write(parent, last, op.value);
  } else if (op.op === "delete") {
    read(parent, last, path, path.length);
    if (Array.isArray(parent)) {
      throw new Misfit(`${where(path, path.length)} is in a list, lists are truncated`);
    }
    delete parent[last as string];
  } else {
    write(parent, last, changed(read(parent, last, path, path.length), op, fresh, path));
  }
  return top;
}
