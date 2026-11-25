const globals = globalThis as Record<string, unknown>;

const randomReason = "Randomness comes from ctx.random, the time from ctx.now; only then can every match be repeated exactly.";
const zoneReason = "The result depends on the time zone of the computer; use the UTC methods such as getUTCHours() and Date.UTC(...) instead.";
const codeReason = "Games do not build code from text.";

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

function forbidden(call: string, reason: string): () => never {
  return () => {
    throw new Error(`${call} is not allowed in games. ${reason}`);
  };
}

function lock(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: false, enumerable: false, configurable: false });
}

lock(Math, "random", forbidden("Math.random()", randomReason));

const RealDate = Date;
lock(RealDate, "now", forbidden("Date.now()", randomReason));
lock(RealDate, "parse", forbidden("Date.parse()", zoneReason));
for (const name of localDateMethods) {
  lock(RealDate.prototype, name, forbidden(`Date.prototype.${name}()`, zoneReason));
}
const SafeDate = new Proxy(RealDate, {
  apply: forbidden("Date()", randomReason),
  construct(target, args, newTarget) {
    if (args.length === 0) {
      forbidden("new Date() without an argument", randomReason)();
    }
    if (args.length > 1 || typeof args[0] !== "number") {
      forbidden("new Date(...) with text or several arguments", zoneReason)();
    }
    return Reflect.construct(target, args, newTarget) as object;
  },
});
lock(globals, "Date", SafeDate);
lock(RealDate.prototype, "constructor", SafeDate);

function safeConstructor(prototype: object): () => never {
  const safe = function () {
    forbidden("The Function constructor", codeReason)();
  } as unknown as () => never;
  Object.defineProperty(safe, "prototype", { value: prototype, writable: false, enumerable: false, configurable: false });
  return safe;
}

for (const sample of [function () {}, function* () {}, async function () {}, async function* () {}]) {
  const prototype = Object.getPrototypeOf(sample) as object;
  const safe = safeConstructor(prototype);
  lock(prototype, "constructor", safe);
  if (prototype === Function.prototype) {
    lock(globals, "Function", safe);
  }
}
lock(globals, "eval", forbidden("eval()", codeReason));

for (const name of ["WeakRef", "FinalizationRegistry", "performance"]) {
  delete globals[name];
}
