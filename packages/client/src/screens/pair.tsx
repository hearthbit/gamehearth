import { useEffect, useState } from "preact/hooks";
import { ApiError, myRooms, pairScreen } from "../api";
import type { RoomSummary } from "../protocol";
import { navigate, roomPath } from "../router";
import { useSession } from "../session";
import { tr } from "../language";
import { errorText, texts } from "../texts";
import { TvIcon } from "../ui/icons";
import { LoginForm } from "../ui/login";
import { Loading, Page, PageHeader } from "../ui/page";
import type { Notify } from "../ui/toasts";

function codeFromHash(hash: string): string {
  const raw = hash.replace(/^#/, "").toUpperCase();
  return /^[A-Z0-9]{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : "";
}

export function PairScreen({ notify }: { notify: Notify }) {
  const session = useSession();
  const user = session.user;
  const [code, setCode] = useState(() => codeFromHash(location.hash));
  const [rooms, setRooms] = useState<RoomSummary[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (location.hash !== "") {
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  useEffect(() => {
    if (user === undefined) {
      return;
    }
    let active = true;
    myRooms().then(
      (list) => active && setRooms(list.filter((room) => room.screen === true)),
      () => active && setRooms([]),
    );
    return () => {
      active = false;
    };
  }, [user?.id]);

  const pair = async (room: RoomSummary) => {
    if (code.trim() === "") {
      notify(texts.screenCodeMissing);
      return;
    }
    setBusy(true);
    try {
      await pairScreen(room.code, code);
      notify(texts.screenPaired);
      navigate(roomPath(room.code));
    } catch (error) {
      setBusy(false);
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.offline);
    }
  };

  return (
    <Page class="pair">
      <PageHeader title={texts.pairTitle} />
      <section class="card pair-code">
        <span class="pair-icon" aria-hidden="true">
          <TvIcon />
        </span>
        <div class="field grow">
          <label for="pair-code">{texts.screenCode}</label>
          <input
            id="pair-code"
            class="input code"
            value={code}
            placeholder={texts.screenCodePlaceholder}
            autoComplete="off"
            maxLength={12}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
        </div>
      </section>
      {user === undefined ? (
        <section class="card">
          <p class="muted">{texts.pairSignIn}</p>
          <LoginForm notify={notify} onDone={() => session.refresh()} idPrefix="pair" />
        </section>
      ) : (
        <section class="card" aria-labelledby="pair-rooms">
          <h2 id="pair-rooms">{texts.pairChooseRoom}</h2>
          {rooms === undefined && <Loading />}
          {rooms !== undefined && rooms.length === 0 && <p class="muted">{texts.pairNoRooms}</p>}
          {rooms !== undefined && rooms.length > 0 && (
            <ul class="list">
              {rooms.map((room) => (
                <li key={room.code}>
                  <div class="grow">
                    <strong>{tr(room.game)}</strong>
                    <div class="muted small">
                      {texts.roomCode} {room.code}
                    </div>
                  </div>
                  <button type="button" class="button small" disabled={busy} onClick={() => void pair(room)}>
                    {texts.pairScreen}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Page>
  );
}
