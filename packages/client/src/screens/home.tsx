import { useEffect, useState } from "preact/hooks";
import { ApiError, createRoom, listGames, logout, myRooms } from "../api";
import { currentDevice, deviceLabel, fitsGame } from "../devices";
import { isSoloGame, type GameInfo, type Me, type RoomSummary, type SoloGameInfo } from "../protocol";
import { savedPages } from "../page-store";
import { gamePath, navigate, roomPath, soloPath } from "../router";
import { preloadMissing, rememberGames, signOutDevice, soloSession } from "../solo-service";
import { lastUser } from "../solo-store";
import { useSession } from "../session";
import { playCue } from "../sound";
import type { DeviceStorage } from "../storage";
import { lacksLanguage, languageNames, tr } from "../language";
import { errorText, texts } from "../texts";
import { Cabinet } from "../ui/cabinet";
import { Cover, gameColor } from "../ui/cover";
import { LoginForm } from "../ui/login";
import { NeonLogo, Sign } from "../ui/neon";
import { OfflineBanner, Page } from "../ui/page";
import { PushHint } from "../ui/push";
import { EffectsSwitch, SoundSwitch } from "../ui/switches";
import { RedeemCard, isStandalone } from "../ui/transfer";
import type { Notify } from "../ui/toasts";
import { LanguageSwitch } from "../ui/language-switch";
import { ThemeSwitch } from "../ui/theme-switch";

type Loaded<T> = { state: "loading" } | { state: "offline" } | { state: "ready"; value: T };

function useLoaded<T>(load: (() => Promise<T>) | undefined, deps: unknown[]): [Loaded<T>, () => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (load === undefined) {
      return;
    }
    let active = true;
    setValue({ state: "loading" });
    load().then(
      (result) => active && setValue({ state: "ready", value: result }),
      () => active && setValue({ state: "offline" }),
    );
    return () => {
      active = false;
    };
  }, [attempt, ...deps]);
  useEffect(() => {
    const retry = () => setAttempt((count) => count + 1);
    addEventListener("online", retry);
    return () => removeEventListener("online", retry);
  }, []);
  return [value, () => setAttempt((count) => count + 1)];
}

export function Home({ storage, notify }: { storage?: DeviceStorage; notify: Notify }) {
  const session = useSession();
  const user = session.user;
  const [rooms, retryRooms] = useLoaded<RoomSummary[]>(user === undefined ? undefined : myRooms, [user?.id, session.me]);
  const [games, retryGames] = useLoaded<GameInfo[]>(user?.kind === "account" ? listGames : undefined, [user?.kind]);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const offline = session.me.state === "offline" || rooms.state === "offline" || games.state === "offline";
  const redeem = session.me.state === "ready" && user?.kind !== "account";
  const redeemFirst = redeem && user === undefined && isStandalone();
  const account = user?.kind === "account";

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
    } finally {
      setBusy(false);
    }
  };

  const create = (game: GameInfo) =>
    void run(async () => {
      const created = await createRoom(game.id);
      playCue("join");
      navigate(roomPath(created.code));
    });

  useEffect(() => {
    if (user?.kind !== "account" || games.state !== "ready") {
      return;
    }
    const solo = soloSession({ id: user.id, name: user.name });
    rememberGames(solo, games.value);
    void preloadMissing(solo);
  }, [games, user?.id]);

  const signOut = () =>
    void run(async () => {
      if (user !== undefined) {
        await signOutDevice({ id: user.id, name: user.name });
      }
      await logout();
      session.setUser(undefined);
    });

  const signedIn = (next: Me) => {
    setSigningIn(false);
    session.setUser(next);
  };

  return (
    <Page width={account ? "wide" : "medium"} class="home">
      <header class="home-header">
        <NeonLogo subtitle={user === undefined ? texts.tagline : texts.signedInAs(user.name)} />
        <div class="tools">
          <SoundSwitch />
          <EffectsSwitch />
        </div>
        <nav class="nav" aria-label={texts.account}>
          {user !== undefined && (
            <>
              <button type="button" class="button small secondary nav-pill" onClick={() => navigate("/account")}>
                {texts.account}
              </button>
              {user.role === "admin" && user.kind === "account" && (
                <button type="button" class="button small secondary nav-pill" onClick={() => navigate("/admin")}>
                  {texts.admin}
                </button>
              )}
              {user.kind === "account" && (
                <button type="button" class="button small secondary nav-pill quiet" disabled={busy} onClick={signOut}>
                  {texts.signOut}
                </button>
              )}
            </>
          )}
          {user === undefined && <ThemeSwitch compact />}
          <LanguageSwitch />
        </nav>
      </header>

      {offline && <OfflineBanner onRetry={() => (session.me.state === "offline" ? session.reload() : (retryRooms(), retryGames()))} />}

      {session.me.state === "offline" && <OfflineGames />}

      {redeemFirst && <RedeemCard notify={notify} />}

      {user?.kind === "guest" && (
        <section class="card guest-note">
          <p class="muted small">
            <span class="badge">{texts.guestBadge}</span> {texts.guestNote}
          </p>
        </section>
      )}

      {user !== undefined && rooms.state === "ready" && rooms.value.some((room) => room.status === "running") && <PushHint notify={notify} {...(storage === undefined ? {} : { storage })} />}

      {user !== undefined && rooms.state === "ready" && rooms.value.length > 0 && (
        <section class="section" aria-labelledby="rooms-title">
          <Sign id="rooms-title" tone="cyan">
            {texts.yourRooms}
          </Sign>
          <ul class="rooms">
            {rooms.value.map((room) => (
              <RoomCard key={room.code} room={room} />
            ))}
          </ul>
        </section>
      )}

      {account && (
        <section class="section" aria-labelledby="games-title">
          <Sign id="games-title" tone="amber">
            {texts.newGame}
          </Sign>
          {games.state === "loading" && <p class="muted">{texts.connecting}</p>}
          {games.state === "ready" && games.value.length === 0 && <p class="card muted">{texts.noGames}</p>}
          {games.state === "ready" && games.value.length > 0 && (
            <ul class="cabinets">
              {games.value.map((game) => (
                <GameCabinet key={game.id} game={game} busy={busy} onCreate={create} />
              ))}
            </ul>
          )}
        </section>
      )}

      <div class={account ? "home-forms single" : "home-forms"}>
        <JoinByCode />

        {user?.kind !== "account" && session.me.state === "ready" && (
          <section class="section" aria-labelledby="signin-title">
            <Sign id="signin-title" tone="violet">
              {texts.signInTitle}
            </Sign>
            <div class="card">
              {user === undefined || signingIn ? (
                <>
                  <LoginForm notify={notify} onDone={signedIn} />
                  {user === undefined && <p class="muted small">{texts.signInHint}</p>}
                </>
              ) : (
                <button type="button" class="button secondary" onClick={() => setSigningIn(true)}>
                  {texts.showSignIn}
                </button>
              )}
            </div>
          </section>
        )}

        {redeem && !redeemFirst && <RedeemCard notify={notify} />}
      </div>
    </Page>
  );
}

function RoomCard({ room }: { room: RoomSummary }) {
  const name = tr(room.game, room.languages);
  const id = room.gameId ?? name;
  const chip = room.yourTurn ? "chip turn" : room.status === "running" ? "chip running" : "chip";
  return (
    <li class="room-card" style={{ "--tone": gameColor(id) }}>
      <span class="room-thumb">
        <Cover id={id} name={name} src={room.cover} />
      </span>
      <div class="room-body">
        <strong class="room-game">{name}</strong>
        <p class="room-meta">
          {texts.roomCode} <span class="code">{room.code}</span> · {texts.memberCount(room.members)}
          {room.muted === true && texts.mutedNote}
          {expiryNote(room.expiresAt)}
        </p>
        <span class={chip}>{texts.roomStatus(room.status, room.round, room.yourTurn)}</span>
      </div>
      <button type="button" class={room.yourTurn ? "button small" : "button small secondary toned"} onClick={() => navigate(roomPath(room.code))}>
        {texts.continueRoom}
      </button>
    </li>
  );
}

function GameCabinet({ game, busy, onCreate }: { game: GameInfo; busy: boolean; onCreate: (game: GameInfo) => void }) {
  const name = tr(game.name, game.languages);
  const solo = isSoloGame(game);
  const devices = deviceLabel(game);
  return (
    <Cabinet
      id={game.id}
      name={name}
      cover={game.cover}
      info={
        <>
          <p class="cabinet-players">{solo ? texts.soloLabel : texts.playerCount(game.players.min, game.players.max)}</p>
          {solo ? <p class="cabinet-devices">{texts.soloOffline}</p> : devices !== undefined && <p class="cabinet-devices">{devices}</p>}
          {!solo && !fitsGame(game, currentDevice()) && <p class="cabinet-note">{texts.deviceMismatch}</p>}
          {lacksLanguage(game.languages) && <p class="cabinet-note">{texts.onlyIn(languageNames(game.languages ?? []))}</p>}
        </>
      }
      action={
        solo ? (
          <button type="button" class="button small" onClick={() => navigate(soloPath(game.id))}>
            {texts.play}
          </button>
        ) : (
          <button type="button" class="button small" disabled={busy} onClick={() => onCreate(game)}>
            {texts.createRoom}
          </button>
        )
      }
    />
  );
}

function OfflineGames() {
  const user = lastUser();
  if (user === undefined) {
    return null;
  }
  const solo = soloSession(user);
  const games = solo.store.games();
  const pages = savedPages(user.id).filter((page) => !page.game.solo);
  return (
    <section class="section offline-games" aria-labelledby="offline-title">
      <Sign id="offline-title" tone="green">
        {texts.offlineGames}
      </Sign>
      <p class="muted small">{texts.offlineGamesHint(user.name)}</p>
      {games.length === 0 ? (
        <p class="card muted">{texts.noOfflineGames}</p>
      ) : (
        <ul class="cabinets">
          {games.map((game: SoloGameInfo) => (
            <Cabinet
              key={game.id}
              id={game.id}
              name={tr(game.name, game.languages)}
              cover={game.cover}
              link={false}
              info={
                <>
                  <p class="cabinet-players">{texts.soloLabel}</p>
                  <p class="cabinet-devices state">{solo.store.isReady(game.build) ? texts.offlineReady : texts.offlineNotReady}</p>
                </>
              }
              action={
                <button type="button" class="button small" onClick={() => navigate(soloPath(game.id))}>
                  {texts.play}
                </button>
              }
            />
          ))}
        </ul>
      )}
      {pages.length > 0 && (
        <div class="card">
          <h3>{texts.savedPages}</h3>
          <ul class="list">
            {pages.map((page) => (
              <li key={page.game.id}>
                <strong class="grow">{tr(page.game.name, page.game.languages)}</strong>
                <button type="button" class="button small secondary" onClick={() => navigate(gamePath(page.game.id))}>
                  {texts.viewPage}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const warnDays = 7;
const dayMs = 24 * 60 * 60 * 1000;

export function expiryNote(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt === undefined || expiresAt - now > warnDays * dayMs) {
    return "";
  }
  return ` · ${texts.expiresSoon(Math.floor((expiresAt - now) / dayMs))}`;
}

function JoinByCode() {
  const [code, setCode] = useState("");
  const join = (event: Event) => {
    event.preventDefault();
    const wanted = code.trim().toUpperCase();
    if (wanted !== "") {
      navigate(roomPath(wanted));
    }
  };
  return (
    <section class="section" aria-labelledby="join-title">
      <Sign id="join-title" tone="pink">
        {texts.joinTitle}
      </Sign>
      <form class="card join" onSubmit={join}>
        <input
          class="input code"
          aria-label={texts.roomCode}
          value={code}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellcheck={false}
          placeholder={texts.codePlaceholder}
          onInput={(event) => setCode(event.currentTarget.value.toUpperCase())}
        />
        <button type="submit" class="button" disabled={code.trim() === ""}>
          {texts.join}
        </button>
      </form>
    </section>
  );
}
