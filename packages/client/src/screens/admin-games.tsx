import { useState } from "preact/hooks";
import { admin, type AdminBoardEntry, type AdminCatalog, type AdminGame, type CatalogOffer, type GamesOverview } from "../api";
import type { AdminProfiles, CatalogSection, UnknownIds } from "../protocol";
import { profileLines } from "../ui/boards";
import { tr } from "../language";
import { errorText, locale, texts } from "../texts";
import { useConfirm } from "../ui/confirm";
import type { Notify } from "../ui/toasts";
import { ErrorDetail, formatBytes, formatDate, Status, useAction, useAdminData } from "./admin-parts";

export function Games({ notify }: { notify: Notify }) {
  const [data, reload] = useAdminData<GamesOverview>(admin.games);
  const [busy, run] = useAction(notify);
  const [dialog, confirm] = useConfirm();
  const [working, setWorking] = useState<string | undefined>(undefined);

  const install = (offer: CatalogOffer, version: string) =>
    run(async () => {
      let replace = false;
      if (offer.installed !== undefined && !offer.installed.fromThisCatalog && !offer.installed.local) {
        if (!(await confirm(texts.replaceConfirm(tr(offer.name), offer.catalogName), texts.replace))) {
          return;
        }
        replace = true;
      }
      setWorking(texts.installing(tr(offer.name), version));
      try {
        const installed = await admin.install({ catalog: offer.catalogId, game: offer.id, version, ...(replace ? { replace } : {}) });
        notify(installed.unknownIds === undefined ? texts.installed(tr(offer.name), version) : texts.installedUnknown(tr(offer.name), version, unknownList(installed.unknownIds)));
      } finally {
        setWorking(undefined);
        reload();
      }
    });

  const remove = async (game: AdminGame) => {
    const rooms = await admin.games().then(
      (fresh) => fresh.games.find((candidate) => candidate.id === game.id)?.rooms ?? game.rooms,
      () => game.rooms,
    );
    if (await confirm(texts.removeGameConfirm(tr(game.name, game.languages), texts.gameRooms(rooms)), texts.removeGame)) {
      await run(async () => {
        const result = await admin.removeGame(game.id);
        notify(texts.gameRemoved(tr(game.name, game.languages), result.closed));
        reload();
      });
    }
  };

  return (
    <>
      <section class="card" aria-labelledby="games-title">
        <h2 id="games-title">{texts.games}</h2>
        {working !== undefined && (
          <p class="loading small" role="status">
            <span class="spinner" aria-hidden="true" />
            {working}
          </p>
        )}
        <Status data={data}>
          {(overview) => (
            <>
              {overview.games.length === 0 ? (
                <p class="muted small">{texts.noInstalledGames}</p>
              ) : (
                <ul class="list dense">
                  {overview.games.map((game) => (
                    <InstalledGame
                      key={game.id}
                      game={game}
                      offer={overview.offers.find((offer) => offer.id === game.id && offer.catalogId === game.catalogId)}
                      busy={busy}
                      onInstall={install}
                      onRemove={remove}
                    />
                  ))}
                </ul>
              )}
              <p class="muted small">{texts.storage(formatBytes(overview.storage.total), overview.storage.free === null ? undefined : formatBytes(overview.storage.free))}</p>
            </>
          )}
        </Status>
        {dialog}
      </section>
      <Status data={data}>
        {(overview) =>
          overview.enabled ? (
            <Catalogs overview={overview} busy={busy} run={run} reload={reload} notify={notify} onInstall={install} confirm={confirm} />
          ) : null
        }
      </Status>
    </>
  );
}

function InstalledGame({
  game,
  offer,
  busy,
  onInstall,
  onRemove,
}: {
  game: AdminGame;
  offer: CatalogOffer | undefined;
  busy: boolean;
  onInstall: (offer: CatalogOffer, version: string) => Promise<void>;
  onRemove: (game: AdminGame) => Promise<void>;
}) {
  const others = offer?.versions.filter((version) => version.compatible && version.version !== game.version) ?? [];
  const [choice, setChoice] = useState<string>("");
  const picked = others.some((version) => version.version === choice) ? choice : others[0]?.version;
  return (
    <li class="game-entry">
      <div class="grow">
        <strong>
          {tr(game.name, game.languages)} {game.version}
        </strong>{" "}
        {game.broken && <span class="badge">{texts.broken}</span>}
        <div class="muted small">
          {texts.gameSource(game)} · {texts.gameRooms(game.rooms)} · {formatBytes(game.bytes)}
        </div>
        {game.broken && <p class="small">{texts.brokenHint}</p>}
        {game.shadowed !== undefined && <p class="muted small">{texts.shadowedHint(game.shadowed)}</p>}
        {game.unknownIds !== undefined && <p class="small">{texts.unknownIds(unknownList(game.unknownIds))}</p>}
        {game.solo === true && !game.broken && <AdminBoards game={game} busy={busy} />}
        {!game.broken && <AdminProfileList game={game} busy={busy} />}
        {offer !== undefined && others.length > 0 && (
          <details>
            <summary class="small">{texts.otherVersion}</summary>
            <div class="row">
              <select
                class="input grow"
                aria-label={texts.version}
                value={picked}
                onChange={(event) => setChoice(event.currentTarget.value)}
              >
                {others.map((version) => (
                  <option key={version.version} value={version.version}>
                    {version.version}
                  </option>
                ))}
              </select>
              <button type="button" class="button small secondary" disabled={busy || picked === undefined} onClick={() => picked !== undefined && void onInstall(offer, picked)}>
                {texts.install}
              </button>
            </div>
          </details>
        )}
      </div>
      <div class="actions wrap">
        {offer?.update !== undefined && (
          <button type="button" class="button small" disabled={busy} onClick={() => void onInstall(offer, offer.update as string)}>
            {texts.updateTo(offer.update)}
          </button>
        )}
        {game.broken && offer !== undefined && offer.versions.some((version) => version.version === game.version) && (
          <button type="button" class="button small" disabled={busy} onClick={() => void onInstall(offer, game.version)}>
            {texts.install}
          </button>
        )}
        {game.source === "catalog" && (
          <button type="button" class="button small danger" disabled={busy} onClick={() => void onRemove(game)}>
            {texts.removeGame}
          </button>
        )}
      </div>
    </li>
  );
}

export function unknownList(ids: UnknownIds): string {
  return (["items", "stats", "flags"] as const)
    .filter((section) => ids[section].length > 0)
    .map((section) => `${section}: ${ids[section].join(", ")}`)
    .join("; ");
}

function AdminProfileList({ game, busy }: { game: AdminGame; busy: boolean }) {
  const [data, setData] = useState<AdminProfiles | "error" | undefined>(undefined);
  const [dialog, confirm] = useConfirm();
  const load = () => {
    admin.profiles(game.id).then(setData, () => setData("error"));
  };
  const remove = async (user: number, name: string, section: CatalogSection, id: string, label: string) => {
    if (await confirm(texts.deleteEntryConfirm(label, name, tr(game.name, game.languages)), texts.deleteEntry)) {
      admin.deleteProfileEntry(game.id, user, section, id).then(setData, () => setData("error"));
    }
  };
  const reset = async (user: number, name: string) => {
    if (await confirm(texts.resetAdminProfileConfirm(name, tr(game.name, game.languages)), texts.resetAdminProfile)) {
      admin.resetProfile(game.id, user).then(setData, () => setData("error"));
    }
  };
  return (
    <details onToggle={(event) => event.currentTarget.open && load()}>
      <summary class="small">{texts.profiles}</summary>
      {data === undefined && <p class="muted small">{texts.connecting}</p>}
      {data === "error" && <p class="muted small">{texts.offline}</p>}
      {data !== undefined && data !== "error" && data.profiles.length === 0 && <p class="muted small">{texts.noProfiles}</p>}
      {data !== undefined &&
        data !== "error" &&
        data.profiles.map((entry) => {
          const known = profileLines(entry.profile, data.game);
          const unknown = (["items", "stats", "flags"] as const).flatMap((section) =>
            Object.keys(entry.profile[section])
              .filter((id) => !Object.hasOwn(data.game[section], id))
              .map((id) => ({ section, id, label: id, value: String(entry.profile[section][id]) })),
          );
          return (
            <div key={entry.user} class="admin-profile" data-user={entry.user}>
              <div class="row">
                <strong class="grow small">{entry.name}</strong>
                <span class="muted small">{texts.profileUpdated(formatDate(entry.updatedAt))}</span>
              </div>
              <ul class="list">
                {[...known, ...unknown].map((line) => (
                  <li key={`${line.section}.${line.id}`}>
                    <span class="grow small">
                      {line.label}: {line.value}
                    </span>
                    <button type="button" class="button small danger" disabled={busy} onClick={() => void remove(entry.user, entry.name, line.section, line.id, line.label)}>
                      {texts.deleteEntry}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" class="button small danger" disabled={busy} onClick={() => void reset(entry.user, entry.name)}>
                {texts.resetAdminProfile}
              </button>
            </div>
          );
        })}
      {dialog}
    </details>
  );
}

function AdminBoards({ game, busy }: { game: AdminGame; busy: boolean }) {
  const [boards, setBoards] = useState<Record<string, AdminBoardEntry[]> | "error" | undefined>(undefined);
  const [dialog, confirm] = useConfirm();
  const load = () => {
    admin.boards(game.id).then(setBoards, () => setBoards("error"));
  };
  const remove = async (stat: string, entry: AdminBoardEntry) => {
    if (await confirm(texts.deleteBoardEntryConfirm(entry.name, tr(game.name, game.languages)), texts.deleteBoardEntry)) {
      admin.deleteBoardEntry(game.id, entry.user, stat).then(setBoards, () => setBoards("error"));
    }
  };
  return (
    <details onToggle={(event) => event.currentTarget.open && load()}>
      <summary class="small">{texts.boards}</summary>
      {boards === undefined && <p class="muted small">{texts.connecting}</p>}
      {boards === "error" && <p class="muted small">{texts.offline}</p>}
      {boards !== undefined && boards !== "error" &&
        Object.entries(boards).map(([stat, entries]) => (
          <div key={stat} class="admin-board">
            <strong class="small">{stat}</strong>
            {entries.length === 0 ? (
              <p class="muted small">{texts.boardEmpty}</p>
            ) : (
              <ul class="list">
                {entries.map((entry) => (
                  <li key={entry.user}>
                    <span class="grow small">
                      {entry.name}: {entry.value.toLocaleString(locale())}
                    </span>
                    <button type="button" class="button small danger" disabled={busy} onClick={() => void remove(stat, entry)}>
                      {texts.deleteBoardEntry}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      {dialog}
    </details>
  );
}

function Catalogs({
  overview,
  busy,
  run,
  reload,
  notify,
  onInstall,
  confirm,
}: {
  overview: GamesOverview;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  reload: () => void;
  notify: Notify;
  onInstall: (offer: CatalogOffer, version: string) => Promise<void>;
  confirm: (message: string | readonly string[], label?: string) => Promise<boolean>;
}) {
  const [url, setUrl] = useState("");
  const add = async (target: string) => {
    if (!(await confirm(texts.trustCatalog(target), texts.trustAndAdd))) {
      return;
    }
    await run(async () => {
      const catalog = await admin.addCatalog(target);
      notify(texts.catalogAdded(catalog.name, catalog.games));
      setUrl("");
      reload();
    });
  };
  const refresh = (catalog: AdminCatalog) =>
    run(async () => {
      const fresh = await admin.refreshCatalog(catalog.id);
      notify(
        fresh.error === undefined
          ? texts.catalogRefreshed(fresh.name)
          : texts.catalogError(fresh.errorCode === undefined ? fresh.error : errorText(fresh.errorCode, fresh.error)),
      );
      reload();
    });
  const remove = async (catalog: AdminCatalog) => {
    const games = overview.games.filter((game) => game.source === "catalog" && game.catalogId === catalog.id).map((game) => tr(game.name, game.languages));
    if (await confirm(texts.removeCatalogConfirm(catalog.name, games), texts.removeCatalog)) {
      await run(async () => {
        await admin.removeCatalog(catalog.id);
        reload();
      });
    }
  };
  const available = overview.offers.filter((offer) => offer.installed === undefined || (!offer.installed.fromThisCatalog && !offer.installed.local));
  return (
    <section class="card" aria-labelledby="catalogs-title">
      <h2 id="catalogs-title">{texts.catalogs}</h2>
      {overview.catalogs.length === 0 ? (
        <p class="muted small">{texts.noCatalogs}</p>
      ) : (
        <ul class="list dense">
          {overview.catalogs.map((catalog) => (
            <li key={catalog.id}>
              <div class="grow">
                <strong>{catalog.name}</strong>
                <div class="muted small">
                  <code class="link">{catalog.url}</code>
                </div>
                <div class="muted small">{texts.catalogState(formatDate(catalog.fetchedAt), catalog.games)}</div>
                {catalog.error !== undefined && (
                  <div class="small error-text" role="alert">
                    <ErrorDetail
                      sentence={texts.catalogError(catalog.errorCode === undefined ? catalog.error : errorText(catalog.errorCode, catalog.error))}
                      detail={catalog.errorCode === undefined ? undefined : catalog.error}
                    />
                  </div>
                )}
              </div>
              <div class="actions wrap">
                <button type="button" class="button small secondary" disabled={busy} onClick={() => void refresh(catalog)}>
                  {texts.refreshCatalog}
                </button>
                <button type="button" class="button small danger" disabled={busy} onClick={() => void remove(catalog)}>
                  {texts.removeCatalog}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {overview.suggested !== null && (
        <div class="stack suggested">
          <button type="button" class="button small" disabled={busy} onClick={() => void add((overview.suggested as { url: string }).url)}>
            {texts.suggestedCatalog(overview.suggested.name)}
          </button>
          <p class="muted small">{texts.suggestedCatalogHint}</p>
        </div>
      )}
      <form
        class="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() !== "") {
            void add(url.trim());
          }
        }}
      >
        <input
          class="input grow"
          type="url"
          aria-label={texts.catalogUrl}
          placeholder="https://…/catalog.json"
          value={url}
          autoCapitalize="none"
          spellcheck={false}
          onInput={(event) => setUrl(event.currentTarget.value)}
        />
        <button type="submit" class="button small" disabled={busy || url.trim() === ""}>
          {texts.addCatalog}
        </button>
      </form>
      {overview.catalogs.length > 0 && (
        <>
          <h3>{texts.available}</h3>
          {available.length === 0 ? (
            <p class="muted small">{texts.noOffers}</p>
          ) : (
            <ul class="list dense">
              {available.map((offer) => (
                <Offer key={`${offer.catalogId}/${offer.id}`} offer={offer} busy={busy} onInstall={onInstall} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Offer({ offer, busy, onInstall }: { offer: CatalogOffer; busy: boolean; onInstall: (offer: CatalogOffer, version: string) => Promise<void> }) {
  const compatible = offer.versions.filter((version) => version.compatible);
  const [choice, setChoice] = useState<string>("");
  const picked = compatible.some((version) => version.version === choice) ? choice : compatible[0]?.version;
  const version = offer.versions.find((candidate) => candidate.version === picked) ?? offer.versions[0];
  return (
    <li class="game-entry">
      <div class="grow">
        <strong>{tr(offer.name)}</strong>
        {offer.description !== undefined && <div class="small">{tr(offer.description)}</div>}
        {version !== undefined && (
          <div class="muted small">
            {texts.playerCount(version.players.min, version.players.max)} · {texts.license(version.license.code, version.license.assets)} · {formatBytes(version.size)} ·{" "}
            {offer.catalogName}
            {offer.repository !== undefined && (
              <>
                {" · "}
                <a href={offer.repository} target="_blank" rel="noopener noreferrer">
                  {texts.sourceCode}
                </a>
              </>
            )}
          </div>
        )}
        {compatible.length === 0 && version !== undefined && <div class="muted small">{texts.needsNewerServer(version.sdk)}</div>}
      </div>
      <div class="actions wrap">
        {compatible.length > 1 && (
          <select class="input" aria-label={`${texts.version} ${tr(offer.name)}`} value={picked} onChange={(event) => setChoice(event.currentTarget.value)}>
            {compatible.map((entry) => (
              <option key={entry.version} value={entry.version}>
                {entry.version}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          class="button small"
          disabled={busy || picked === undefined}
          aria-label={`${tr(offer.name)} ${texts.install}`}
          onClick={() => picked !== undefined && void onInstall(offer, picked)}
        >
          {texts.install} {picked}
        </button>
      </div>
    </li>
  );
}
