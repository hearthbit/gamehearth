import { useState } from "preact/hooks";
import { ApiError, pairScreen, pairThisDevice } from "../api";
import { currentDevice } from "../devices";
import { requiresScreen, type Command, type CommandResult, type RoomView } from "../protocol";
import { navigate } from "../router";
import { errorText, texts } from "../texts";
import { useConfirm } from "./confirm";
import type { Notify } from "./toasts";

export interface ScreensCardProps {
  room: RoomView;
  online: boolean;
  command: (command: Command) => Promise<CommandResult>;
  notify: Notify;
}

export function ScreensCard({ room, online, command, notify }: ScreensCardProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDialog, confirm] = useConfirm();
  const screens = room.screens ?? [];
  const large = currentDevice().screen === "large";
  const connected = screens.some((screen) => screen.connected);

  const pair = async (event: Event) => {
    event.preventDefault();
    if (code.trim() === "") {
      notify(texts.screenCodeMissing);
      return;
    }
    setBusy(true);
    try {
      await pairScreen(room.code, code);
      setCode("");
      notify(texts.screenPaired);
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.offline);
    } finally {
      setBusy(false);
    }
  };

  const useThisDevice = async () => {
    if (!(await confirm(texts.useAsScreenConfirm, texts.useAsScreen))) {
      return;
    }
    setBusy(true);
    try {
      await pairThisDevice(room.code);
      navigate("/tv");
    } catch (error) {
      setBusy(false);
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.offline);
    }
  };

  const remove = async (id: number, label: string) => {
    if (await confirm(texts.removeScreenConfirm(label), texts.removeScreen)) {
      const result = await command({ type: "remove-screen", screen: id });
      if (!result.ok) {
        notify(errorText(result.code, result.message));
      }
    }
  };

  return (
    <section class="card" aria-labelledby="screens-title" data-testid="screens">
      <div class="card-head">
        <h2 id="screens-title">{texts.screens}</h2>
        {!connected && <span class="muted">{requiresScreen(room.game) ? texts.screenNeeded : texts.screenOptional}</span>}
      </div>
      {screens.length === 0 ? (
        <p class="muted small">{texts.screenHowTo(`${location.host}/tv`)}</p>
      ) : (
        <ul class="list members">
          {screens.map((screen, index) => (
            <li key={screen.id}>
              <span class="avatar" aria-hidden="true">
                TV
                <span class={screen.connected ? "dot" : "dot off"} />
              </span>
              <div class="grow">
                <strong>{texts.screenLabel(index + 1)}</strong>
                <div class="muted small">{screen.connected ? texts.screenConnected : texts.disconnected}</div>
              </div>
              {room.you.host && (
                <button type="button" class="button small danger" disabled={busy || !online} onClick={() => void remove(screen.id, texts.screenLabel(index + 1))}>
                  {texts.removeScreen}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form class="row pair-form" onSubmit={(event) => void pair(event)}>
        <label class="grow field">
          <span class="visually-hidden">{texts.screenCode}</span>
          <input
            class="input code"
            value={code}
            onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
            placeholder={texts.screenCodePlaceholder}
            autocapitalize="characters"
            autocomplete="off"
            spellcheck={false}
            maxLength={12}
            aria-label={texts.screenCode}
          />
        </label>
        <button type="submit" class="button" disabled={busy || !online}>
          {texts.pairScreen}
        </button>
      </form>
      <button type="button" class={large ? "button block" : "button secondary block"} disabled={busy || !online} onClick={() => void useThisDevice()}>
        {large ? texts.useAsScreenLarge : texts.useAsScreen}
      </button>
      {confirmDialog}
    </section>
  );
}
