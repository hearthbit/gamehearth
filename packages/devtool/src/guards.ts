import { workerData } from "node:worker_threads";
import { forbiddenCalls, heartbeatSlots } from "./heartbeat";

process.setSourceMapsEnabled(true);

const heartbeat = (workerData as { heartbeat?: Int32Array } | undefined)?.heartbeat;

const randomReason = "Randomness comes from ctx.random, the time from ctx.now; only then can every match be repeated exactly.";
const zoneReason = "The result depends on the time zone of the computer; use the UTC methods such as getUTCHours() and Date.UTC(...) instead.";

function forbidden(call: (typeof forbiddenCalls)[number], label: string = call, reason = randomReason): Error {
  if (heartbeat !== undefined) {
    Atomics.store(heartbeat, heartbeatSlots.forbidden, forbiddenCalls.indexOf(call) + 1);
  }
  return new Error(`${label} is not allowed in games. ${reason}`);
}

const RealDate = Date;
const localDateMethods = [
  "getFullYear",
  "getYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getTimezoneOffset",
  "setFullYear",
  "setYear",
  "setMonth",
  "setDate",
  "setHours",
  "setMinutes",
  "setSeconds",
  "toString",
  "toDateString",
  "toTimeString",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
];

Math.random = () => {
  throw forbidden("Math.random()");
};

RealDate.now = () => {
  throw forbidden("Date.now()");
};

RealDate.parse = () => {
  throw forbidden("Date.parse()", "Date.parse()", zoneReason);
};

for (const name of localDateMethods) {
  Object.defineProperty(RealDate.prototype, name, {
    value: () => {
      throw forbidden("a date method with local time", `Date.prototype.${name}()`, zoneReason);
    },
    writable: true,
    configurable: true,
  });
}

globalThis.Date = new Proxy(RealDate, {
  apply() {
    throw forbidden("Date()");
  },
  construct(target, args, newTarget) {
    if (args.length === 0) {
      throw forbidden("new Date() without an argument");
    }
    if (args.length > 1 || typeof args[0] !== "number") {
      throw forbidden("new Date(...) with text or several arguments", "new Date(...) with text or several arguments", zoneReason);
    }
    return Reflect.construct(target, args, newTarget) as object;
  },
});

Object.defineProperty(RealDate.prototype, "constructor", { value: globalThis.Date, writable: true, configurable: true });

globalThis.performance.now = () => {
  throw forbidden("performance.now()");
};

globalThis.crypto.getRandomValues = () => {
  throw forbidden("crypto.getRandomValues()");
};

globalThis.crypto.randomUUID = () => {
  throw forbidden("crypto.randomUUID()");
};
