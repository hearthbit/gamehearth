import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { saveLanguage } from "./api";
import { deviceLanguage, LanguageContext, startLanguage, storeAccountLanguage, storeLanguage } from "./language";
import type { MeInfo } from "./protocol";
import { useRoute } from "./router";
import { AccountScreen } from "./screens/account";
import { AdminScreen } from "./screens/admin";
import { GameScreen } from "./screens/game";
import { Home } from "./screens/home";
import { InviteScreen, ResetScreen } from "./screens/links";
import { PairScreen } from "./screens/pair";
import { RoomScreen } from "./screens/room";
import { SoloScreen } from "./screens/solo";
import { useSoloBackground } from "./solo-service";
import { endIntro, useIntroEnd } from "./effects";
import { TvScreen } from "./screens/tv";
import { SessionContext, useSessionState } from "./session";
import { DeviceStorage } from "./storage";
import { isLanguage, setLanguage, type Language } from "./texts";
import { ThemeContext, useThemeChoice } from "./theme";
import { AdoptDialog } from "./ui/adopt";
import { Backdrop } from "./ui/neon";
import { Loading } from "./ui/page";
import { Toasts, useToasts } from "./ui/toasts";

export function App({ storage, loadMe }: { storage?: DeviceStorage; loadMe?: (storage: DeviceStorage) => Promise<MeInfo> }) {
  const route = useRoute();
  const [toasts, notify] = useToasts();
  const store = useMemo(() => storage ?? new DeviceStorage(), [storage]);
  const session = useSessionState(store, loadMe);
  const [current, setCurrent] = useState<Language>(() => startLanguage(undefined, route.name === "tv"));
  const chosenSignedOut = useRef<Language | undefined>(undefined);
  const known = useRef<number | undefined>(undefined);
  const user = session.user;
  const apply = (next: Language) => {
    setLanguage(next);
    setCurrent(next);
  };
  useEffect(() => {
    if (session.me.state !== "ready" || route.name === "tv") {
      return;
    }
    if (user === undefined) {
      if (known.current !== undefined) {
        known.current = undefined;
        storeAccountLanguage(undefined);
        apply(deviceLanguage());
      }
      return;
    }
    known.current = user.id;
    if (isLanguage(user.language)) {
      chosenSignedOut.current = undefined;
      storeAccountLanguage(user.language);
      if (user.language !== current) {
        apply(user.language);
      }
      return;
    }
    storeAccountLanguage(undefined);
    const handed = chosenSignedOut.current;
    chosenSignedOut.current = undefined;
    if (handed !== undefined) {
      void saveLanguage(handed).catch(() => undefined);
      return;
    }
    const own = deviceLanguage();
    if (own !== current) {
      apply(own);
    }
  }, [session.me.state, user?.id, user?.language, route.name]);
  const choose = useCallback(
    (next: Language) => {
      apply(next);
      storeLanguage(next);
      if (route.name === "tv") {
        return;
      }
      if (user === undefined) {
        chosenSignedOut.current = next;
        return;
      }
      storeAccountLanguage(next);
      void saveLanguage(next).catch(() => undefined);
    },
    [user, route.name],
  );
  const language = useMemo(() => ({ language: current, choose }), [current, choose]);
  const theme = useThemeChoice(session.me.state === "ready", user, route.name === "tv");
  useSoloBackground(session.user?.kind === "account" ? session.user : undefined);
  useIntroEnd(route.name === "tv" || session.me.state !== "loading");
  const firstRoute = useRef(route);
  useEffect(() => {
    if (route !== firstRoute.current) {
      endIntro();
    }
  }, [route]);
  let screen;
  if (route.name === "tv") {
    return (
      <LanguageContext.Provider value={language}>
        <ThemeContext.Provider value={theme}>
          <Backdrop />
          <TvScreen />
          <Toasts items={toasts} />
        </ThemeContext.Provider>
      </LanguageContext.Provider>
    );
  }
  if (session.me.state === "loading") {
    screen = (
      <main class="page narrow center">
        <Loading />
      </main>
    );
  } else if (route.name === "room") {
    screen = <RoomScreen key={route.code} code={route.code} storage={store} notify={notify} />;
  } else if (route.name === "invite" || route.name === "setup") {
    screen = <InviteScreen kind={route.name} notify={notify} />;
  } else if (route.name === "reset") {
    screen = <ResetScreen notify={notify} />;
  } else if (route.name === "admin") {
    screen = <AdminScreen tab={route.tab} notify={notify} />;
  } else if (route.name === "account") {
    screen = <AccountScreen notify={notify} />;
  } else if (route.name === "solo") {
    screen = <SoloScreen key={route.game} gameId={route.game} notify={notify} />;
  } else if (route.name === "game") {
    screen = <GameScreen key={route.game} gameId={route.game} notify={notify} />;
  } else if (route.name === "pair") {
    screen = <PairScreen notify={notify} />;
  } else {
    screen = <Home storage={store} notify={notify} />;
  }
  return (
    <LanguageContext.Provider value={language}>
      <ThemeContext.Provider value={theme}>
        <SessionContext.Provider value={session}>
          <Backdrop />
          {screen}
          <AdoptDialog notify={notify} />
          <Toasts items={toasts} />
        </SessionContext.Provider>
      </ThemeContext.Provider>
    </LanguageContext.Provider>
  );
}
