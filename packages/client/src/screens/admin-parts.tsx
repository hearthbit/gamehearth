import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { ApiError } from "../api";
import { errorText, locale, texts } from "../texts";
import { Loading } from "../ui/page";
import type { Notify } from "../ui/toasts";

export type Loaded<T> = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; value: T };

export function useAdminData<T>(load: () => Promise<T>): [Loaded<T>, () => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    load().then(
      (result) => active && setValue({ state: "ready", value: result }),
      (error: unknown) => active && setValue({ state: "failed", message: error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError }),
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return [value, () => setAttempt((count) => count + 1)];
}

export function formatDate(time: number): string {
  return new Date(time).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Status<T>({ data, children }: { data: Loaded<T>; children: (value: T) => preact.ComponentChildren }) {
  if (data.state === "loading") {
    return <Loading />;
  }
  if (data.state === "failed") {
    return (
      <p class="muted" role="alert">
        {data.message}
      </p>
    );
  }
  return <>{children(data.value)}</>;
}

export interface Problem {
  code: string;
  message: string;
}

export const ProblemContext = createContext<((problem: Problem) => void) | undefined>(undefined);

export function useAction(notify: Notify): [boolean, (work: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const report = useContext(ProblemContext);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof ApiError && report !== undefined) {
        report({ code: error.code, message: error.message });
      } else {
        notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
      }
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

export function ErrorDetail({ sentence, detail }: { sentence: string; detail: string | undefined }) {
  return (
    <>
      <p>{sentence}</p>
      {detail !== undefined && detail !== "" && detail !== sentence && (
        <details class="detail">
          <summary>{texts.errorDetails}</summary>
          <code>{detail}</code>
        </details>
      )}
    </>
  );
}

export function ProblemBox({ problem, onClose }: { problem: Problem; onClose: () => void }) {
  return (
    <div class="banner error problem" role="alert">
      <div class="grow">
        <ErrorDetail sentence={errorText(problem.code, texts.unknownError)} detail={problem.message} />
      </div>
      <button type="button" class="button small secondary" onClick={onClose}>
        {texts.dismiss}
      </button>
    </div>
  );
}
