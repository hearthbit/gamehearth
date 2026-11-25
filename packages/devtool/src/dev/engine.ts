import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { devtoolSource } from "../bundle";
import type { Expected } from "../sandbox/outcome";
import { buildGuestRunner } from "../sandbox/build";
import { compiledQuickJs, type GuestFunction, type SandboxResult } from "../sandbox/sandbox";
import type { DevWorkerReply, DevWorkerRequest, DevWorkerSetup } from "./sandbox-worker";

export const hardLimitMs = 2000;
export const loadLimitMs = 5000;

type Pending = { resolve: (reply: DevWorkerReply) => void; timer: NodeJS.Timeout };
type Request = DevWorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

export const workerCachePrefix = "gamehearth-dev-cache-";

async function cachedWorkerFile(): Promise<string> {
  const result = await build({
    entryPoints: [devtoolSource(join("dev", "sandbox-worker.ts"))],
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    banner: { js: "import { createRequire as __gamehearthRequire } from 'node:module'; const require = __gamehearthRequire(import.meta.url);" },
  });
  const code = result.outputFiles[0]?.text ?? "";
  const dir = join(tmpdir(), `${workerCachePrefix}${createHash("sha256").update(code).digest("hex").slice(0, 16)}`);
  const file = join(dir, "sandbox-worker.mjs");
  if (existsSync(file) && (await readFile(file, "utf8")) === code) {
    return file;
  }
  await mkdir(dir, { recursive: true });
  const partial = `${file}.${process.pid}.${Date.now()}`;
  await writeFile(partial, code, "utf8");
  try {
    await rename(partial, file);
  } catch {
    await rm(partial, { force: true });
  }
  return file;
}

export class DevEngine {
  readonly #workerFile: string;
  readonly #setup: DevWorkerSetup;
  readonly #limitMs: number;
  #worker: Worker | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #code: string | undefined;
  #catalog: string | undefined;
  #closed = false;

  private constructor(workerFile: string, setup: DevWorkerSetup, limitMs: number) {
    this.#workerFile = workerFile;
    this.#setup = setup;
    this.#limitMs = limitMs;
  }

  static async start(options: { limitMs?: number } = {}): Promise<DevEngine> {
    const workerFile = await cachedWorkerFile();
    const setup: DevWorkerSetup = { guestRunner: await buildGuestRunner(), wasm: compiledQuickJs() };
    return new DevEngine(workerFile, setup, options.limitMs ?? hardLimitMs);
  }

  async load(code: string, catalog?: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const reply = await this.#send(catalog === undefined ? { kind: "load", code } : { kind: "load", code, catalog }, loadLimitMs);
    const loaded = "loaded" in reply ? reply.loaded : { ok: false as const, message: reply.result.ok ? "unexpected reply while loading" : reply.result.failure.message };
    if (loaded.ok) {
      this.#code = code;
      this.#catalog = catalog;
    }
    return loaded;
  }

  async call(fn: GuestFunction, input: string, expected: Expected): Promise<SandboxResult> {
    const reply = await this.#send({ kind: "call", fn, input, expected }, this.#limitMs);
    if ("result" in reply) {
      return reply.result;
    }
    return { ok: false, failure: { kind: "error", message: reply.loaded.ok ? "unexpected reply" : reply.loaded.message } };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#worker?.terminate();
    this.#worker = undefined;
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) {
      return this.#worker;
    }
    const worker = new Worker(this.#workerFile, { workerData: this.#setup, resourceLimits: { stackSizeMb: 4 } });
    worker.on("message", (reply: DevWorkerReply) => {
      const pending = this.#pending.get(reply.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(reply.id);
        pending.resolve(reply);
      }
    });
    worker.on("error", (error) => this.#fail(worker, `The sandbox worker crashed: ${error.message}`));
    worker.on("exit", () => this.#fail(worker, "The sandbox worker exited"));
    worker.unref();
    this.#worker = worker;
    if (this.#code !== undefined) {
      void this.#send(this.#catalog === undefined ? { kind: "load", code: this.#code } : { kind: "load", code: this.#code, catalog: this.#catalog }, loadLimitMs);
    }
    return worker;
  }

  #send(request: Request, limitMs: number): Promise<DevWorkerReply> {
    if (this.#closed) {
      return Promise.resolve({ id: 0, result: { ok: false, failure: { kind: "error", message: "dev is shutting down" } } });
    }
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#restart(worker);
        resolve({
          id,
          result: {
            ok: false,
            failure: {
              kind: "timeout",
              message: `The game code did not respond after ${limitMs} ms and was aborted. Usually this is an endless loop or a very expensive computation (e.g. sort on a huge list). On the server, the limit is 100 ms per move.`,
            },
          },
        });
      }, limitMs);
      this.#pending.set(id, { resolve, timer });
      worker.postMessage({ ...request, id } as DevWorkerRequest);
    });
  }

  #restart(worker: Worker): void {
    if (this.#worker !== worker) {
      return;
    }
    this.#worker = undefined;
    void worker.terminate();
  }

  #fail(worker: Worker, message: string): void {
    if (this.#worker !== worker) {
      return;
    }
    this.#worker = undefined;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id, result: { ok: false, failure: { kind: "crash", message } } });
    }
    this.#pending.clear();
  }
}
