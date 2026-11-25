import { useEffect, useState } from "preact/hooks";
import { ApiError, changePassword, endAllSessions, endSession, mySessions, rename } from "../api";
import type { SessionInfo } from "../protocol";
import { navigate } from "../router";
import { useSession } from "../session";
import { errorText, locale, texts } from "../texts";
import { useConfirm } from "../ui/confirm";
import { LanguageSwitch } from "../ui/language-switch";
import { Banner, Loading, OfflineBanner, Page, PageHeader } from "../ui/page";
import { PushCard } from "../ui/push";
import { EffectsSetting, SoundSetting } from "../ui/switches";
import { ThemeSwitch } from "../ui/theme-switch";
import { TransferCard } from "../ui/transfer";
import type { Notify } from "../ui/toasts";

function useAction(notify: Notify): [boolean, (work: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
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
  return [busy, run];
}

export function AccountScreen({ notify }: { notify: Notify }) {
  const session = useSession();
  const user = session.user;
  return (
    <Page class="account">
      <PageHeader title={texts.accountTitle} />
      {user === undefined ? (
        <Banner>{errorText("not-signed-in", texts.unknownError)}</Banner>
      ) : (
        <>
          <NameCard notify={notify} />
          {user.kind === "account" && <PasswordCard notify={notify} />}
          <PushCard notify={notify} offerCode={false} />
          <DevicesCard notify={notify} />
          {user.role !== "admin" && <TransferCard notify={notify} />}
          <SettingsCard />
          {user.kind !== "account" && <p class="muted small">{texts.guestAccountNote}</p>}
        </>
      )}
    </Page>
  );
}

function SettingsCard() {
  return (
    <section class="card" aria-labelledby="settings-title">
      <h2 id="settings-title">{texts.settingsTitle}</h2>
      <div class="setting">
        <div class="grow">
          <span class="setting-label">{texts.language}</span>
          <span class="setting-hint">{texts.languageHint}</span>
        </div>
        <LanguageSwitch />
      </div>
      <div class="setting stacked">
        <div>
          <span class="setting-label">{texts.theme}</span>
          <span class="setting-hint">{texts.themeHint}</span>
        </div>
        <ThemeSwitch />
      </div>
      <SoundSetting />
      <EffectsSetting />
    </section>
  );
}

function NameCard({ notify }: { notify: Notify }) {
  const session = useSession();
  const [name, setName] = useState(session.user?.name ?? "");
  const [busy, run] = useAction(notify);
  const submit = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      const user = await rename(name.trim());
      setName(user.name);
      await session.refresh();
      notify(texts.nameSaved);
    });
  };
  return (
    <form class="card" onSubmit={submit} aria-labelledby="name-title">
      <h2 id="name-title">{texts.yourName}</h2>
      <div class="field">
        <label for="account-name">{texts.displayName}</label>
        <input id="account-name" class="input" value={name} maxLength={24} autoComplete="nickname" onInput={(event) => setName(event.currentTarget.value)} />
        {session.user?.username !== undefined && (
          <span class="field-hint">
            {texts.username}: {session.user.username}
          </span>
        )}
      </div>
      <div class="card-foot">
        <button type="submit" class="button small" disabled={busy || name.trim() === "" || name.trim() === session.user?.name}>
          {texts.save}
        </button>
      </div>
    </form>
  );
}

function PasswordCard({ notify }: { notify: Notify }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, run] = useAction(notify);
  const submit = (event: Event) => {
    event.preventDefault();
    if (password !== repeat) {
      notify(texts.passwordMismatch);
      return;
    }
    void run(async () => {
      await changePassword(current, password);
      setCurrent("");
      setPassword("");
      setRepeat("");
      notify(texts.passwordChanged);
    });
  };
  return (
    <form class="card" onSubmit={submit} aria-labelledby="password-title">
      <h2 id="password-title">{texts.changePassword}</h2>
      <div class="field">
        <label for="account-current">{texts.currentPassword}</label>
        <input id="account-current" class="input" type="password" value={current} maxLength={200} autoComplete="current-password" onInput={(event) => setCurrent(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label for="account-password">{texts.newPassword}</label>
        <input id="account-password" class="input" type="password" value={password} maxLength={200} autoComplete="new-password" onInput={(event) => setPassword(event.currentTarget.value)} />
        <span class="field-hint">{texts.passwordHint}</span>
      </div>
      <div class="field">
        <label for="account-repeat">{texts.passwordRepeat}</label>
        <input id="account-repeat" class="input" type="password" value={repeat} maxLength={200} autoComplete="new-password" onInput={(event) => setRepeat(event.currentTarget.value)} />
      </div>
      <div class="card-foot">
        <button type="submit" class="button small" disabled={busy || current === "" || password === ""}>
          {texts.changePassword}
        </button>
      </div>
    </form>
  );
}

function DevicesCard({ notify }: { notify: Notify }) {
  const session = useSession();
  const guest = session.user?.kind === "guest";
  const [sessions, setSessions] = useState<SessionInfo[] | "offline" | undefined>(undefined);
  const currentId = Array.isArray(sessions) ? (sessions.find((entry) => entry.current)?.id ?? Infinity) : Infinity;
  const newer = Array.isArray(sessions) ? sessions.filter((entry) => entry.id > currentId) : [];
  const [attempt, setAttempt] = useState(0);
  const [busy, run] = useAction(notify);
  const [dialog, confirm] = useConfirm();
  useEffect(() => {
    let active = true;
    mySessions().then(
      (list) => active && setSessions(list),
      () => active && setSessions("offline"),
    );
    const retry = () => setAttempt((value) => value + 1);
    addEventListener("online", retry);
    return () => {
      active = false;
      removeEventListener("online", retry);
    };
  }, [attempt]);
  const end = (entry: SessionInfo) =>
    run(async () => {
      await endSession(entry.id);
      if (entry.current) {
        session.setUser(undefined);
        navigate("/");
        return;
      }
      setAttempt((value) => value + 1);
    });
  const endAll = async () => {
    if (guest) {
      if (await confirm(texts.endOthersConfirm, texts.endOthers)) {
        await run(async () => {
          await endAllSessions();
          setAttempt((value) => value + 1);
        });
      }
      return;
    }
    if (await confirm(texts.endAllConfirm, texts.endAll)) {
      await run(async () => {
        await endAllSessions();
        session.setUser(undefined);
        navigate("/");
      });
    }
  };
  return (
    <section class="card" aria-labelledby="devices-title">
      <h2 id="devices-title">{texts.devices}</h2>
      {sessions === undefined ? (
        <Loading />
      ) : sessions === "offline" ? (
        <OfflineBanner hint={false} onRetry={() => setAttempt((value) => value + 1)} />
      ) : (
        <ul class="list">
          {sessions.map((entry) => (
            <li key={entry.id}>
              <div class="grow">
                <strong>{texts.deviceName(entry.browser, entry.system)}</strong> {entry.current && <span class="badge host">{texts.thisDevice}</span>}{" "}
                {entry.push === true && <span class="badge">{texts.pushDevice}</span>}
                <div class="muted small">{texts.deviceSeen(new Date(entry.seenAt).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }))}</div>
              </div>
              {(!guest || entry.id > currentId) && (
                <button type="button" class="button small secondary" disabled={busy} onClick={() => void end(entry)}>
                  {texts.endSession}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(!guest || newer.length > 0) && (
        <div class="card-foot">
          <button type="button" class="button small danger" disabled={busy} onClick={() => void endAll()}>
            {guest ? texts.endOthers : texts.endAll}
          </button>
        </div>
      )}
      {dialog}
    </section>
  );
}
