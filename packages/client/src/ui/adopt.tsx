import { useState } from "preact/hooks";
import { ApiError, adopt } from "../api";
import { useSession } from "../session";
import { tr } from "../language";
import { errorText, texts } from "../texts";
import type { Notify } from "./toasts";

export function AdoptDialog({ notify }: { notify: Notify }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const pending = session.me.state === "ready" ? session.me.adopt : undefined;
  if (pending === undefined) {
    return null;
  }
  const answer = async (take: boolean) => {
    setBusy(true);
    try {
      await adopt(take);
      await session.refresh();
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="modal-backdrop">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="adopt-title">
        <h2 id="adopt-title">{texts.adoptTitle}</h2>
        <p>{texts.adoptText(pending.name, pending.rooms.length + (pending.duplicates?.length ?? 0), session.user?.kind === "guest")}</p>
        {pending.rooms.length > 0 && (
          <ul class="list compact">
            {pending.rooms.map((room) => (
              <li key={room.code}>
                <span class="grow">
                  {tr(room.game)} · {room.code}
                </span>
                <span class="muted small">{texts.roomStatus(room.status, room.round, room.yourTurn)}</span>
              </li>
            ))}
          </ul>
        )}
        {(pending.duplicates?.length ?? 0) > 0 && (
          <>
            <p class="small">{texts.adoptDuplicates}</p>
            <ul class="list compact">
              {(pending.duplicates ?? []).map((room) => (
                <li key={room.code}>
                  <span class="grow">
                    {tr(room.game)} · {room.code}
                  </span>
                  <span class="muted small">{room.status === "running" ? texts.adoptRunningDuplicate : texts.roomStatus(room.status, room.round, room.yourTurn)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p class="muted small">{texts.adoptNoHint}</p>
        <div class="actions">
          <button type="button" class="button secondary" disabled={busy} onClick={() => void answer(false)}>
            {texts.adoptNo}
          </button>
          <button type="button" class="button" disabled={busy} onClick={() => void answer(true)}>
            {texts.adoptYes}
          </button>
        </div>
      </div>
    </div>
  );
}
