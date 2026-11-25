import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { admin, type AdminInvite, type AdminRoom, type AdminUser, type BackupEntry, type QuarantinedBuild } from "../api";
import { useScene } from "../effects";
import type { Role } from "../protocol";
import { adminPath, adminTabs, navigate, roomPath, type AdminTab } from "../router";
import { useSession } from "../session";
import { memberName, tr } from "../language";
import { errorText, texts } from "../texts";
import { useConfirm } from "../ui/confirm";
import { Banner, Page, PageHeader } from "../ui/page";
import { shareOrCopy } from "../ui/share";
import type { Notify } from "../ui/toasts";
import { Games } from "./admin-games";
import { ErrorDetail, formatBytes, formatDate, ProblemBox, ProblemContext, Status, useAction, useAdminData, type Problem } from "./admin-parts";

function LinkResult({ label, url, notify }: { label: string; url: string; notify: Notify }) {
  return (
    <div class="link-result" role="status">
      <p class="small">{label}</p>
      <code class="link">{url}</code>
      <button type="button" class="button small secondary" onClick={() => void shareOrCopy({ title: texts.appName, text: label, url }, notify)}>
        {texts.copyOrShare}
      </button>
    </div>
  );
}

interface Counts {
  invites: number;
  quarantined: number;
}

const CountsContext = createContext<() => void>(() => undefined);

function useCounts(enabled: boolean): [Counts, () => void] {
  const [counts, setCounts] = useState<Counts>({ invites: 0, quarantined: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    Promise.all([admin.invites(), admin.quarantined()]).then(
      ([invites, quarantined]) => active && setCounts({ invites: invites.length, quarantined: quarantined.length }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [enabled, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return [counts, reload];
}

export function AdminScreen({ tab = "games", notify }: { tab?: AdminTab; notify: Notify }) {
  const session = useSession();
  const user = session.user;
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const allowed = user?.kind === "account" && user.role === "admin";
  const [counts, reloadCounts] = useCounts(allowed);
  useScene("admin");
  if (!allowed) {
    return (
      <Page width="medium" class="admin">
        <PageHeader title={texts.admin} />
        <Banner>{errorText("not-admin", texts.unknownError)}</Banner>
      </Page>
    );
  }
  return (
    <ProblemContext.Provider value={setProblem}>
      <CountsContext.Provider value={reloadCounts}>
        <Page width="medium" class="admin">
          <PageHeader title={texts.admin} />
          <AdminTabs current={tab} counts={counts} />
          {problem !== undefined && <ProblemBox problem={problem} onClose={() => setProblem(undefined)} />}
          {tab === "games" && <Games notify={notify} />}
          {tab === "users" && (
            <>
              <Invites notify={notify} />
              <Users notify={notify} currentId={user.id} />
            </>
          )}
          {tab === "rooms" && <Rooms notify={notify} />}
          {tab === "system" && (
            <>
              <Quarantine />
              <Backups notify={notify} />
            </>
          )}
        </Page>
      </CountsContext.Provider>
    </ProblemContext.Provider>
  );
}

function AdminTabs({ current, counts }: { current: AdminTab; counts: Counts }) {
  const badge = (tab: AdminTab): { value: number; label: string } | undefined => {
    if (tab === "users" && counts.invites > 0) {
      return { value: counts.invites, label: texts.invitesOpen(counts.invites) };
    }
    if (tab === "system" && counts.quarantined > 0) {
      return { value: counts.quarantined, label: texts.buildsQuarantined(counts.quarantined) };
    }
    return undefined;
  };
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const active = bar.current?.querySelector<HTMLElement>("[aria-current=page]");
    if (bar.current !== null && active !== null && active !== undefined) {
      bar.current.scrollLeft = Math.max(0, active.offsetLeft - (bar.current.clientWidth - active.offsetWidth) / 2);
    }
  }, [current]);
  return (
    <nav class="admin-tabs" aria-label={texts.adminSections} ref={bar}>
      {adminTabs.map((tab) => {
        const count = badge(tab);
        return (
          <a
            key={tab}
            href={adminPath(tab)}
            class="admin-tab"
            aria-current={tab === current ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(adminPath(tab));
            }}
          >
            {texts.adminTabs[tab]}
            {count !== undefined && (
              <>
                <span class="tab-count" aria-hidden="true">
                  {count.value}
                </span>
                <span class="visually-hidden">, {count.label}</span>
              </>
            )}
          </a>
        );
      })}
    </nav>
  );
}

function Invites({ notify }: { notify: Notify }) {
  const [invites, reloadInvites] = useAdminData<AdminInvite[]>(admin.invites);
  const reloadCounts = useContext(CountsContext);
  const [busy, run] = useAction(notify);
  const [dialog, confirm] = useConfirm();
  const [role, setRole] = useState<Role>("player");
  const [note, setNote] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [link, setLink] = useState<string | undefined>(undefined);
  const reload = () => {
    reloadInvites();
    reloadCounts();
  };
  const create = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      const created = await admin.createInvite({
        role,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        ...(username.trim() === "" ? {} : { username: username.trim() }),
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      });
      setLink(`${location.origin}/invite#${created.token}`);
      setNote("");
      setUsername("");
      setName("");
      reload();
    });
  };
  const revoke = async (invite: AdminInvite) => {
    if (await confirm(texts.revokeConfirm, texts.revoke)) {
      await run(async () => {
        await admin.revokeInvite(invite.id);
        reload();
      });
    }
  };
  return (
    <section class="card" aria-labelledby="invites-title">
      <h2 id="invites-title">{texts.invites}</h2>
      <Status data={invites}>
        {(list) =>
          list.length === 0 ? (
            <p class="muted small">{texts.noInvites}</p>
          ) : (
            <ul class="list dense">
              {list.map((invite) => (
                <li key={invite.id}>
                  <div class="grow">
                    <strong>{invite.note ?? invite.name ?? invite.username ?? (invite.role === "admin" ? texts.roleAdmin : texts.rolePlayer)}</strong>
                    <div class="muted small">
                      {invite.role === "admin" ? texts.roleAdmin : texts.rolePlayer} · {texts.linkExpires(formatDate(invite.expiresAt))}
                      {invite.createdBy !== undefined && ` · ${texts.invitedBy(invite.createdBy)}`}
                    </div>
                  </div>
                  <button type="button" class="button small danger" disabled={busy} onClick={() => void revoke(invite)}>
                    {texts.revoke}
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Status>
      <form class="subsection" onSubmit={create} aria-labelledby="new-invite-title">
        <h3 id="new-invite-title">{texts.newInvite}</h3>
        <div class="form-grid">
          <div class="field">
            <label for="invite-role">{texts.role}</label>
            <select id="invite-role" class="input" value={role} onChange={(event) => setRole(event.currentTarget.value === "admin" ? "admin" : "player")}>
              <option value="player">{texts.rolePlayer}</option>
              <option value="admin">{texts.roleAdmin}</option>
            </select>
          </div>
          <div class="field">
            <label for="invite-note">{texts.inviteNote}</label>
            <input id="invite-note" class="input" value={note} maxLength={80} placeholder={texts.inviteNotePlaceholder} onInput={(event) => setNote(event.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="invite-suggest-username">{texts.suggestedUsername}</label>
            <input
              id="invite-suggest-username"
              class="input"
              value={username}
              maxLength={32}
              autoCapitalize="none"
              spellcheck={false}
              onInput={(event) => setUsername(event.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label for="invite-suggest-name">{texts.suggestedName}</label>
            <input id="invite-suggest-name" class="input" value={name} maxLength={24} onInput={(event) => setName(event.currentTarget.value)} />
          </div>
        </div>
        <div class="card-foot">
          <button type="submit" class="button small" disabled={busy}>
            {texts.createInvite}
          </button>
        </div>
      </form>
      {link !== undefined && <LinkResult label={texts.inviteCreated} url={link} notify={notify} />}
      {dialog}
    </section>
  );
}

function Users({ notify, currentId }: { notify: Notify; currentId: number }) {
  const session = useSession();
  const [users, reload] = useAdminData<AdminUser[]>(admin.users);
  const [busy, run] = useAction(notify);
  const [dialog, confirm] = useConfirm();
  const [reset, setReset] = useState<{ name: string; url: string } | undefined>(undefined);
  const [renaming, setRenaming] = useState<number | undefined>(undefined);
  const [newUsername, setNewUsername] = useState("");

  const update = (user: AdminUser, changes: { role?: Role; locked?: boolean; username?: string }) =>
    run(async () => {
      await admin.updateUser(user.id, changes);
      if (user.id === currentId) {
        await session.refresh();
      }
      setRenaming(undefined);
      reload();
    });
  const lock = async (user: AdminUser) => {
    if (user.locked || (await confirm(texts.lockConfirm(user.name), texts.lock))) {
      await update(user, { locked: !user.locked });
    }
  };
  const remove = async (user: AdminUser) => {
    if (await confirm(texts.deleteConfirm(user.name), texts.deleteUser)) {
      await run(async () => {
        await admin.deleteUser(user.id);
        if (user.id === currentId) {
          await session.refresh();
          navigate("/");
          return;
        }
        reload();
      });
    }
  };
  const resetLink = (user: AdminUser) =>
    run(async () => {
      const token = await admin.resetLink(user.id);
      setReset({ name: user.name, url: `${location.origin}/reset#${token}` });
    });

  return (
    <section class="card" aria-labelledby="users-title">
      <h2 id="users-title">{texts.users}</h2>
      {reset !== undefined && <LinkResult label={texts.resetCreated(reset.name)} url={reset.url} notify={notify} />}
      <Status data={users}>
        {(list) => (
          <ul class="list users dense">
            {list.map((user) => (
              <li key={user.id} class="user">
                <details>
                  <summary>
                    <span class="summary-main">
                      <strong>{user.name}</strong> <span class="muted">@{user.username}</span>{" "}
                      {user.role === "admin" && <span class="badge host">{texts.roleAdmin}</span>} {user.locked && <span class="badge">{texts.locked}</span>}
                    </span>
                    <span class="muted small block">
                      {texts.userRooms(user.rooms)} · {texts.lastActive(formatDate(user.activeAt))}
                    </span>
                  </summary>
                  <div class="actions wrap">
                    <button type="button" class="button small secondary" disabled={busy} onClick={() => void update(user, { role: user.role === "admin" ? "player" : "admin" })}>
                      {user.role === "admin" ? texts.makePlayer : texts.makeAdmin}
                    </button>
                    <button type="button" class="button small secondary" disabled={busy} onClick={() => void lock(user)}>
                      {user.locked ? texts.unlock : texts.lock}
                    </button>
                    <button type="button" class="button small secondary" disabled={busy} onClick={() => void resetLink(user)}>
                      {texts.passwordLink}
                    </button>
                    <button
                      type="button"
                      class="button small secondary"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(user.id);
                        setNewUsername(user.username);
                      }}
                    >
                      {texts.changeUsername}
                    </button>
                    <button type="button" class="button small danger" disabled={busy} onClick={() => void remove(user)}>
                      {texts.deleteUser}
                    </button>
                  </div>
                  {renaming === user.id && (
                    <form
                      class="row rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void update(user, { username: newUsername.trim() });
                      }}
                    >
                      <input
                        class="input grow"
                        aria-label={texts.newUsername}
                        value={newUsername}
                        maxLength={32}
                        autoCapitalize="none"
                        spellcheck={false}
                        onInput={(event) => setNewUsername(event.currentTarget.value)}
                      />
                      <button type="submit" class="button small" disabled={busy}>
                        {texts.save}
                      </button>
                    </form>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Status>
      {dialog}
    </section>
  );
}

function Rooms({ notify }: { notify: Notify }) {
  const [rooms, reload] = useAdminData<AdminRoom[]>(admin.rooms);
  const [busy, run] = useAction(notify);
  const [dialog, confirm] = useConfirm();
  const close = async (room: AdminRoom) => {
    if (await confirm(texts.closeRoomConfirm(room.code), texts.closeRoom)) {
      await run(async () => {
        await admin.closeRoom(room.code);
        reload();
      });
    }
  };
  return (
    <section class="card" aria-labelledby="all-rooms-title">
      <h2 id="all-rooms-title">{texts.allRooms}</h2>
      <Status data={rooms}>
        {(list) =>
          list.length === 0 ? (
            <p class="muted small">{texts.noRoomsAtAll}</p>
          ) : (
            <ul class="list dense">
              {list.map((room) => (
                <li key={room.code}>
                  <div class="grow">
                    <strong>
                      {tr(room.game)} · <a href={roomPath(room.code)}>{room.code}</a>
                    </strong>
                    <div class="muted small">
                      {texts.roomStatus(room.status, room.round, false)} · {room.members.map((member) => memberName(member)).join(", ")} · {formatDate(room.updatedAt)}
                    </div>
                  </div>
                  <button type="button" class="button small danger" disabled={busy} onClick={() => void close(room)}>
                    {texts.closeRoom}
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Status>
      {dialog}
    </section>
  );
}

function Quarantine() {
  const [builds] = useAdminData<QuarantinedBuild[]>(admin.quarantined);
  return (
    <section class="card" aria-labelledby="quarantine-title">
      <h2 id="quarantine-title">{texts.quarantine}</h2>
      <Status data={builds}>
        {(list) =>
          list.length === 0 ? (
            <p class="muted small">{texts.noQuarantine}</p>
          ) : (
            <ul class="list dense">
              {list.map((build) => (
                <li key={build.build}>
                  <div class="grow">
                    <strong>{build.build}</strong>
                    <div class="muted small">
                      <ErrorDetail
                        sentence={`${formatDate(build.since)}${
                          build.hardAborts === undefined || build.softAborts === undefined || build.windowMinutes === undefined
                            ? ""
                            : ` · ${texts.quarantineCounts(build.hardAborts, build.softAborts, build.windowMinutes)}`
                        }`}
                        detail={build.reason}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Status>
    </section>
  );
}

function Backups({ notify }: { notify: Notify }) {
  const [backups, reload] = useAdminData<{ backups: BackupEntry[]; enabled: boolean }>(admin.backups);
  const [busy, run] = useAction(notify);
  const now = () =>
    run(async () => {
      await admin.backupNow();
      notify(texts.backupDone);
      reload();
    });
  return (
    <section class="card" aria-labelledby="backups-title">
      <h2 id="backups-title">{texts.backups}</h2>
      <Status data={backups}>
        {(result) =>
          !result.enabled ? (
            <p class="muted small">{texts.backupsDisabled}</p>
          ) : (
            <>
              {result.backups.length === 0 ? (
                <p class="muted small">{texts.noBackups}</p>
              ) : (
                <ul class="list dense">
                  {result.backups.map((backup) => (
                    <li key={backup.file}>
                      <div class="grow">
                        <strong>{formatDate(backup.createdAt)}</strong>
                        <div class="muted small">
                          {texts.backupKind(backup.kind)} · {formatBytes(backup.bytes)} · {backup.file}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div class="card-foot">
                <button type="button" class="button small secondary" disabled={busy} onClick={() => void now()}>
                  {texts.backupNow}
                </button>
              </div>
            </>
          )
        }
      </Status>
    </section>
  );
}
