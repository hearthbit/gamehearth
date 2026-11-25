import { parentPort, workerData } from "node:worker_threads";
import type { Expected } from "../sandbox/outcome";
import { Sandbox, workerStackSizeBytes, type GuestFunction, type SandboxResult } from "../sandbox/sandbox";

export type DevWorkerRequest =
  | { id: number; kind: "load"; code: string; catalog?: string }
  | { id: number; kind: "call"; fn: GuestFunction; input: string; expected: Expected };

export type DevWorkerReply = { id: number; loaded: { ok: true } | { ok: false; message: string } } | { id: number; result: SandboxResult };

export interface DevWorkerSetup {
  guestRunner: string;
  wasm: WebAssembly.Module;
}

const port = parentPort;
if (port === null) {
  throw new Error("The sandbox worker of dev only runs as a worker thread");
}

const setup = workerData as DevWorkerSetup;
let code: string | undefined;
let catalog: string | undefined;
let sandbox: Sandbox | undefined;

function create(source: string, profiles: string | undefined): Promise<Sandbox> {
  return Sandbox.create(setup.guestRunner, source, { maxStackSizeBytes: workerStackSizeBytes, wasm: setup.wasm }, profiles);
}

async function fresh(): Promise<Sandbox> {
  sandbox?.dispose();
  sandbox = undefined;
  if (code === undefined) {
    throw new Error("No game is loaded yet");
  }
  sandbox = await create(code, catalog);
  return sandbox;
}

async function handle(request: DevWorkerRequest): Promise<DevWorkerReply> {
  if (request.kind === "load") {
    try {
      const next = await create(request.code, request.catalog);
      sandbox?.dispose();
      sandbox = next;
      code = request.code;
      catalog = request.catalog;
      return { id: request.id, loaded: { ok: true } };
    } catch (error) {
      return { id: request.id, loaded: { ok: false, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  try {
    const current = sandbox === undefined || sandbox.tainted !== undefined ? await fresh() : sandbox;
    return { id: request.id, result: current.run(request.fn, request.input, request.expected) };
  } catch (error) {
    return { id: request.id, result: { ok: false, failure: { kind: "error", message: error instanceof Error ? error.message : String(error) } } };
  }
}

port.on("message", (request: DevWorkerRequest) => {
  void handle(request).then((reply) => port.postMessage(reply));
});
