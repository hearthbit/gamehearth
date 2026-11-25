import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { texts } from "../texts";
import { MoreIcon } from "./icons";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  icon?: ComponentChildren;
}

export function MenuButton({ items }: { items: readonly (MenuItem | false | undefined)[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = items.filter((item): item is MenuItem => item !== false && item !== undefined);

  useEffect(() => {
    if (!open) {
      return;
    }
    list.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      const entries = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const index = entries.findIndex((entry) => entry === document.activeElement);
      const next = entries[(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length];
      event.preventDefault();
      next?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div class="menu-anchor">
      <button
        ref={button}
        type="button"
        class="icon-button"
        aria-label={texts.menu}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      {open && (
        <>
          <div class="menu-scrim" onClick={() => setOpen(false)} />
          <div class="menu" role="menu" ref={list}>
            {shown.map((item, index) => (
              <button
                key={`${index}:${item.label}`}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                class={item.danger === true ? "danger" : undefined}
                disabled={item.disabled === true}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
                {item.icon !== undefined && (
                  <span class="menu-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
