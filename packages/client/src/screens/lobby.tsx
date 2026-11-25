import { useState } from "preact/hooks";
import { hasScreenRole, requiresScreen, type Command, type CommandResult, type RoomView } from "../protocol";
import { OptionsCard } from "../ui/options";
import { roomPath } from "../router";
import { memberName, robotSign, tr } from "../language";
import { errorText, texts } from "../texts";
import { useConfirm } from "../ui/confirm";
import { ShareIcon } from "../ui/icons";
import { MenuButton } from "../ui/menu";
import { Banner, Page, PageActions, PageHeader } from "../ui/page";
import { PushHint, toggleMute } from "../ui/push";
import { QrCode } from "../ui/qr";
import { ScreensCard } from "../ui/screens";
import type { Notify } from "../ui/toasts";

export interface RoomScreenChildProps {
  room: RoomView;
  online: boolean;
  command: (command: Command) => Promise<CommandResult>;
  notify: Notify;
  onLeave: () => Promise<void>;
}

interface ShareNavigator {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

export function Lobby({ room, online, command, notify, onLeave }: RoomScreenChildProps) {
  const [confirmDialog, confirm] = useConfirm();
  const [busy, setBusy] = useState(false);
  const link = `${location.origin}${roomPath(room.code)}`;
  const host = room.members.find((member) => member.host);
  const needed = texts.playerCount(room.players.min, room.players.max);

  const run = async (next: Command) => {
    setBusy(true);
    const result = await command(next);
    setBusy(false);
    if (!result.ok) {
      notify(errorText(result.code, result.message));
    }
  };

  const share = async () => {
    const nav = navigator as unknown as ShareNavigator;
    if (nav.share !== undefined) {
      try {
        await nav.share({ title: texts.shareTitle(tr(room.game.name, room.game.languages)), text: texts.shareText(tr(room.game.name, room.game.languages), room.code), url: link });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }
    try {
      await nav.clipboard?.writeText(link);
      notify(texts.copied);
    } catch {
      notify(link);
    }
  };

  const kick = async (id: number, name: string) => {
    if (await confirm(texts.kickConfirm(name), texts.kick)) {
      await run({ type: "kick", member: id });
    }
  };

  const full = room.members.length >= room.maxMembers;

  const leave = async () => {
    if (await confirm(texts.leaveConfirm, texts.leave)) {
      await onLeave();
    }
  };

  const screenMissing = requiresScreen(room.game) && !(room.screens ?? []).some((screen) => screen.connected);
  return (
    <Page width="medium" class="lobby">
      <PageHeader
        title={tr(room.game.name, room.game.languages)}
        subtitle={`${texts.lobby}${room.round > 1 ? ` · ${texts.round(room.round)}` : ""}`}
        end={
          <MenuButton
            items={[
              { label: room.muted === true ? texts.unmute : texts.mute, onSelect: () => void toggleMute(room.code, room.muted !== true, notify) },
              { label: texts.leave, onSelect: () => void leave(), danger: true, disabled: busy || !online },
            ]}
          />
        }
      />

      {!online && (
        <Banner kind="offline" role="status">
          <span class="row">
            <span class="spinner" aria-hidden="true" />
            {texts.reconnecting}
          </span>
        </Banner>
      )}

      <PushHint notify={notify} />

      <section class="card share" aria-labelledby="share-title">
        <h2 id="share-title" class="share-title">
          {texts.lobbyShareTitle}
        </h2>
        <QrCode text={link} label={texts.qrLabel(room.code)} />
        <div class="share-info">
          <span class="field-label">{texts.roomCode}</span>
          <span class="room-code" data-testid="room-code">
            {room.code}
          </span>
          <button type="button" class="button secondary" onClick={() => void share()}>
            <ShareIcon />
            {texts.shareLink}
          </button>
        </div>
      </section>

      <div class="lobby-grid">
        {hasScreenRole(room.game) && <ScreensCard room={room} online={online} command={command} notify={notify} />}

        {room.options !== undefined && (
          <OptionsCard
            options={room.options}
            editable={room.you.host}
            disabled={busy || !online}
            hostName={host?.name ?? texts.host}
            languages={room.game.languages}
            onChange={(name, value) => void run({ type: "set-option", name, value })}
          />
        )}

        <section class="card" aria-labelledby="members-title">
          <div class="card-head">
            <h2 id="members-title">{texts.members}</h2>
            <span class="muted">{texts.needPlayers(needed, room.members.length)}</span>
          </div>
          <ul class="list members">
            {room.members.map((member) => {
              const bot = member.bot !== undefined;
              return (
                <li key={member.id} class={bot ? "bot" : undefined}>
                  <span class="avatar" aria-hidden="true">
                    {bot ? robotSign : member.name.slice(0, 1).toUpperCase()}
                    {!bot && <span class={member.connected ? "dot" : "dot off"} />}
                  </span>
                  <div class="grow">
                    <strong>{memberName(member)}</strong>
                    {member.you && <span class="muted"> ({texts.you})</span>}
                    {!bot && !member.connected && <div class="muted small">{texts.disconnected}</div>}
                  </div>
                  {bot && <span class="badge">{texts.botBadge}</span>}
                  {member.guest && <span class="badge">{texts.guestBadge}</span>}
                  {member.host && <span class="badge host">{texts.host}</span>}
                  {room.you.host && !member.you && (
                    <button
                      type="button"
                      class="button small danger"
                      disabled={busy || !online}
                      onClick={() => void (bot ? run({ type: "kick", member: member.id }) : kick(member.id, member.name))}
                    >
                      {texts.kick}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {room.you.host && room.game.bots === true && (
            <button type="button" class="button secondary block" disabled={busy || !online || full} onClick={() => void run({ type: "add-bot" })}>
              <span aria-hidden="true">{robotSign}</span>
              {texts.addBot}
            </button>
          )}
        </section>
      </div>

      {room.you.host ? (
        <PageActions note={screenMissing ? texts.startNeedsScreen : undefined}>
          <button type="button" class="button" disabled={!room.canStart || busy || !online} onClick={() => void run({ type: "start" })}>
            {texts.start}
          </button>
        </PageActions>
      ) : (
        <PageActions note={texts.waitingForHost(host?.name ?? texts.host)} />
      )}
      {confirmDialog}
    </Page>
  );
}
