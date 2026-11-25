import { texts } from "../texts";
import type { Notify } from "./toasts";

interface ShareNavigator {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

export async function shareOrCopy(data: { title: string; text: string; url: string }, notify: Notify): Promise<void> {
  const nav = navigator as unknown as ShareNavigator;
  if (nav.share !== undefined) {
    try {
      await nav.share(data);
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
    }
  }
  try {
    await nav.clipboard?.writeText(data.url);
    notify(texts.copied);
  } catch {
    notify(data.url);
  }
}
