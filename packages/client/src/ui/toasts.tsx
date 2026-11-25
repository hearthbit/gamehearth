import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export interface Toast {
  id: number;
  text: string;
}

export type Notify = (text: string) => void;

export function useToasts(durationMs = 4500): [Toast[], Notify] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
    },
    [],
  );
  const notify = useCallback(
    (text: string) => {
      const id = next.current++;
      setToasts((current) => [...current.filter((toast) => toast.text !== text), { id, text }].slice(-3));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, durationMs);
      timers.current.add(timer);
    },
    [durationMs],
  );
  return [toasts, notify];
}

export function Toasts({ items }: { items: Toast[] }) {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <div class="toast" key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
