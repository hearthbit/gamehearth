import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { checkOutcome, type Expected, type GuestOutcome } from "./outcome";

export type GuestFunction = "createMatch" | "applyMove" | "stepMatch" | "refreshMatch" | "botMove";

export const guestFunctions: readonly GuestFunction[] = ["createMatch", "applyMove", "stepMatch", "refreshMatch", "botMove"];

export type FailureKind = "timeout" | "memory" | "crash" | "invalid" | "error";

export interface SandboxFailure {
  kind: FailureKind;
  message: string;
  stack?: string;
}

export type SandboxResult = { ok: true; outcome: GuestOutcome; json: string } | { ok: false; failure: SandboxFailure };

export interface SandboxOptions {
  callTimeoutMs: number;
  loadTimeoutMs: number;
  memoryHeadroomMb: number;
  recycleAboveMb: number;
  maxStackSizeBytes: number;
  maxOutputChars: number;
  wasm?: WebAssembly.Module;
}

export const sandboxDefaults: SandboxOptions = {
  callTimeoutMs: 100,
  loadTimeoutMs: 1000,
  memoryHeadroomMb: 32,
  recycleAboveMb: 8,
  maxStackSizeBytes: 128 * 1024,
  maxOutputChars: 256 * 1024,
};

export const workerStackSizeBytes = 256 * 1024;

export class SandboxLoadError extends Error {}

const initialPages = 256;
const pageBytes = 65_536;
const describeBudgetMs = 20;
const maxErrorText = 2000;

interface WasmApi {
  Module: new (bytes: Uint8Array) => WebAssembly.Module;
  Memory: new (descriptor: { initial: number; maximum: number }) => object;
}

const wasmApi = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

let compiled: WebAssembly.Module | undefined;

export function compiledQuickJs(): WebAssembly.Module {
  if (compiled === undefined) {
    const file = createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
    compiled = new wasmApi.Module(readFileSync(file));
  }
  return compiled;
}

export interface GameFeatures {
  bot: boolean;
}

export class Sandbox {
  #features: GameFeatures = { bot: false };
  readonly #module: QuickJSWASMModule;
  readonly #runtime: QuickJSRuntime;
  readonly #context: QuickJSContext;
  readonly #options: SandboxOptions;
  readonly #functions = new Map<GuestFunction, QuickJSHandle>();
  readonly #helpers: QuickJSHandle[] = [];
  #install: QuickJSHandle | undefined;
  #isNull: QuickJSHandle | undefined;
  #deadline = Number.POSITIVE_INFINITY;
  #interrupted = false;
  #tainted: FailureKind | undefined;
  #disposed = false;

  private constructor(module: QuickJSWASMModule, options: SandboxOptions) {
    this.#module = module;
    this.#options = options;
    this.#runtime = module.newRuntime();
    this.#runtime.setMemoryLimit(-1);
    this.#runtime.setMaxStackSize(options.maxStackSizeBytes);
    this.#runtime.setInterruptHandler(() => {
      const over = performance.now() > this.#deadline;
      if (over) {
        this.#interrupted = true;
      }
      return over;
    });
    this.#context = this.#runtime.newContext();
  }

  static async create(guestRunner: string, gameCode: string, overrides: Partial<SandboxOptions> = {}, catalog?: string): Promise<Sandbox> {
    const options = { ...sandboxDefaults, ...overrides };
    const memory = new wasmApi.Memory({ initial: initialPages, maximum: initialPages + options.memoryHeadroomMb * 16 });
    const module = await newQuickJSWASMModuleFromVariant(
      newVariant(RELEASE_SYNC, { wasmModule: options.wasm ?? compiledQuickJs(), wasmMemory: memory as NonNullable<Parameters<typeof newVariant>[1]["wasmMemory"]> }),
    );
    const sandbox = new Sandbox(module, options);
    try {
      sandbox.#load(guestRunner, gameCode, catalog);
    } catch (error) {
      if (!(error instanceof SandboxLoadError)) {
        sandbox.#tainted = "crash";
      }
      sandbox.dispose();
      throw error instanceof SandboxLoadError ? error : new SandboxLoadError(`The game could not be loaded: ${describe(error)}`);
    }
    if (sandbox.#grown()) {
      sandbox.#tainted = "memory";
      sandbox.dispose();
      throw new SandboxLoadError(`The game already uses more than ${options.recycleAboveMb} MB while loading`);
    }
    return sandbox;
  }

  get features(): GameFeatures {
    return { ...this.#features };
  }

  get tainted(): FailureKind | undefined {
    return this.#tainted;
  }

  get memoryBytes(): number {
    return this.#module.getWasmMemory().buffer.byteLength;
  }

  run(name: GuestFunction, input: string, expected: Expected): SandboxResult {
    if (this.#disposed) {
      throw new Error("The sandbox is already disposed");
    }
    if (this.#tainted !== undefined || this.#grown()) {
      return { ok: false, failure: { kind: this.#tainted ?? "memory", message: "The sandbox must be set up anew" } };
    }
    const fn = this.#functions.get(name) as QuickJSHandle;
    const timeoutMs = this.#options.callTimeoutMs;
    let result: SandboxResult;
    try {
      const started = performance.now();
      const raw = this.#call(fn, input, timeoutMs);
      const elapsed = performance.now() - started;
      if (elapsed > timeoutMs && (raw.ok || raw.failure.kind !== "timeout")) {
        result = { ok: false, failure: { kind: "timeout", message: `The call took ${Math.round(elapsed)} ms, allowed are ${timeoutMs} ms` } };
      } else if (!raw.ok) {
        result = raw;
      } else {
        const checked = checkOutcome(raw.json, expected);
        result = checked.ok
          ? { ok: true, outcome: checked.outcome, json: JSON.stringify(checked.outcome) }
          : { ok: false, failure: { kind: "invalid", message: `The sandbox returned invalid output: ${checked.problem}` } };
      }
    } catch (error) {
      this.#deadline = Number.POSITIVE_INFINITY;
      this.#tainted = "crash";
      return { ok: false, failure: { kind: "crash", message: describe(error) } };
    }
    if (!result.ok && result.failure.kind !== "error") {
      this.#tainted = result.failure.kind;
    }
    if (this.#grown()) {
      this.#tainted = this.#tainted ?? "memory";
    }
    return result;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#tainted === "crash") {
      return;
    }
    try {
      for (const handle of [...this.#functions.values(), ...this.#helpers]) {
        if (handle.alive) {
          handle.dispose();
        }
      }
      this.#context.dispose();
      this.#runtime.dispose();
    } catch {
      this.#tainted = "crash";
    }
  }

  #call(fn: QuickJSHandle, input: string, timeoutMs: number): { ok: true; json: string } | { ok: false; failure: SandboxFailure } {
    const context = this.#context;
    const argument = context.newString(input);
    this.#interrupted = false;
    this.#deadline = performance.now() + timeoutMs;
    const result = context.callFunction(fn, context.undefined, argument);
    this.#deadline = Number.POSITIVE_INFINITY;
    argument.dispose();
    if (result.error !== undefined) {
      const failure = this.#interrupted
        ? { kind: "timeout" as const, message: `Time limit of ${timeoutMs} ms exceeded` }
        : this.#describe(result.error);
      if (result.error.alive) {
        result.error.dispose();
      }
      return { ok: false, failure };
    }
    const value = result.value;
    try {
      if (context.typeof(value) !== "string") {
        return { ok: false, failure: { kind: "invalid", message: "The guest function did not return a text" } };
      }
      const length = this.#length(value);
      if (length > this.#options.maxOutputChars) {
        return { ok: false, failure: { kind: "invalid", message: `The output has ${length} characters, allowed are ${this.#options.maxOutputChars}` } };
      }
      return { ok: true, json: context.getString(value) };
    } finally {
      value.dispose();
    }
  }

  #grown(): boolean {
    return this.memoryBytes > initialPages * pageBytes + this.#options.recycleAboveMb * 2 ** 20;
  }

  #load(guestRunner: string, gameCode: string, catalog: string | undefined): void {
    const context = this.#context;
    this.#interrupted = false;
    this.#deadline = performance.now() + this.#options.loadTimeoutMs;
    try {
      const runner = context.evalCode(guestRunner, "gamehearth-runner.js", { type: "global" });
      if (runner.error !== undefined) {
        throw new SandboxLoadError(`The runner could not be loaded: ${this.#loadFailure(runner.error).message}`);
      }
      runner.value.dispose();
      const api = context.getProp(context.global, "__gamehearth");
      this.#install = context.getProp(api, "install");
      this.#helpers.push(this.#install);
      for (const name of guestFunctions) {
        this.#functions.set(name, context.getProp(api, name));
      }
      api.dispose();
      const isNull = context.evalCode("(value) => value === null", "gamehearth-is-null.js", { type: "global" });
      if (isNull.error !== undefined) {
        throw new SandboxLoadError(`A helper function could not be created: ${this.#loadFailure(isNull.error).message}`);
      }
      this.#isNull = isNull.value;
      this.#helpers.push(isNull.value);
      const loaded = context.evalCode(gameCode, "game.mjs", { type: "module" });
      if (loaded.error !== undefined) {
        throw new SandboxLoadError(`The game could not be loaded: ${this.#loadFailure(loaded.error).message}`);
      }
      const exports = this.#settle(loaded.value);
      const game = context.getProp(exports, "default");
      exports.dispose();
      const catalogHandle = catalog === undefined ? context.undefined : context.newString(catalog);
      const installed = context.callFunction(this.#install, context.undefined, game, catalogHandle);
      game.dispose();
      if (catalog !== undefined) {
        catalogHandle.dispose();
      }
      if (installed.error !== undefined) {
        throw new SandboxLoadError(this.#loadFailure(installed.error).message.replace(/^Error: /, ""));
      }
      const features = context.typeof(installed.value) === "string" ? context.getString(installed.value) : "";
      installed.value.dispose();
      this.#features = { bot: features === "bot" };
    } finally {
      this.#deadline = Number.POSITIVE_INFINITY;
    }
  }

  #loadFailure(errorHandle: QuickJSHandle): SandboxFailure {
    const failure = this.#interrupted ? { kind: "timeout" as const, message: "Time limit exceeded while loading" } : this.#describe(errorHandle);
    if (errorHandle.alive) {
      errorHandle.dispose();
    }
    if (failure.kind !== "error") {
      this.#tainted = failure.kind;
    }
    return failure;
  }

  #settle(handle: QuickJSHandle): QuickJSHandle {
    const context = this.#context;
    if (!context.typeof(handle).startsWith("object")) {
      return handle;
    }
    const state = context.getPromiseState(handle);
    if (state.type === "fulfilled" && state.notAPromise) {
      return handle;
    }
    const jobs = this.#runtime.executePendingJobs();
    const jobFailure = jobs.error === undefined ? undefined : this.#loadFailure(jobs.error);
    if (jobs.error === undefined) {
      jobs.dispose();
    }
    const settled = context.getPromiseState(handle);
    handle.dispose();
    if (settled.type === "fulfilled") {
      return settled.value;
    }
    if (settled.type === "rejected") {
      throw new SandboxLoadError(`The game could not be loaded: ${this.#loadFailure(settled.error).message}`);
    }
    throw new SandboxLoadError(
      jobFailure === undefined
        ? "The game could not be loaded: top-level await is not supported"
        : `The game could not be loaded: ${jobFailure.message}`,
    );
  }

  #describe(errorHandle: QuickJSHandle): SandboxFailure {
    const context = this.#context;
    const previous = this.#deadline;
    this.#interrupted = false;
    this.#deadline = performance.now() + describeBudgetMs;
    try {
      const type = context.typeof(errorHandle);
      if (type === "string") {
        return { kind: "error", message: `Error: ${this.#copy(errorHandle)}` };
      }
      if (type !== "object" || this.#isNullValue(errorHandle)) {
        return { kind: "error", message: `Error: the game threw ${type === "object" ? "null" : `a value of type ${type}`}` };
      }
      const name = this.#read(errorHandle, "name") ?? "Error";
      const message = this.#read(errorHandle, "message") ?? "error without a message";
      const stack = this.#read(errorHandle, "stack");
      if (this.#interrupted) {
        return { kind: "timeout", message: "The error could not be read: time limit exceeded while reading" };
      }
      return stack === undefined ? { kind: "error", message: `${name}: ${message}` } : { kind: "error", message: `${name}: ${message}`, stack };
    } catch (error) {
      return { kind: "error", message: `The error could not be read: ${describe(error)}` };
    } finally {
      this.#deadline = previous;
    }
  }

  #isNullValue(handle: QuickJSHandle): boolean {
    if (this.#isNull === undefined) {
      return false;
    }
    const result = this.#context.callFunction(this.#isNull, this.#context.undefined, handle);
    if (result.error !== undefined) {
      result.error.dispose();
      return false;
    }
    const isNull = this.#context.typeof(result.value) === "boolean" && this.#context.dump(result.value) === true;
    result.value.dispose();
    return isNull;
  }

  #read(handle: QuickJSHandle, key: string): string | undefined {
    if (this.#interrupted) {
      return undefined;
    }
    const property = this.#context.getProp(handle, key);
    try {
      return this.#context.typeof(property) === "string" ? this.#copy(property) : undefined;
    } finally {
      property.dispose();
    }
  }

  #copy(handle: QuickJSHandle): string {
    const length = this.#length(handle);
    return length > maxErrorText ? `[text with ${length} characters not copied]` : this.#context.getString(handle);
  }

  #length(handle: QuickJSHandle): number {
    const lengthHandle = this.#context.getProp(handle, "length");
    const length = this.#context.getNumber(lengthHandle);
    lengthHandle.dispose();
    return length;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
