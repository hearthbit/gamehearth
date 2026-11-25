import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { ApiError, acceptInvite, inspectLink, logout, resetPassword } from "../api";
import type { LinkInfo, LinkKind } from "../protocol";
import { linkToken, navigate } from "../router";
import { useSession } from "../session";
import { signOutDevice } from "../solo-service";
import { errorText, locale, texts } from "../texts";
import { LanguageSwitch } from "../ui/language-switch";
import { LoginForm } from "../ui/login";
import { Banner, Loading, Page, PageActions, PageHeader } from "../ui/page";
import type { Notify } from "../ui/toasts";

type LinkState =
  | { state: "loading" }
  | { state: "invalid"; message: string; retry?: () => void }
  | { state: "ready"; link: LinkInfo };

function useLink(kind: LinkKind, token: string): LinkState {
  const [link, setLink] = useState<LinkState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (token === "") {
      setLink({ state: "invalid", message: texts.linkMissing });
      return;
    }
    let active = true;
    const retry = () => setAttempt((value) => value + 1);
    inspectLink(token, kind).then(
      (info) => active && setLink({ state: "ready", link: info }),
      (error: unknown) => {
        if (!active) {
          return;
        }
        const offline = !(error instanceof ApiError) || error.code === "offline" || error.code === "server-error";
        setLink(
          offline
            ? { state: "invalid", message: texts.offline, retry }
            : { state: "invalid", message: error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError },
        );
      },
    );
    return () => {
      active = false;
    };
  }, [kind, token, attempt]);
  useEffect(() => {
    if (link.state !== "invalid" || link.retry === undefined) {
      return;
    }
    const retry = link.retry;
    addEventListener("online", retry);
    return () => removeEventListener("online", retry);
  }, [link]);
  return link;
}

function Invalid({ link }: { link: { message: string; retry?: () => void } }) {
  return (
    <Banner
      action={
        link.retry === undefined ? undefined : (
          <button type="button" class="button small secondary" onClick={link.retry}>
            {texts.retry}
          </button>
        )
      }
    >
      {link.message}
    </Banner>
  );
}

function Frame({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <Page>
      <PageHeader title={title} replace end={<LanguageSwitch />} />
      {children}
    </Page>
  );
}

function expiry(link: LinkInfo): string {
  return texts.linkExpires(new Date(link.expiresAt).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }));
}

export function InviteScreen({ kind, notify }: { kind: "invite" | "setup"; notify: Notify }) {
  const session = useSession();
  const [token] = useState(() => linkToken(location.hash));
  const link = useLink(kind, token);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const title = kind === "setup" ? texts.setupTitle : texts.inviteTitle;

  useLayoutEffect(() => {
    if (link.state === "ready") {
      const suggestedName = link.link.name ?? (session.user?.kind === "guest" ? session.user.name : "");
      setUsername((typed) => (typed === "" ? (link.link.username ?? "") : typed));
      setName((typed) => (typed === "" ? suggestedName : typed));
    }
  }, [link.state]);

  if (link.state === "loading") {
    return (
      <Frame title={title}>
        <Loading />
      </Frame>
    );
  }
  if (link.state === "invalid") {
    return (
      <Frame title={title}>
        <Invalid link={link} />
      </Frame>
    );
  }
  const user = session.user;
  if (user?.kind === "account") {
    return (
      <Frame title={title}>
        <div class="card">
          <p>{texts.inviteSignedIn(user.name)}</p>
          <button
            type="button"
            class="button secondary block"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              signOutDevice({ id: user.id, name: user.name })
                .then(() => logout())
                .then(
                  () => {
                    setBusy(false);
                    session.setUser(undefined);
                  },
                  () => setBusy(false),
                );
            }}
          >
            {texts.signOut}
          </button>
        </div>
      </Frame>
    );
  }
  const submit = async (event: Event) => {
    event.preventDefault();
    if (password !== repeat) {
      notify(texts.passwordMismatch);
      return;
    }
    setBusy(true);
    try {
      const created = await acceptInvite(token, username.trim(), name.trim(), password);
      session.setUser(created.user);
      navigate("/", true);
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
      setBusy(false);
    }
  };
  const info = link.link;
  return (
    <Frame title={title}>
      <form class="page-form" onSubmit={submit}>
        <section class="card">
          <p>{kind === "setup" ? texts.setupIntro : texts.inviteIntro(info.role)}</p>
          {user?.kind === "guest" && <p class="muted small">{texts.inviteGuestNote}</p>}
          <div class="field">
            <label for="invite-username">{texts.username}</label>
            <input
              id="invite-username"
              class="input"
              value={username}
              maxLength={32}
              autoComplete="username"
              autoCapitalize="none"
              spellcheck={false}
              onInput={(event) => setUsername(event.currentTarget.value)}
            />
            <span class="field-hint">{texts.usernameHint}</span>
          </div>
          <div class="field">
            <label for="invite-name">{texts.displayName}</label>
            <input id="invite-name" class="input" value={name} maxLength={24} autoComplete="nickname" onInput={(event) => setName(event.currentTarget.value)} />
            <span class="field-hint">{texts.displayNameHint}</span>
          </div>
          <div class="field">
            <label for="invite-password">{texts.password}</label>
            <input
              id="invite-password"
              class="input"
              type="password"
              value={password}
              maxLength={200}
              autoComplete="new-password"
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
            <span class="field-hint">{texts.passwordHint}</span>
          </div>
          <div class="field">
            <label for="invite-repeat">{texts.passwordRepeat}</label>
            <input
              id="invite-repeat"
              class="input"
              type="password"
              value={repeat}
              maxLength={200}
              autoComplete="new-password"
              onInput={(event) => setRepeat(event.currentTarget.value)}
            />
          </div>
        </section>
        <PageActions note={expiry(info)}>
          <button type="submit" class="button" disabled={busy || username.trim() === "" || name.trim() === "" || password === ""}>
            {texts.createAccount}
          </button>
        </PageActions>
      </form>
    </Frame>
  );
}

export function ResetScreen({ notify }: { notify: Notify }) {
  const session = useSession();
  const [token] = useState(() => linkToken(location.hash));
  const link = useLink("reset", token);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);

  if (done !== undefined) {
    return (
      <Frame title={texts.resetTitle}>
        <section class="card">
          <p>{texts.resetDone}</p>
          <LoginForm
            notify={notify}
            initialUsername={done}
            onDone={(user) => {
              session.setUser(user);
              navigate("/", true);
            }}
          />
        </section>
      </Frame>
    );
  }
  if (link.state === "loading") {
    return (
      <Frame title={texts.resetTitle}>
        <Loading />
      </Frame>
    );
  }
  if (link.state === "invalid") {
    return (
      <Frame title={texts.resetTitle}>
        <Invalid link={link} />
      </Frame>
    );
  }
  const submit = async (event: Event) => {
    event.preventDefault();
    if (password !== repeat) {
      notify(texts.passwordMismatch);
      return;
    }
    setBusy(true);
    try {
      const result = await resetPassword(token, password);
      history.replaceState(null, "", "/reset");
      if (session.user?.kind === "account" && session.user.username === result.username) {
        session.setUser(undefined);
      }
      setDone(result.username);
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
      setBusy(false);
    }
  };
  return (
    <Frame title={texts.resetTitle}>
      <form class="page-form" onSubmit={submit}>
        <section class="card">
          <p>{texts.resetIntro(link.link.username ?? "")}</p>
          <input type="text" class="hidden" autoComplete="username" value={link.link.username ?? ""} readOnly aria-hidden="true" tabIndex={-1} />
          <div class="field">
            <label for="reset-password">{texts.password}</label>
            <input
              id="reset-password"
              class="input"
              type="password"
              value={password}
              maxLength={200}
              autoComplete="new-password"
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
            <span class="field-hint">{texts.passwordHint}</span>
          </div>
          <div class="field">
            <label for="reset-repeat">{texts.passwordRepeat}</label>
            <input
              id="reset-repeat"
              class="input"
              type="password"
              value={repeat}
              maxLength={200}
              autoComplete="new-password"
              onInput={(event) => setRepeat(event.currentTarget.value)}
            />
          </div>
        </section>
        <PageActions note={expiry(link.link)}>
          <button type="submit" class="button" disabled={busy || password === ""}>
            {texts.savePassword}
          </button>
        </PageActions>
      </form>
    </Frame>
  );
}
