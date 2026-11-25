import { useEffect, useState } from "preact/hooks";
import { ApiError, createRoom, games } from "../api";
import { savedPage, savePage } from "../page-store";
import type { GamePage } from "../protocol";
import { navigate, roomPath, soloPath } from "../router";
import { useSession } from "../session";
import { soloSession } from "../solo-service";
import { lastUser } from "../solo-store";
import { lacksLanguage, languageNames, tr } from "../language";
import { errorText, texts } from "../texts";
import { BoardList, ProfileView } from "../ui/boards";
import { useConfirm } from "../ui/confirm";
import { Cover, gameColor } from "../ui/cover";
import { Banner, Loading, Page, PageActions, PageHeader } from "../ui/page";
import { playCue } from "../sound";
import type { Notify } from "../ui/toasts";

type PageState = { kind: "loading" } | { kind: "ready"; page: GamePage; offline: boolean } | { kind: "missing" } | { kind: "unknown" };

export function GameScreen({ gameId, notify }: { gameId: string; notify: Notify }) {
  const session = useSession();
  const online = session.me.state === "ready";
  const user = session.user;
  const account = user?.kind === "account" ? user : undefined;
  const cacheUser = account?.id ?? (session.me.state === "offline" ? lastUser()?.id : undefined);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();

  useEffect(() => {
    let active = true;
    const cached = () => {
      const page = cacheUser === undefined ? undefined : savedPage(cacheUser, gameId);
      return page === undefined ? ({ kind: "missing" } as const) : ({ kind: "ready", page, offline: true } as const);
    };
    if (!online) {
      setState(cached());
      return;
    }
    setState({ kind: "loading" });
    games.page(gameId).then(
      (page) => {
        if (account !== undefined) {
          savePage(account.id, page);
        }
        if (active) {
          setState({ kind: "ready", page, offline: false });
        }
      },
      (error: unknown) => {
        if (!active) {
          return;
        }
        if (error instanceof ApiError && error.code === "unknown-game") {
          setState({ kind: "unknown" });
        } else {
          setState(cached());
        }
      },
    );
    return () => {
      active = false;
    };
  }, [gameId, online, account?.id, cacheUser]);

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

  const create = () =>
    void run(async () => {
      const created = await createRoom(gameId);
      playCue("join");
      navigate(roomPath(created.code));
    });

  const reset = async (page: GamePage) => {
    if (!online || account === undefined) {
      notify(texts.resetOffline);
      return;
    }
    if (!(await confirm(texts.resetProfileConfirm(tr(page.game.name, page.game.languages)), texts.resetProfile))) {
      return;
    }
    await run(async () => {
      const fresh = await games.reset(gameId);
      savePage(account.id, fresh);
      setState({ kind: "ready", page: fresh, offline: false });
      if (fresh.game.solo) {
        await soloSession({ id: account.id, name: account.name }).sync.sync(gameId);
      }
      notify(texts.profileReset);
    });
  };

  const title = state.kind === "ready" ? tr(state.page.game.name, state.page.game.languages) : gameId;
  return (
    <Page width="medium" class="game-page">
      <PageHeader title={title} />
      {state.kind === "loading" && <Loading />}
      {state.kind === "unknown" && (
        <section class="card">
          <p>{texts.gameUnknown}</p>
        </section>
      )}
      {state.kind === "missing" && (
        <Banner kind="offline" detail={texts.pageMissing}>
          {texts.offline}
        </Banner>
      )}
      {state.kind === "ready" && (
        <GameContent page={state.page} offline={state.offline} online={online} busy={busy} signedIn={account !== undefined} onCreate={create} onReset={() => void reset(state.page)} />
      )}
      {dialog}
    </Page>
  );
}

function GameContent({
  page,
  offline,
  online,
  busy,
  signedIn,
  onCreate,
  onReset,
}: {
  page: GamePage;
  offline: boolean;
  online: boolean;
  busy: boolean;
  signedIn: boolean;
  onCreate: () => void;
  onReset: () => void;
}) {
  const { game } = page;
  const name = tr(game.name, game.languages);
  const ranked = Object.entries(game.stats).filter(([, spec]) => spec.better !== undefined);
  return (
    <>
      {offline && (
        <Banner kind="offline" role="status">
          {texts.pageOffline}
        </Banner>
      )}
      <section class="card game-hero" aria-label={texts.gamePage} style={{ "--tone": gameColor(game.id) }}>
        <span class="screen hero-screen">
          <Cover id={game.id} name={name} src={game.cover} />
        </span>
        <div class="hero-info">
          {game.description !== undefined && <p class="hero-description">{tr(game.description, game.languages)}</p>}
          <p class="hero-players">{game.solo ? texts.soloInfo : texts.playerCount(game.players.min, game.players.max)}</p>
          {lacksLanguage(game.languages) && <p class="muted small">{texts.onlyIn(languageNames(game.languages ?? []))}</p>}
        </div>
      </section>
      <div class="game-grid">
        <section class="card" aria-labelledby="game-profile">
          <h2 id="game-profile">{texts.yourProfile}</h2>
          {page.profile === null ? <p class="muted small">{texts.profileGuest}</p> : <ProfileView profile={page.profile} catalog={game} />}
          {page.profile !== null && signedIn && (
            <div class="card-foot">
              <button type="button" class="button small danger" disabled={busy} onClick={onReset}>
                {texts.resetProfile}
              </button>
            </div>
          )}
        </section>
        <section class="card" aria-labelledby="game-boards">
          <h2 id="game-boards">{texts.boardsHeading}</h2>
          {ranked.length === 0 && <p class="muted small">{texts.boardsEmpty}</p>}
          {page.source === "client" && ranked.length > 0 && <p class="muted small">{texts.boardFromDevice}</p>}
          {ranked.map(([stat, spec]) => (
            <section key={stat} data-stat={stat} class="game-board">
              <h3>{tr(spec.label, game.languages)}</h3>
              <BoardList entries={Object.hasOwn(page.boards, stat) ? (page.boards[stat] ?? []) : []} spec={spec} />
            </section>
          ))}
        </section>
      </div>
      {game.solo ? (
        <PageActions>
          <button type="button" class="button" onClick={() => navigate(soloPath(game.id))}>
            {texts.play}
          </button>
        </PageActions>
      ) : (
        signedIn && (
          <PageActions>
            <button type="button" class="button" disabled={busy || !online} onClick={onCreate}>
              {texts.createRoom}
            </button>
          </PageActions>
        )
      )}
    </>
  );
}
