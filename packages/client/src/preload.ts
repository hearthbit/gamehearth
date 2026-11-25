export const preloadPath = "/preload/1";
export const preloadTimeoutMs = 60_000;
export const checkTimeoutMs = 15_000;
export const preloadReadyMs = 8000;

export interface PreloadResult {
  total: number;
  failed: string[];
}

export interface PreloadFrame {
  postMessage(message: unknown, target: string): void;
}

export interface PreloadDom {
  createFrame(src: string): { window: () => PreloadFrame | null; remove: () => void };
  listen(listener: (event: { source: unknown; data: unknown }) => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserDom(): PreloadDom {
  return {
    createFrame(src) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.className = "preload-frame";
      frame.src = src;
      document.body.append(frame);
      return { window: () => frame.contentWindow, remove: () => frame.remove() };
    },
    listen(listener) {
      const wrapped = (event: MessageEvent) => listener({ source: event.source, data: event.data });
      addEventListener("message", wrapped);
      return () => removeEventListener("message", wrapped);
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

let nextId = 1;

export function preloadFiles(urls: readonly string[], dom: PreloadDom = browserDom(), totalMs = preloadTimeoutMs): Promise<PreloadResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    const frame = dom.createFrame(preloadPath);
    let started = false;
    let done = false;
    const finish = (result: PreloadResult) => {
      if (done) {
        return;
      }
      done = true;
      dom.clearTimeout(readyTimer);
      dom.clearTimeout(totalTimer);
      stop();
      frame.remove();
      resolve(result);
    };
    const giveUp = () => finish({ total: urls.length, failed: [...urls] });
    const readyTimer = dom.setTimeout(() => !started && giveUp(), preloadReadyMs);
    const totalTimer = dom.setTimeout(giveUp, totalMs);
    const stop = dom.listen((event) => {
      const target = frame.window();
      if (target === null || event.source !== target) {
        return;
      }
      const data = event.data as Record<string, unknown> | null;
      if (data === null || typeof data !== "object" || data["gamehearth"] !== 1) {
        return;
      }
      if (data["type"] === "preload-ready" && !started) {
        started = true;
        target.postMessage({ gamehearth: 1, type: "preload", id, urls: [...urls] }, "*");
        return;
      }
      if (data["type"] === "preloaded" && data["id"] === id) {
        const failed = Array.isArray(data["failed"]) ? data["failed"].filter((url): url is string => typeof url === "string" && urls.includes(url)) : [...urls];
        finish({ total: urls.length, failed });
      }
    });
  });
}

export function buildUrls(client: string, files: readonly string[]): string[] {
  const base = new URL(client, "http://gamehearth.invalid");
  return [client, ...files.map((file) => new URL(file, base).pathname)];
}
