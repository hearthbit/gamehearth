import { build, type Plugin } from "esbuild";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const gameEntry = join("src", "index.ts");

export async function verifyGameBuild(gameDir: string): Promise<void> {
  await build({
    entryPoints: [entryOf(gameDir)],
    plugins: [confine(gameDir)],
    write: false,
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
}

export async function bundleGameModule(gameDir: string): Promise<string> {
  const absolute = resolve(gameDir);
  const result = await build({
    entryPoints: [entryOf(absolute)],
    absWorkingDir: absolute,
    plugins: [confine(absolute)],
    write: false,
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild produced no output");
  }
  return output.text;
}

export interface DevBundle {
  code: string;
  map: string;
}

export async function bundleGameForDev(gameDir: string): Promise<DevBundle> {
  const absolute = resolve(gameDir);
  const result = await build({
    entryPoints: [entryOf(absolute)],
    absWorkingDir: absolute,
    plugins: [confine(absolute)],
    outfile: join(absolute, "game.mjs"),
    write: false,
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    sourcemap: "external",
    sourcesContent: false,
    logLevel: "silent",
  });
  const code = result.outputFiles.find((file) => file.path.endsWith(".mjs"));
  const map = result.outputFiles.find((file) => file.path.endsWith(".map"));
  if (code === undefined || map === undefined) {
    throw new Error("esbuild produced no output");
  }
  return { code: code.text, map: map.text };
}

export async function buildWorker(gameDir: string, outfile: string): Promise<void> {
  const contents = [
    `import ${JSON.stringify(devtoolSource("guards.ts"))};`,
    `import game from ${JSON.stringify(entryOf(gameDir))};`,
    `import { startWorker } from ${JSON.stringify(devtoolSource("worker.ts"))};`,
    "startWorker(game);",
  ].join("\n");
  await build({
    stdin: { contents, resolveDir: gameDir, loader: "ts", sourcefile: "gamehearth-check.ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    sourcesContent: false,
    logLevel: "silent",
  });
}

const confined = Symbol("gamehearth-confined");

function confine(gameDir: string): Plugin {
  const roots = [realpathSync(resolve(gameDir)), sdkRoot()];
  return {
    name: "gamehearth-confine",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || (args.pluginData as Record<symbol, boolean> | undefined)?.[confined] === true) {
          return undefined;
        }
        const resolved = await builder.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { [confined]: true },
        });
        if (resolved.errors.length > 0 || resolved.external || resolved.path === "") {
          return resolved;
        }
        if (!roots.some((root) => inside(root, resolved.path))) {
          return {
            errors: [
              {
                text: `${args.path} is outside the game folder. A game may only import files from its own folder and the SDK (@gamehearth/sdk).`,
              },
            ],
          };
        }
        return resolved;
      });
      builder.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        if (roots.some((root) => inside(root, args.path))) {
          return undefined;
        }
        return {
          errors: [
            {
              text: `${args.path} is outside the game folder. A game may only import files from its own folder and the SDK (@gamehearth/sdk).`,
            },
          ],
        };
      });
    },
  };
}

function inside(root: string, file: string): boolean {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  const path = relative(root, real);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

let sdk: string | undefined;

function sdkRoot(): string {
  if (sdk === undefined) {
    let dir = dirname(realpathSync(createRequire(import.meta.url).resolve("@gamehearth/sdk")));
    while (!existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error("The package @gamehearth/sdk was not found");
      }
      dir = parent;
    }
    sdk = dir;
  }
  return sdk;
}

function entryOf(gameDir: string): string {
  const entry = join(gameDir, gameEntry);
  if (!existsSync(entry)) {
    throw new Error(`${gameEntry} is missing. A game exports its defineGame(...) as default from ${gameEntry}.`);
  }
  return entry;
}

export function devtoolSource(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, file), join(here, "..", "src", file)]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${file} was not found next to ${here}`);
}
