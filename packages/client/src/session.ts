import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { claimRooms, fetchMe } from "./api";
import type { Adoption, Me, MeInfo } from "./protocol";
import type { DeviceStorage } from "./storage";

export type MeState = { state: "loading" } | { state: "offline" } | { state: "ready"; user: Me | undefined; adopt?: Adoption };

export interface SessionValue {
  me: MeState;
  user: Me | undefined;
  refresh(): Promise<void>;
  setUser(user: Me | undefined): void;
  reload(): void;
}

export const SessionContext = createContext<SessionValue>({
  me: { state: "loading" },
  user: undefined,
  refresh: async () => undefined,
  setUser: () => undefined,
  reload: () => undefined,
});

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

export async function loadMe(storage: DeviceStorage): Promise<MeInfo> {
  let info = await fetchMe();
  if (storage.hasLegacy()) {
    const tokens = storage.legacyTokens();
    if (tokens.length > 0) {
      const claimed = await claimRooms(tokens);
      if (info.user === undefined && claimed.user !== undefined) {
        info = { user: claimed.user };
      }
    }
    storage.clearLegacy();
  }
  return info;
}

function ready(info: MeInfo): MeState {
  return info.adopt === undefined ? { state: "ready", user: info.user } : { state: "ready", user: info.user, adopt: info.adopt };
}

export function useSessionState(storage: DeviceStorage, load: (storage: DeviceStorage) => Promise<MeInfo> = loadMe): SessionValue {
  const [me, setMe] = useState<MeState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const current = useRef(me);
  current.current = me;

  useEffect(() => {
    let active = true;
    load(storage).then(
      (info) => active && setMe(ready(info)),
      () => active && setMe({ state: "offline" }),
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    const retry = () => {
      if (current.current.state === "offline") {
        setAttempt((value) => value + 1);
      }
    };
    addEventListener("online", retry);
    return () => removeEventListener("online", retry);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(ready(await fetchMe()));
    } catch {
      setAttempt((value) => value + 1);
    }
  }, []);
  const setUser = useCallback(
    (user: Me | undefined) => {
      setMe({ state: "ready", user });
      if (user !== undefined) {
        void refresh();
      }
    },
    [refresh],
  );
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { me, user: me.state === "ready" ? me.user : undefined, refresh, setUser, reload };
}
