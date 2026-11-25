import { useEffect, useState } from "preact/hooks";
import type { LiveView, MemberView } from "../protocol";
import { memberName, seatName } from "../language";
import { texts } from "../texts";

export interface LiveOverlayProps {
  live: LiveView | undefined;
  members: readonly MemberView[];
  host?: boolean;
  online?: boolean;
  onResume?: () => void;
  onAbort?: () => void;
  bots?: boolean;
  onHandOver?: (member: MemberView) => void;
}

export function canHandOver(member: MemberView): boolean {
  return member.seat !== null && !member.you && !member.connected && member.bot === undefined && member.autopilot !== true;
}

export function awayNames(room: { members: readonly MemberView[]; live?: LiveView | undefined }): string[] {
  return (room.live?.awaySeats ?? []).map((seat) => {
    const member = room.members.find((entry) => entry.seat === seat);
    return member === undefined ? seat : seatName(member);
  });
}

function useCountdown(live: LiveView | undefined): number | undefined {
  const [left, setLeft] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (live?.state !== "countdown" || live.remainingMs === undefined) {
      setLeft(undefined);
      return;
    }
    const until = Date.now() + live.remainingMs;
    const update = () => setLeft(Math.max(0, until - Date.now()));
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [live]);
  return left;
}

export function LiveOverlay({ live, members, host = false, online = true, onResume, onAbort, bots = false, onHandOver }: LiveOverlayProps) {
  const left = useCountdown(live);
  if (live === undefined || live.state === "running") {
    return null;
  }
  if (live.state === "countdown") {
    return (
      <div class="live countdown" role="status" aria-live="assertive" data-testid="live-countdown">
        <span class="count">{left === undefined ? "" : Math.max(1, Math.ceil(left / 1000))}</span>
        <span>{texts.getReady}</span>
      </div>
    );
  }
  if (live.state === "halted") {
    return (
      <div class="live" role="alert" data-testid="live-halted">
        <strong>{texts.liveHalted}</strong>
        <span class="small">{texts.liveIncident(live.incident ?? "?")}</span>
        {host && (
          <div class="row">
            <button type="button" class="button" disabled={!online} onClick={onResume}>
              {texts.liveRetry}
            </button>
            <button type="button" class="button danger" disabled={!online} onClick={onAbort}>
              {texts.abort}
            </button>
          </div>
        )}
      </div>
    );
  }
  const missing = live.missingSeats.map((seat) => {
    const member = members.find((entry) => entry.seat === seat);
    return { seat, member, name: member === undefined ? seat : memberName(member) };
  });
  const handable = host && bots && onHandOver !== undefined ? missing.filter(({ member }) => member !== undefined && canHandOver(member)) : [];
  return (
    <div class="live" role="status" data-testid="live-paused">
      <strong>{texts.livePaused}</strong>
      {missing.map(({ seat, name }) => (
        <span key={seat}>{texts.waitingFor(name)}</span>
      ))}
      {live.screenMissing && <span>{texts.waitingForScreen}</span>}
      {live.byHost && <span>{texts.pausedByHost}</span>}
      {host && live.byHost && (
        <button type="button" class="button" disabled={!online} onClick={onResume}>
          {texts.resume}
        </button>
      )}
      {handable.length > 0 && (
        <div class="row wrap live-actions">
          {handable.map(({ seat, member, name }) => (
            <button key={seat} type="button" class="button secondary" disabled={!online} onClick={() => member !== undefined && onHandOver?.(member)}>
              {texts.handOver(name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
