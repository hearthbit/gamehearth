export interface PlayerCountSpec {
  min: number;
  max?: number;
  counts?: number[];
}

const specKeys = ["min", "max", "counts"];

export function validatePlayerCountSpec(spec: unknown): string[] {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return ['players must be an object like { "min": 2, "max": 6 }'];
  }
  const errors: string[] = [];
  for (const key of Object.keys(spec)) {
    if (!specKeys.includes(key)) {
      errors.push(`players.${key} is unknown, allowed are min, max and counts`);
    }
  }
  const { min, max, counts } = spec as Record<string, unknown>;
  const validMin = isWholeNumber(min) && min >= 1;
  if (!validMin) {
    errors.push("players.min must be an integer of at least 1");
  }
  if (max !== undefined) {
    if (!isWholeNumber(max)) {
      errors.push("players.max must be an integer");
    } else if (validMin && max < min) {
      errors.push("players.max must not be less than players.min");
    }
  }
  if (counts !== undefined) {
    if (!Array.isArray(counts)) {
      errors.push("players.counts must be a list of player counts");
    } else if (counts.length === 0) {
      errors.push("players.counts must not be empty; without a special case, leave the field out");
    } else {
      for (const count of counts) {
        const outside = !isWholeNumber(count) || (validMin && count < min) || (isWholeNumber(max) && count > max);
        if (outside) {
          errors.push(`players.counts contains ${JSON.stringify(count)}, which is not between min and max`);
        }
      }
    }
  }
  return errors;
}

export function isPlayerCountAllowed(spec: PlayerCountSpec, count: number, serverMax: number): boolean {
  assertServerMax(serverMax);
  const max = Math.min(spec.max ?? serverMax, serverMax);
  if (!Number.isInteger(count) || count < spec.min || count > max) {
    return false;
  }
  return spec.counts === undefined || spec.counts.includes(count);
}

export function allowedPlayerCounts(spec: PlayerCountSpec, serverMax: number): number[] {
  assertServerMax(serverMax);
  const max = Math.min(spec.max ?? serverMax, serverMax);
  const result: number[] = [];
  for (let count = spec.min; count <= max; count++) {
    if (isPlayerCountAllowed(spec, count, serverMax)) {
      result.push(count);
    }
  }
  return result;
}

function assertServerMax(serverMax: number): void {
  if (!Number.isSafeInteger(serverMax) || serverMax < 1) {
    throw new RangeError(`The server's maximum must be an integer of at least 1, got ${serverMax}`);
  }
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
