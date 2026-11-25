type Level = "log" | "info" | "warn" | "error";

const limit = 4000;

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function post(level: Level, text: string, stack?: string): void {
  try {
    parent.postMessage({ gamehearthDev: 1, type: "log", level, text: text.slice(0, limit), stack: stack?.slice(0, limit * 2) }, "*");
  } catch {
    return;
  }
}

addEventListener("error", (event) => {
  const error = (event as ErrorEvent).error as unknown;
  post("error", (event as ErrorEvent).message || describe(error), error instanceof Error ? error.stack : undefined);
});

addEventListener("unhandledrejection", (event) => {
  const reason = (event as PromiseRejectionEvent).reason as unknown;
  post("error", `Uncaught error in a promise: ${describe(reason)}`, reason instanceof Error ? reason.stack : undefined);
});

for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const error = args.find((arg): arg is Error => arg instanceof Error);
    post(level, args.map(describe).join(" "), error?.stack);
  };
}
