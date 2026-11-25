import { Sandbox, workerStackSizeBytes, type SandboxOptions, type SandboxResult } from "gamehearth/sandbox";
import { parentPort, workerData } from "node:worker_threads";
import { heartbeat, monotonicMs, phases, type WorkerReply, type WorkerRequest, type WorkerSetup } from "./messages";

const port = parentPort;
if (port === null) {
  throw new Error("The sandbox worker only runs as a worker thread");
}

const setup = workerData as WorkerSetup;
const options: Partial<SandboxOptions> = { maxStackSizeBytes: workerStackSizeBytes, ...setup.sandbox, wasm: setup.wasm };
const codes = new Map<string, { code: string; catalog?: string }>();
const rooms = new Map<string, { build: string; sandbox: Sandbox; used: number }>();

function enter(phase: number): void {
  setup.startedAt[0] = monotonicMs();
  Atomics.store(setup.current, heartbeat.phase, phase);
}

function failure(message: string): SandboxResult {
  return { ok: false, failure: { kind: "error", message } };
}

function loadFailure(message: string): SandboxResult {
  return { ok: false, failure: { kind: "invalid", message } };
}

function evictOldest(): void {
  let oldest: string | undefined;
  for (const [room, entry] of rooms) {
    if (oldest === undefined || entry.used < (rooms.get(oldest)?.used ?? Number.POSITIVE_INFINITY)) {
      oldest = room;
    }
  }
  if (oldest !== undefined) {
    rooms.get(oldest)?.sandbox.dispose();
    rooms.delete(oldest);
  }
}

async function create(build: string): Promise<Sandbox | SandboxResult> {
  const entry = codes.get(build);
  if (entry === undefined) {
    return failure(`The build ${build} is not known in the sandbox worker`);
  }
  const outer = Atomics.load(setup.current, heartbeat.phase);
  enter(phases.load);
  try {
    return await Sandbox.create(setup.guestRunner, entry.code, options, entry.catalog);
  } catch (error) {
    return loadFailure(error instanceof Error ? error.message : String(error));
  } finally {
    enter(outer);
  }
}

async function handle(request: WorkerRequest): Promise<WorkerReply["result"]> {
  switch (request.kind) {
    case "register":
      codes.set(request.build, request.catalog === undefined ? { code: request.code } : { code: request.code, catalog: request.catalog });
      return { ok: true };
    case "forget": {
      rooms.get(request.room)?.sandbox.dispose();
      rooms.delete(request.room);
      return { ok: true };
    }
    case "verify": {
      const known = codes.get(request.build);
      codes.set(request.build, request.catalog === undefined ? { code: request.code } : { code: request.code, catalog: request.catalog });
      const sandbox = await create(request.build);
      if (!(sandbox instanceof Sandbox)) {
        if (known === undefined) {
          codes.delete(request.build);
        } else {
          codes.set(request.build, known);
        }
        return sandbox;
      }
      const features = sandbox.features;
      sandbox.dispose();
      return { ok: true, features };
    }
    case "features": {
      for (const entry of rooms.values()) {
        if (entry.build === request.build) {
          return { ok: true, features: entry.sandbox.features };
        }
      }
      const sandbox = await create(request.build);
      if (!(sandbox instanceof Sandbox)) {
        return sandbox;
      }
      const features = sandbox.features;
      sandbox.dispose();
      return { ok: true, features };
    }
    case "call": {
      let entry = rooms.get(request.room);
      if (entry !== undefined && entry.build !== request.build) {
        entry.sandbox.dispose();
        rooms.delete(request.room);
        entry = undefined;
      }
      if (entry === undefined) {
        while (rooms.size >= setup.maxSandboxes) {
          evictOldest();
        }
        const sandbox = await create(request.build);
        if (!(sandbox instanceof Sandbox)) {
          return sandbox;
        }
        entry = { build: request.build, sandbox, used: 0 };
        rooms.set(request.room, entry);
      }
      entry.used = Date.now();
      const result = entry.sandbox.run(request.fn, request.input, request.expected);
      if (entry.sandbox.tainted !== undefined) {
        entry.sandbox.dispose();
        rooms.delete(request.room);
      }
      return result;
    }
  }
}

let queue = Promise.resolve();

port.on("message", (request: WorkerRequest) => {
  queue = queue.then(async () => {
    enter(request.kind === "verify" ? phases.load : phases.call);
    Atomics.store(setup.current, heartbeat.request, request.id);
    let result: WorkerReply["result"];
    try {
      result = await handle(request);
    } catch (error) {
      result = failure(`internal error in the sandbox worker: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      Atomics.store(setup.current, heartbeat.request, -1);
    }
    port.postMessage({ id: request.id, result } satisfies WorkerReply);
  });
});

const sweep = setInterval(() => {
  const cutoff = Date.now() - setup.idleMs;
  for (const [room, entry] of rooms) {
    if (entry.used < cutoff) {
      entry.sandbox.dispose();
      rooms.delete(room);
    }
  }
}, Math.max(1000, Math.min(60_000, setup.idleMs)));
sweep.unref();
