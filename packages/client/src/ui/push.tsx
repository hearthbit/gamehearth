import { useRef, useState } from "preact/hooks";
import { ApiError, muteRoom } from "../api";
import type { Me } from "../protocol";
import { usePush } from "../push";
import { useSession } from "../session";
import { TransferCode } from "./transfer";
import { DeviceStorage } from "../storage";
import { errorText, texts } from "../texts";
import type { Notify } from "./toasts";

function reporter(notify: Notify): (error: unknown) => void {
  return (error) => notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
}

function iosText(user: Me | undefined): string {
  const next = user?.kind === "guest" ? texts.pushIosGuest : user?.role === "admin" ? texts.pushIosAdmin : texts.pushIosAccount;
  return `${texts.pushIosInstall} ${next}`;
}

function focusPageTitle(): void {
  const title = document.querySelector<HTMLElement>("main h1");
  if (title !== null) {
    title.tabIndex = -1;
    title.focus();
  }
}

export function PushCard({ notify, offerCode = true }: { notify: Notify; offerCode?: boolean }) {
  const session = useSession();
  const push = usePush(reporter(notify));
  const heading = useRef<HTMLHeadingElement>(null);
  const { view, busy } = push;
  const after = (message: string) => (done: boolean) => {
    heading.current?.focus();
    if (done) {
      notify(message);
    }
  };
  return (
    <section class="card" aria-labelledby="push-title" data-testid="push-card" data-state={view.state}>
      <h2 id="push-title" ref={heading} tabIndex={-1}>
        {texts.pushTitle}
      </h2>
      {view.state === "loading" && <p class="muted">{texts.connecting}</p>}
      {view.state === "offline" && <p class="muted">{texts.offline}</p>}
      {view.state === "unsupported" && <p class="muted">{texts.pushUnsupported}</p>}
      {view.state === "unavailable" && <p class="muted">{texts.pushUnavailable}</p>}
      {view.state === "ios-install" && (
        <>
          <p>{iosText(session.user)}</p>
          {session.user?.role !== "admin" &&
            (offerCode ? <TransferCode notify={notify} label={texts.transferForApp} /> : <p class="muted small">{texts.transferBelow}</p>)}
        </>
      )}
      {view.state === "denied" && <p>{texts.pushDenied}</p>}
      {view.state === "off" && (
        <>
          <p>{texts.pushIntro}</p>
          <div class="card-foot start">
            <button type="button" class="button small" disabled={busy} onClick={() => void push.enable().then(after(texts.pushEnabled))}>
              {texts.pushEnable}
            </button>
          </div>
        </>
      )}
      {view.state === "on" && (
        <>
          <p>{texts.pushOn}</p>
          <div class="card-foot start">
            <button
              type="button"
              class="button small secondary"
              disabled={busy}
              onClick={() =>
                void push.test().then((sent) => {
                  if (sent) {
                    notify(texts.pushTestSent);
                  }
                })
              }
            >
              {texts.pushTest}
            </button>
            <button type="button" class="button small ghost" disabled={busy} onClick={() => void push.disable().then(after(texts.pushDisabled))}>
              {texts.pushDisable}
            </button>
          </div>
        </>
      )}
      <p class="muted small">{texts.pushPrivacy}</p>
    </section>
  );
}

const defaultStorage = new DeviceStorage();

export function PushHint({ notify, storage = defaultStorage }: { notify: Notify; storage?: DeviceStorage }) {
  const session = useSession();
  const [dismissed, setDismissed] = useState(() => storage.pushHintDismissed());
  const push = usePush(reporter(notify));
  const { view, busy } = push;
  if (dismissed || (view.state !== "off" && view.state !== "ios-install")) {
    return null;
  }
  const later = () => {
    storage.dismissPushHint();
    setDismissed(true);
    focusPageTitle();
  };
  return (
    <section class="card hint" aria-labelledby="push-hint-title" data-testid="push-hint">
      <h2 id="push-hint-title">{texts.pushHintTitle}</h2>
      <p class="small">{view.state === "ios-install" ? iosText(session.user) : texts.pushIntro}</p>
      {view.state === "ios-install" && session.user?.role !== "admin" && <TransferCode notify={notify} label={texts.transferForApp} />}
      <div class="row wrap">
        {view.state === "off" && (
          <button
            type="button"
            class="button small"
            disabled={busy}
            onClick={() =>
              void push.enable().then((done) => {
                if (done) {
                  focusPageTitle();
                  notify(texts.pushEnabled);
                }
              })
            }
          >
            {texts.pushEnable}
          </button>
        )}
        <button type="button" class="button small ghost" onClick={later}>
          {texts.pushHintLater}
        </button>
      </div>
    </section>
  );
}

export async function toggleMute(code: string, muted: boolean, notify: Notify): Promise<void> {
  try {
    const now = await muteRoom(code, muted);
    notify(now ? texts.muted : texts.unmuted);
  } catch (error) {
    reporter(notify)(error);
  }
}
