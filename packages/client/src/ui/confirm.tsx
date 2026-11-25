import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { texts } from "../texts";

interface Pending {
  message: string | readonly string[];
  confirmLabel: string;
  resolve: (answer: boolean) => void;
}

export function useConfirm(): [JSX.Element | null, (message: string | readonly string[], confirmLabel?: string) => Promise<boolean>] {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const ask = useCallback(
    (message: string | readonly string[], confirmLabel: string = texts.confirm) =>
      new Promise<boolean>((resolve) => {
        setPending({ message, confirmLabel, resolve });
      }),
    [],
  );
  const answer = (value: boolean) => {
    pending?.resolve(value);
    setPending(undefined);
  };
  return [pending === undefined ? null : <ConfirmDialog pending={pending} onAnswer={answer} />, ask];
}

function ConfirmDialog({ pending, onAnswer }: { pending: Pending; onAnswer: (value: boolean) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onAnswer(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onAnswer]);
  return (
    <div class="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onAnswer(false)}>
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-message">
        <div id="confirm-message">
          {(typeof pending.message === "string" ? [pending.message] : pending.message).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
        <div class="actions">
          <button type="button" class="button secondary" ref={cancel} onClick={() => onAnswer(false)}>
            {texts.cancel}
          </button>
          <button type="button" class="button" onClick={() => onAnswer(true)}>
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
