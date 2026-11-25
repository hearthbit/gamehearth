import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const maxClientBytes = 50 * 1024 * 1024;
export const maxClientFiles = 5000;
export const clientEntry = "index.html";

export interface ClientFile {
  path: string;
  size: number;
  sha256: string;
}

export type ClientInspection = { ok: true; dir: string; files: ClientFile[]; bytes: number } | { ok: false; problems: string[] };

export const safeSegment = /^[A-Za-z0-9._@+~-][A-Za-z0-9 ._@+~()-]*$/;

export function clientPathProblem(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    return 'client must be the folder with the built client, e.g. "dist/client"';
  }
  const segments = raw.replace(/\/+$/, "").split("/");
  if (isAbsolute(raw) || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `client must be a path inside the game folder with / as separator, got ${JSON.stringify(raw)}`;
  }
  return undefined;
}

export async function inspectClient(gameDir: string, clientPath: string): Promise<ClientInspection> {
  const pathProblem = clientPathProblem(clientPath);
  if (pathProblem !== undefined) {
    return { ok: false, problems: [pathProblem] };
  }
  const dir = join(gameDir, ...clientPath.replace(/\/+$/, "").split("/"));
  const missing = `The client folder ${clientPath} is missing. Build the UI first with npm run build (npm run check and npm run pack in the template do that themselves).`;
  let root: string;
  let gameRoot: string;
  try {
    const stats = await lstat(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { ok: false, problems: [stats.isSymbolicLink() ? `The client folder ${clientPath} must not be a symlink` : missing] };
    }
    root = await realpath(dir);
    gameRoot = await realpath(gameDir);
  } catch {
    return { ok: false, problems: [missing] };
  }
  const inside = relative(gameRoot, root);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return { ok: false, problems: [`The client folder ${clientPath} is not inside the game folder`] };
  }

  const problems: string[] = [];
  const files: ClientFile[] = [];
  let bytes = 0;
  const pending: string[] = [root];
  while (pending.length > 0 && problems.length === 0) {
    const current = pending.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (!safeSegment.test(entry.name)) {
        problems.push(`${clientPath}/${path}: file names may only contain letters, digits, spaces and ._@+~()-`);
        break;
      }
      if (entry.isSymbolicLink()) {
        problems.push(`${clientPath}/${path} is a symlink; the client may only contain real files and folders`);
        break;
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`${clientPath}/${path} is not a regular file`);
        break;
      }
      const content = await readFile(absolute);
      bytes += content.length;
      files.push({ path, size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
      if (files.length > maxClientFiles) {
        problems.push(`The client has more than ${maxClientFiles} files`);
        break;
      }
      if (bytes > maxClientBytes) {
        problems.push(`The client is larger than ${maxClientBytes / 1024 / 1024} MB`);
        break;
      }
    }
  }
  if (problems.length === 0 && !files.some((file) => file.path === clientEntry)) {
    problems.push(`The client folder ${clientPath} has no ${clientEntry}`);
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, dir: root, files, bytes };
}
