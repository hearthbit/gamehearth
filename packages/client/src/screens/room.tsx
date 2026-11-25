import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, joinRoom } from "../api";
import { RoomConnection, socketUrl, type ConnectionState } from "../connection";
import { PushPlatformContext, clearRoomNotifications } from "../push";
import type { Command, CommandResult } from "../protocol";
import { navigate } from "../router";
import { useSession } from "../session";
import type { DeviceStorage } from "../storage";
import { errorText, texts } from "../texts";
import { LanguageSwitch } from "../ui/language-switch";
import { useTurnSignals } from "../turn";
import { playCue } from "../sound";
import { LoginForm } from "../ui/login";
import { Banner, Loading, OfflineBanner, Page, PageActions, PageHeader } from "../ui/page";
import type { Notify } from "../ui/toasts";
import { Lobby } from "./lobby";
import { Play } from "./play";

type Handlers = Pick<ConstructorParameters<typeof RoomConnection>[0], "onState" | "onNotice">;

export interface RoomScreenProps {
  code: string;
  storage: DeviceStorage;
  notify: Notify;
  createConnection?: (code: string, handlers: Handlers) => RoomConnection;
}

const fatalTexts: Record<string, string> = {
  removed: texts.removed,
  "room-closed": texts.roomGone,
  "unknown-room": texts.roomGone,
};

const rejoinCodes = new Set(["not-member", "not-signed-in", "signed-out"]);

function defaultConnection(code: string, handlers: Handlers): RoomConnection {
  return new RoomConnection({ code, url: socketUrl(location), ...handlers });
}

function RoomHeader({ title, code }: { title: string; code?: string }) {
  return <PageHeader title={title} subtitle={code} end={<LanguageSwitch />} />;
}

export function RoomScreen({ code, storage, notify, createConnection = defaultConnection }: RoomScreenProps) {
  const session = useSession();
  const [needsJoin, setNeedsJoin] = useState(false);
  const [generation, setGeneration] = useState(0);
  if (session.me.state === "offline") {
    return (
      <Page>
        <RoomHeader title={texts.roomCode} code={code} />
        <OfflineBanner onRetry={() => session.reload()} />
      </Page>
    );
  }
  if (session.user === undefined || needsJoin) {
    return (
      <JoinForm
        code={code}
        storage={storage}
        notify={notify}
        onJoined={() => {
          setNeedsJoin(false);
          setGeneration((value) => value + 1);
        }}
      />
    );
  }
  return (
    <ConnectedRoom
      key={`${session.user.id}:${generation}`}
      code={code}
      notify={notify}
      createConnection={createConnection}
      onRejoin={(reason) => {
        if (reason === "signed-out") {
          notify(texts.signedOut);
        }
        if (reason === "not-member") {
          setNeedsJoin(true);
        } else {
          void session.refresh().then(() => setGeneration((value) => value + 1));
        }
      }}
    />
  );
}

function JoinForm({ code, storage, notify, onJoined }: { code: string; storage: DeviceStorage; notify: Notify; onJoined: () => void }) {
  const session = useSession();
  const user = session.user;
  const [name, setName] = useState(() => (user?.kind === "guest" ? user.name : storage.name()));
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    const player = name.trim();
    if (user?.kind !== "account" && player === "") {
      notify(texts.nameMissing);
      return;
    }
    setBusy(true);
    try {
      await joinRoom(code, user?.kind === "account" ? undefined : player);
      if (user?.kind !== "account") {
        storage.saveName(player);
        await session.refresh();
      }
      playCue("join");
      onJoined();
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
      setBusy(false);
    }
  };
  return (
    <Page>
      <RoomHeader title={texts.joinRoomTitle(code)} />
      <form id="join-form" class="page-form" onSubmit={submit}>
        <section class="card">
          {user?.kind === "account" ? (
            <p>{texts.signedInAs(user.name)}</p>
          ) : (
            <div class="field">
              <label for="join-name">{texts.yourName}</label>
              <input
                id="join-name"
                class="input"
                value={name}
                maxLength={24}
                autoComplete="nickname"
                placeholder={texts.namePlaceholder}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </div>
          )}
        </section>
      </form>
      {user === undefined && (
        <section class="card">
          {signingIn ? (
            <LoginForm notify={notify} onDone={(next) => session.setUser(next)} />
          ) : (
            <button type="button" class="button secondary block" onClick={() => setSigningIn(true)}>
              {texts.showSignIn}
            </button>
          )}
        </section>
      )}
      <PageActions>
        <button type="submit" form="join-form" class="button" disabled={busy}>
          {user?.kind === "account" ? texts.joinAs(user.name) : user === undefined ? texts.joinAsGuest : texts.join}
        </button>
      </PageActions>
    </Page>
  );
}

function ConnectedRoom({
  code,
  notify,
  createConnection,
  onRejoin,
}: {
  code: string;
  notify: Notify;
  createConnection: NonNullable<RoomScreenProps["createConnection"]>;
  onRejoin: (reason: string) => void;
}) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting", room: undefined, fatal: undefined });
  const [entryError, setEntryError] = useState<string | undefined>(undefined);
  const connection = useRef<RoomConnection | undefined>(undefined);
  const entered = useRef(false);
  const platform = useContext(PushPlatformContext);

  useEffect(() => {
    const created = createConnection(code, {
      onState: (next) => {
        if (next.room !== undefined) {
          entered.current = true;
          setEntryError(undefined);
        }
        setState(next);
      },
      onNotice: (noticeCode, message) => {
        if (entered.current) {
          notify(errorText(noticeCode, message));
        } else {
          setEntryError(errorText(noticeCode, message));
        }
      },
    });
    connection.current = created;
    created.start();
    void clearRoomNotifications(platform, code);
    const wake = () => {
      created.reportVisibility();
      if (document.visibilityState === "visible") {
        void clearRoomNotifications(platform, code);
        created.reconnectNow();
      }
    };
    addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      created.dispose();
      connection.current = undefined;
    };
  }, [code]);

  useEffect(() => {
    if (state.fatal !== undefined && rejoinCodes.has(state.fatal.code)) {
      onRejoin(state.fatal.code);
    }
  }, [state.fatal]);

  useTurnSignals(state.room);

  const status = state.room?.status;
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === "lobby" && status === "running") {
      playCue("start");
    }
    lastStatus.current = status;
  }, [status]);

  const command = useCallback(async (next: Command): Promise<CommandResult> => {
    const current = connection.current;
    if (current === undefined) {
      return { ok: false, code: "offline", message: texts.offline };
    }
    return current.command(next);
  }, []);

  const [leaving, setLeaving] = useState(false);
  const leave = useCallback(async () => {
    setLeaving(true);
    const result = await command({ type: "leave" });
    if (result.ok || connection.current?.state.fatal?.code === "removed") {
      navigate("/");
      return;
    }
    setLeaving(false);
    notify(errorText(result.code, result.message));
  }, [command]);

  if (leaving && state.fatal?.code === "removed") {
    return null;
  }
  if (state.fatal !== undefined && rejoinCodes.has(state.fatal.code)) {
    return null;
  }
  if (state.fatal !== undefined) {
    return (
      <Page>
        <RoomHeader title={texts.roomCode} code={code} />
        <Banner
          action={
            <button type="button" class="button small" onClick={() => navigate("/")}>
              {texts.home}
            </button>
          }
        >
          {fatalTexts[state.fatal.code] ?? state.fatal.message}
        </Banner>
      </Page>
    );
  }
  const room = state.room;
  if (room === undefined) {
    return (
      <Page>
        <RoomHeader title={texts.roomCode} code={code} />
        {entryError !== undefined ? (
          <Banner
            action={
              <div class="row wrap">
                <button
                  type="button"
                  class="button small secondary"
                  onClick={() => {
                    setEntryError(undefined);
                    connection.current?.reconnectNow();
                  }}
                >
                  {texts.retry}
                </button>
                <button type="button" class="button small" onClick={() => navigate("/")}>
                  {texts.home}
                </button>
              </div>
            }
          >
            {entryError}
          </Banner>
        ) : state.status === "offline" ? (
          <OfflineBanner onRetry={() => connection.current?.reconnectNow()} />
        ) : (
          <Loading class="center" />
        )}
      </Page>
    );
  }
  if (room.status === "lobby") {
    return <Lobby room={room} online={state.status === "online"} command={command} notify={notify} onLeave={leave} />;
  }
  return <Play room={room} online={state.status === "online"} command={command} notify={notify} onLeave={leave} />;
}
