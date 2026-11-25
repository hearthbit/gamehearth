export class DownloadError extends Error {}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

const maxRedirects = 5;
const maxRedirectLength = 8192;
const redirects = new Set([301, 302, 303, 307, 308]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function downloadUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${JSON.stringify(raw)} is not a valid URL`;
  }
  if (raw.length > 500) {
    return "The URL is longer than 500 characters";
  }
  if (url.username !== "" || url.password !== "") {
    return "URLs with a username or password are not allowed";
  }
  if (url.protocol === "https:") {
    return undefined;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return undefined;
  }
  return `${url.origin} is not allowed; catalogs and packages only come over https (http only from localhost)`;
}

export async function download(url: string, options: DownloadOptions): Promise<Buffer> {
  const problem = downloadUrlProblem(url);
  if (problem !== undefined) {
    throw new DownloadError(problem);
  }
  const fetchFn = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let response: Response;
    try {
      response = await fetchFn(current, { redirect: "manual", signal, headers: { "user-agent": "gamehearth" } });
    } catch (error) {
      throw new DownloadError(signal.aborted ? `Timed out loading ${url}` : `${url} is not reachable: ${describe(error)}`);
    }
    if (redirects.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (location === null) {
        throw new DownloadError(`${url} redirects, but names no target`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new DownloadError(`${url} redirects to an invalid URL`);
      }
      const redirectProblem = redirectTargetProblem(next);
      if (redirectProblem !== undefined) {
        throw new DownloadError(`${url} redirects to ${next.origin}; ${redirectProblem}`);
      }
      current = next.href;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DownloadError(`${url} responds with ${response.status}${current === url ? "" : ` (after a redirect to ${new URL(current).origin})`}`);
    }
    return readLimited(response, url, options.maxBytes, signal);
  }
  throw new DownloadError(`${url} redirects more than ${maxRedirects} times`);
}

function redirectTargetProblem(next: URL): string | undefined {
  if (next.protocol !== "https:") {
    return "Redirects only go to https";
  }
  if (next.username !== "" || next.password !== "") {
    return "URLs with a username or password are not allowed";
  }
  if (next.href.length > maxRedirectLength) {
    return `the redirect is longer than ${maxRedirectLength} characters`;
  }
  return undefined;
}

async function readLimited(response: Response, url: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  const tooLarge = `${url} is larger than ${formatLimit(maxBytes)}`;
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new DownloadError(tooLarge);
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DownloadError(tooLarge);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof DownloadError) {
      throw error;
    }
    throw new DownloadError(signal.aborted ? `Timed out loading ${url}` : `Loading ${url} aborted: ${describe(error)}`);
  }
  return Buffer.concat(chunks);
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
