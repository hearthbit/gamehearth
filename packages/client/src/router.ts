import { useEffect, useState } from "preact/hooks";

export const adminTabs = ["games", "users", "rooms", "system"] as const;
export type AdminTab = (typeof adminTabs)[number];

export type Route =
  | { name: "home" }
  | { name: "room"; code: string }
  | { name: "invite" }
  | { name: "setup" }
  | { name: "reset" }
  | { name: "admin"; tab: AdminTab }
  | { name: "account" }
  | { name: "tv" }
  | { name: "pair" }
  | { name: "solo"; game: string }
  | { name: "game"; game: string };

const fixedRoutes: Record<string, Route> = {
  "/invite": { name: "invite" },
  "/setup": { name: "setup" },
  "/reset": { name: "reset" },
  "/account": { name: "account" },
  "/tv": { name: "tv" },
  "/pair": { name: "pair" },
};

export function parseRoute(pathname: string): Route {
  const fixed = fixedRoutes[pathname.replace(/\/+$/, "")];
  if (fixed !== undefined) {
    return fixed;
  }
  const admin = /^\/admin(?:\/([a-z]+))?\/?$/.exec(pathname);
  if (admin !== null) {
    const tab = adminTabs.find((candidate) => candidate === admin[1]);
    if (admin[1] === undefined || tab !== undefined) {
      return { name: "admin", tab: tab ?? "games" };
    }
  }
  const solo = /^\/play\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(pathname);
  if (solo?.[1] !== undefined) {
    return { name: "solo", game: solo[1] };
  }
  const page = /^\/game\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(pathname);
  if (page?.[1] !== undefined) {
    return { name: "game", game: page[1] };
  }
  const match = /^\/r\/([A-Za-z0-9]{1,12})\/?$/.exec(pathname);
  return match?.[1] === undefined ? { name: "home" } : { name: "room", code: match[1].toUpperCase() };
}

export function linkToken(hash: string): string {
  const token = hash.replace(/^#/, "");
  return /^[A-Za-z0-9_-]{1,100}$/.test(token) ? token : "";
}

export function soloPath(game: string): string {
  return `/play/${encodeURIComponent(game)}`;
}

export function gamePath(game: string): string {
  return `/game/${encodeURIComponent(game)}`;
}

export function adminPath(tab: AdminTab): string {
  return `/admin/${tab}`;
}

export function roomPath(code: string): string {
  return `/r/${encodeURIComponent(code)}`;
}

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname));
    listeners.add(update);
    addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      removeEventListener("popstate", update);
    };
  }, []);
  return route;
}
