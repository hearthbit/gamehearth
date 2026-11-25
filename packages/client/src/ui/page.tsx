import type { ComponentChildren } from "preact";
import { navigate } from "../router";
import { texts } from "../texts";
import { BackIcon } from "./icons";

export type PageWidth = "narrow" | "medium" | "wide";

export function Page({ children, width = "narrow", class: extra }: { children: ComponentChildren; width?: PageWidth; class?: string }) {
  return <main class={extra === undefined ? `page ${width}` : `page ${width} ${extra}`}>{children}</main>;
}

export function PageHeader({
  title,
  subtitle,
  back = "/",
  replace = false,
  end,
}: {
  title: string;
  subtitle?: string | undefined;
  back?: string;
  replace?: boolean;
  end?: ComponentChildren;
}) {
  return (
    <header class="page-header">
      <button type="button" class="icon-button back" aria-label={texts.home} onClick={() => navigate(back, replace)}>
        <BackIcon />
      </button>
      <div class="page-titles">
        <h1 class="page-title">{title}</h1>
        {subtitle !== undefined && subtitle !== "" && <p class="page-subtitle">{subtitle}</p>}
      </div>
      {end !== undefined && end !== null && end !== false && <div class="page-header-end">{end}</div>}
    </header>
  );
}

export function PageActions({ children, note }: { children?: ComponentChildren; note?: ComponentChildren }) {
  return (
    <div class="page-actions">
      {children}
      {note !== undefined && note !== null && note !== false && <p class="page-actions-note">{note}</p>}
    </div>
  );
}

export type BannerKind = "error" | "info" | "offline";

export function Banner({
  kind = "error",
  role = "alert",
  children,
  detail,
  action,
}: {
  kind?: BannerKind;
  role?: "alert" | "status";
  children: ComponentChildren;
  detail?: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <div class={`banner ${kind}`} role={role}>
      <span class="banner-text">
        {children}
        {detail !== undefined && detail !== null && <span class="block muted small">{detail}</span>}
      </span>
      {action}
    </div>
  );
}

export function OfflineBanner({ onRetry, hint = true }: { onRetry?: () => void; hint?: boolean }) {
  return (
    <Banner
      kind="offline"
      detail={hint ? texts.offlineHint : undefined}
      action={
        onRetry === undefined ? undefined : (
          <button type="button" class="button small secondary" onClick={onRetry}>
            {texts.retry}
          </button>
        )
      }
    >
      {texts.offline}
    </Banner>
  );
}

export function Loading({ text = texts.connecting, class: extra }: { text?: string; class?: string }) {
  return (
    <p class={extra === undefined ? "loading" : `loading ${extra}`}>
      <span class="spinner" aria-hidden="true" />
      {text}
    </p>
  );
}
