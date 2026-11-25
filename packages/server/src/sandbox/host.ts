import {
  buildGuestRunner,
  compiledQuickJs,
  devtoolRoot,
  type Expected,
  type FailureKind,
  type GameFeatures,
  type GuestFunction,
  type SandboxOptions,
  type SandboxResult,
} from "gamehearth";
import { build, type Plugin } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { heartbeat, monotonicMs, phases, type WorkerReply, type WorkerRequest, type WorkerSetup } from "./messages";

export interface HostFailure {
  kind: "quarantine" | "killed";
  message: string;
}

export type HostResult = SandboxResult | { ok: false; failure: HostFailure };

export interface QuarantinedBuild {
  build: string;
  since: number;
  reason: string;
  hardAborts: number;
  softAborts: number;
  windowMinutes: number;
}

export interface SandboxHostOptions {
  callHardLimitMs: number;
  loadHardLimitMs: number;
  quarantineAfter: number;
  softQuarantineAfter: number;
  abortWindowMs: number;
  idleMs: number;
  maxSandboxes: number;
  sandbox: Partial<SandboxOptions>;
  log: (message: string) => void;
}

export const sandboxHostDefaults: SandboxHostOptions = {
  callHardLimitMs: 500,
  loadHardLimitMs: 3000,
  quarantineAfter: 3,
  softQuarantineAfter: 10,
  abortWindowMs: 10 * 60 * 1000,
  idleMs: 10 * 60 * 1000,
  maxSandboxes: 64,
  sandbox: {},
  log: (message) => console.error(message),
};

type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
type Reply = WorkerReply["result"] | { ok: false; failure: HostFailure };

interface Pending {
  request: Request;
  resolve: (result: Reply) => void;
  retried: boolean;
}

const quickJsPackages = ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"];
const softKinds = new Set<FailureKind>(["timeout", "memory", "invalid", "crash"]);
const restartWindowMs = 10_000;
const restartsBeforeBackoff = 5;

interface WorkerScript {
  file: string;
  code: string;
}

let bundled: Promise<WorkerScript> | undefined;

function workerScript(): Promise<WorkerScript> {
  bundled ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-sandbox-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "sandbox-worker.mjs");
    const code = await bundleWorker();
    writeFileSync(file, code);
    return { file, code };
  })().catch((error: unknown) => {
    bundled = undefined;
    throw error;
  });
  return bundled;
}

export async function sandboxWorkerFile(): Promise<string> {
  return (await workerScript()).file;
}

export class SandboxHost {
  readonly #options: SandboxHostOptions;
  readonly #script: WorkerScript;
  readonly #guestRunner: string;
  readonly #wasm: WebAssembly.Module;
  readonly #builds = new Map<string, { code: string; catalog?: string }>();
  readonly #features = new Map<string, GameFeatures>();
  readonly #aborts = new Map<string, { hard: number[]; soft: number[] }>();
  readonly #blocked = new Map<string, Omit<QuarantinedBuild, "build">>();
  readonly #pending = new Map<number, Pending>();
  readonly #watchdog: NodeJS.Timeout;
  #current = new Int32Array(new SharedArrayBuffer(8));
  #startedAt = new Float64Array(new SharedArrayBuffer(8));
  #worker: Worker | undefined;
  #respawn: NodeJS.Timeout | undefined;
  #restartTimes: number[] = [];
  #next = 0;
  #closed = false;
  #restarts = 0;

  private constructor(options: SandboxHostOptions, script: WorkerScript, guestRunner: string, wasm: WebAssembly.Module) {
    this.#options = options;
    this.#script = script;
    this.#guestRunner = guestRunner;
    this.#wasm = wasm;
    this.#spawn();
    this.#watchdog = setInterval(() => this.#check(), 10);
    this.#watchdog.unref();
  }

  static async start(options: Partial<SandboxHostOptions> = {}): Promise<SandboxHost> {
    const [script, guestRunner] = await Promise.all([workerScript(), buildGuestRunner()]);
    return new SandboxHost({ ...sandboxHostDefaults, ...options }, script, guestRunner, compiledQuickJs());
  }

  get restarts(): number {
    return this.#restarts;
  }

  register(build: string, code: string, catalog?: string): void {
    const entry = catalog === undefined ? { code } : { code, catalog };
    this.#builds.set(build, entry);
    this.#post({ kind: "register", build, ...entry }, -1);
  }

  async verify(build: string, code: string, catalog?: string): Promise<string | undefined> {
    const entry = catalog === undefined ? { code } : { code, catalog };
    const result = await this.#send({ kind: "verify", build, ...entry });
    if (!result.ok) {
      return result.failure.message;
    }
    this.#builds.set(build, entry);
    if ("features" in result) {
      this.#features.set(build, result.features);
    }
    return undefined;
  }

  async features(build: string): Promise<GameFeatures> {
    const known = this.#features.get(build);
    if (known !== undefined) {
      return known;
    }
    if (!this.#builds.has(build) || this.quarantined(build)) {
      return { bot: false };
    }
    const result = await this.#send({ kind: "features", build });
    if (result.ok && "features" in result) {
      this.#features.set(build, result.features);
      return result.features;
    }
    return { bot: false };
  }

  quarantinedBuilds(): QuarantinedBuild[] {
    return [...this.#blocked].map(([build, entry]) => ({ build, ...entry }));
  }

  quarantined(build: string): boolean {
    if (this.#blocked.has(build)) {
      return true;
    }
    const aborts = this.#aborts.get(build);
    if (aborts === undefined) {
      return false;
    }
    const cutoff = monotonicMs() - this.#options.abortWindowMs;
    aborts.hard = aborts.hard.filter((time) => time >= cutoff);
    aborts.soft = aborts.soft.filter((time) => time >= cutoff);
    if (aborts.hard.length >= this.#options.quarantineAfter || aborts.soft.length >= this.#options.softQuarantineAfter) {
      const minutes = Math.round(this.#options.abortWindowMs / 60_000);
      this.#blocked.set(build, {
        since: Date.now(),
        reason: `${aborts.hard.length} hard and ${aborts.soft.length} soft aborts in ${minutes} minutes`,
        hardAborts: aborts.hard.length,
        softAborts: aborts.soft.length,
        windowMinutes: minutes,
      });
      this.#options.log(`[Sandbox] Build ${build} quarantined after ${aborts.hard.length} hard and ${aborts.soft.length} soft aborts in ${minutes} minutes`);
      return true;
    }
    return false;
  }

  async run(room: string, build: string, fn: GuestFunction, input: string, expected: Expected, options: { tolerate?: readonly FailureKind[] } = {}): Promise<HostResult> {
    if (this.quarantined(build)) {
      return { ok: false, failure: { kind: "quarantine", message: `The build ${build} is quarantined after repeated aborts` } };
    }
    if (!this.#builds.has(build)) {
      return { ok: false, failure: { kind: "error", message: `The build ${build} is not loaded` } };
    }
    const result = await this.#send({ kind: "call", room, build, fn, input, expected });
    if (!result.ok && softKinds.has(result.failure.kind as FailureKind) && !(options.tolerate ?? []).includes(result.failure.kind as FailureKind)) {
      this.#abort(build, "soft");
    }
    return "outcome" in result || !result.ok ? result : { ok: false, failure: { kind: "error", message: "unexpected answer from the sandbox worker" } };
  }

  forget(room: string): void {
    this.#post({ kind: "forget", room }, -1);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#watchdog);
    if (this.#respawn !== undefined) {
      clearTimeout(this.#respawn);
    }
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) {
      worker.removeAllListeners();
      await worker.terminate();
    }
    for (const pending of this.#pending.values()) {
      pending.resolve({ ok: false, failure: { kind: "killed", message: "The sandbox worker was stopped" } });
    }
    this.#pending.clear();
  }

  #abort(build: string, kind: "hard" | "soft"): void {
    const aborts = this.#aborts.get(build) ?? { hard: [], soft: [] };
    aborts[kind].push(monotonicMs());
    this.#aborts.set(build, aborts);
    this.quarantined(build);
  }

  #send(request: Request, retried = false, resolve?: (result: Reply) => void): Promise<Reply> {
    return new Promise((done) => {
      const answer = resolve ?? done;
      if (this.#closed || this.#worker === undefined) {
        answer({ ok: false, failure: { kind: "killed", message: this.#closed ? "The sandbox worker is stopped" : "The sandbox worker is restarting" } });
        if (resolve !== undefined) {
          done({ ok: true });
        }
        return;
      }
      const id = this.#next++;
      this.#pending.set(id, { request, retried, resolve: answer });
      this.#post(request, id);
      if (resolve !== undefined) {
        done({ ok: true });
      }
    });
  }

  #post(request: Request, id: number): void {
    if (!this.#closed && this.#worker !== undefined) {
      this.#worker.postMessage({ ...request, id });
    }
  }

  #spawn(): void {
    if (this.#closed) {
      return;
    }
    if (!existsSync(this.#script.file)) {
      mkdirSync(dirname(this.#script.file), { recursive: true });
      writeFileSync(this.#script.file, this.#script.code);
    }
    this.#current = new Int32Array(new SharedArrayBuffer(8));
    this.#startedAt = new Float64Array(new SharedArrayBuffer(8));
    Atomics.store(this.#current, heartbeat.request, -1);
    const setup: WorkerSetup = {
      guestRunner: this.#guestRunner,
      wasm: this.#wasm,
      current: this.#current,
      startedAt: this.#startedAt,
      idleMs: this.#options.idleMs,
      maxSandboxes: this.#options.maxSandboxes,
      sandbox: this.#options.sandbox,
    };
    const worker = new Worker(this.#script.file, { workerData: setup, resourceLimits: { stackSizeMb: 4 } });
    this.#worker = worker;
    const current = this.#current;
    const running = () => {
      const id = Atomics.load(current, heartbeat.request);
      return id < 0 ? undefined : id;
    };
    worker.on("message", (reply: WorkerReply) => {
      const pending = this.#pending.get(reply.id);
      if (pending !== undefined) {
        this.#pending.delete(reply.id);
        pending.resolve(reply.result);
      }
    });
    worker.on("error", (error) => this.#restart(running(), `the sandbox worker crashed (${error.message})`));
    worker.on("exit", () => this.#restart(running(), "the sandbox worker exited unexpectedly"));
    for (const [build, entry] of this.#builds) {
      this.#post({ kind: "register", build, ...entry }, -1);
    }
  }

  #check(): void {
    const id = Atomics.load(this.#current, heartbeat.request);
    const pending = id < 0 ? undefined : this.#pending.get(id);
    if (pending === undefined) {
      return;
    }
    const loading = Atomics.load(this.#current, heartbeat.phase) === phases.load;
    const limit = loading ? this.#options.loadHardLimitMs : this.#options.callHardLimitMs;
    if (monotonicMs() - (this.#startedAt[0] ?? 0) > limit) {
      this.#restart(id, `hard limit of ${limit} ms exceeded ${loading ? "while loading" : "during a call"}`);
    }
  }

  #restart(culprit: number | undefined, reason: string): void {
    if (this.#closed || this.#worker === undefined) {
      return;
    }
    this.#worker.removeAllListeners();
    void this.#worker.terminate();
    this.#worker = undefined;
    this.#restarts += 1;
    const now = monotonicMs();
    this.#restartTimes = [...this.#restartTimes.filter((time) => now - time < restartWindowMs), now];
    const waiting = [...this.#pending.entries()];
    this.#pending.clear();
    if (culprit === undefined || !waiting.some(([id]) => id === culprit)) {
      this.#options.log(`[Sandbox] ${reason}; worker restarted`);
    }
    const backoff = this.#restartTimes.length > restartsBeforeBackoff;
    if (backoff) {
      const delay = Math.min(30_000, 250 * 2 ** (this.#restartTimes.length - restartsBeforeBackoff));
      this.#options.log(`[Sandbox] ${this.#restartTimes.length} restarts in ${restartWindowMs / 1000} s; next attempt in ${delay} ms`);
      this.#respawn = setTimeout(() => {
        this.#respawn = undefined;
        this.#spawn();
      }, delay);
    } else {
      this.#spawn();
    }
    for (const [id, pending] of waiting) {
      const build = "build" in pending.request ? pending.request.build : undefined;
      const room = "room" in pending.request ? pending.request.room : undefined;
      if (id === culprit) {
        this.#options.log(`[Sandbox] ${reason}; build ${build ?? "?"}, room ${room ?? "-"}; worker restarted`);
        if (build !== undefined) {
          this.#abort(build, "hard");
        }
        pending.resolve({ ok: false, failure: { kind: "killed", message: `${reason}, the call was aborted` } });
      } else if (pending.retried || backoff) {
        pending.resolve({ ok: false, failure: { kind: "killed", message: `aborted after a restart of the sandbox worker (${reason})` } });
      } else {
        void this.#send(pending.request, true, pending.resolve);
      }
    }
  }
}

function workerSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "worker.ts"), join(here, "..", "src", "sandbox", "worker.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`The source of the sandbox worker was not found next to ${here}`);
}

function quickJsExternals(): Plugin {
  const require = createRequire(join(devtoolRoot(), "package.json"));
  const entries = new Map(
    quickJsPackages.map((name) => {
      const module = require.resolve(name).replace(/\.js$/, ".mjs");
      if (!existsSync(module)) {
        throw new Error(`The ESM entry of ${name} is missing: ${module}`);
      }
      return [name, pathToFileURL(module).href];
    }),
  );
  return {
    name: "gamehearth-quickjs-externals",
    setup(builder) {
      builder.onResolve({ filter: /^(quickjs-emscripten-core|@jitl\/quickjs-wasmfile-release-sync)$/ }, (args) => ({
        path: entries.get(args.path) as string,
        external: true,
      }));
    },
  };
}

async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [workerSource()],
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [quickJsExternals()],
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild produced no worker script");
  }
  return output.text;
}
