export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface JsonProblem {
  path: string;
  reason: string;
}

export const maxStateDepth = 100;

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), toBareObject) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

type Visit = { kind: "visit"; value: unknown; path: string; depth: number };
type Leave = { kind: "leave"; value: object };
type Child = { value: unknown; path: string };

export function findNonJson(value: unknown, path: string, maxDepth = maxStateDepth): JsonProblem | undefined {
  const ancestors = new Set<object>();
  const stack: (Visit | Leave)[] = [{ kind: "visit", value, path, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as Visit | Leave;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }
    const leafProblem = describeLeaf(frame.value, frame.path);
    if (leafProblem !== undefined) {
      return leafProblem;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (ancestors.has(current)) {
      return { path: frame.path, reason: "refers to itself (circular reference)" };
    }
    if (frame.depth >= maxDepth) {
      return { path: frame.path, reason: `is nested deeper than ${maxDepth} levels` };
    }
    const children = Array.isArray(current) ? arrayChildren(current, frame.path) : objectChildren(current, frame.path);
    if (!Array.isArray(children)) {
      return children;
    }
    ancestors.add(current);
    stack.push({ kind: "leave", value: current });
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i] as Child;
      stack.push({ kind: "visit", value: child.value, path: child.path, depth: frame.depth + 1 });
    }
  }
  return undefined;
}

function describeLeaf(value: unknown, path: string): JsonProblem | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value) ? undefined : { path, reason: `is ${value}, only finite numbers are allowed` };
    case "undefined":
      return { path, reason: "is undefined, use null instead or leave the field out" };
    case "object": {
      if (value === null || Array.isArray(value)) {
        return undefined;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        return undefined;
      }
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      return { path, reason: `is a ${name}, only plain objects, arrays and primitive values are allowed` };
    }
    default:
      return { path, reason: `is of type ${typeof value}, only JSON values are allowed` };
  }
}

function arrayChildren(array: unknown[], path: string): Child[] | JsonProblem {
  for (const key of Object.keys(array)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      return { path: `${path}.${key}`, reason: "is an extra property on an array, arrays may only contain elements" };
    }
  }
  const children: Child[] = [];
  for (let i = 0; i < array.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, i);
    if (descriptor === undefined) {
      return { path: `${path}[${i}]`, reason: "is a hole in the array, use null instead" };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { path: `${path}[${i}]`, reason: "is a getter or setter property, only plain values are allowed" };
    }
    children.push({ value: descriptor.value, path: `${path}[${i}]` });
  }
  return children;
}

function objectChildren(object: object, path: string): Child[] | JsonProblem {
  const children: Child[] = [];
  for (const key of Object.keys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key) as PropertyDescriptor;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { path: `${path}.${key}`, reason: "is a getter or setter property, only plain values are allowed" };
    }
    if (descriptor.value !== undefined) {
      children.push({ value: descriptor.value, path: `${path}.${key}` });
    }
  }
  return children;
}

function toBareObject(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.assign(Object.create(null) as object, value);
  }
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
