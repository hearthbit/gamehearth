import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, createTransferCode, redeemTransferCode } from "../api";
import { useSession } from "../session";
import { errorText, locale, texts } from "../texts";
import { Sign } from "./neon";
import type { Notify } from "./toasts";

interface ClipboardNavigator {
  clipboard?: { writeText(text: string): Promise<void> };
}

function report(notify: Notify, error: unknown): void {
  notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const nav = navigator as unknown as { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function TransferCode({ notify, label = texts.transferCreate }: { notify: Notify; label?: string }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const focusCopy = useRef(false);
  useEffect(() => {
    if (code === undefined) {
      return;
    }
    setExpired(false);
    if (focusCopy.current) {
      focusCopy.current = false;
      copyButton.current?.focus();
    }
    const timer = setTimeout(() => setExpired(true), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);
  const create = async () => {
    setBusy(true);
    try {
      const next = await createTransferCode();
      focusCopy.current = true;
      setCode(next);
    } catch (error) {
      report(notify, error);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (code === undefined) {
      return;
    }
    const clipboard = (navigator as unknown as ClipboardNavigator).clipboard;
    if (clipboard === undefined) {
      notify(texts.transferCopyManual);
      return;
    }
    try {
      await clipboard.writeText(code.code);
      notify(texts.transferCopied);
    } catch {
      notify(texts.transferCopyManual);
    }
  };
  const until = code === undefined ? "" : new Date(code.expiresAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return (
    <div class="transfer" aria-live="polite">
      {code === undefined ? (
        <button type="button" class="button small secondary" disabled={busy} onClick={() => void create()}>
          {label}
        </button>
      ) : expired ? (
        <>
          <span class="muted small">{texts.transferExpired}</span>
          <button type="button" class="button small secondary" disabled={busy} onClick={() => void create()}>
            {texts.transferNew}
          </button>
        </>
      ) : (
        <>
          <span class="transfer-code" data-testid="transfer-code">
            {code.code}
          </span>
          <span class="muted small">{texts.transferValid(until)}</span>
          <div class="row wrap">
            <button ref={copyButton} type="button" class="button small" onClick={() => void copy()}>
              {texts.transferCopy}
            </button>
            <button type="button" class="button small ghost" disabled={busy} onClick={() => void create()}>
              {texts.transferNew}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function TransferCard({ notify }: { notify: Notify }) {
  return (
    <section class="card" aria-labelledby="transfer-title">
      <h2 id="transfer-title">{texts.transferTitle}</h2>
      <p>{texts.transferIntro}</p>
      <TransferCode notify={notify} />
    </section>
  );
}

export function RedeemCard({ notify }: { notify: Notify }) {
  const session = useSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const user = await redeemTransferCode(code.trim());
      setCode("");
      session.setUser(user);
      notify(texts.redeemDone(user.name));
    } catch (error) {
      report(notify, error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="section" aria-labelledby="redeem-title" data-testid="redeem-card">
      <Sign id="redeem-title" tone="green">
        {texts.redeemTitle}
      </Sign>
      <div class="card">
        <p class="muted small">{texts.redeemIntro}</p>
        <form class="join" onSubmit={(event) => void submit(event)}>
          <input
            class="input code"
            aria-label={texts.redeemLabel}
            value={code}
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellcheck={false}
            placeholder={texts.redeemPlaceholder}
            onInput={(event) => setCode(event.currentTarget.value.toUpperCase())}
          />
          <button type="submit" class="button" disabled={busy || code.trim() === ""}>
            {texts.redeemSubmit}
          </button>
        </form>
      </div>
    </section>
  );
}
