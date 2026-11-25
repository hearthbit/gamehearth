import type { ComponentChildren } from "preact";
import { texts } from "../texts";
import { ThemeMarks } from "./marks";

export type Tone = "cyan" | "pink" | "amber" | "green" | "violet";

const bulbs = Array.from({ length: 40 }, (_, index) => index);
const phases = [0, 1, 2];

function Bulbs({ phase }: { phase?: number }) {
  return (
    <span class={phase === undefined ? "bulb-row" : "bulb-row lit"}>
      {bulbs
        .filter((index) => phase === undefined || index % phases.length === phase)
        .map((index) => (
          <i key={index} style={{ "--i": String(index) }} />
        ))}
    </span>
  );
}

export function Backdrop() {
  return (
    <>
      <div class="backdrop" aria-hidden="true">
        <div class="wall" />
        <div class="horizon" />
        <div class="floor">
          <div class="floor-grid" />
        </div>
      </div>
      <div class="glass" aria-hidden="true" />
    </>
  );
}

export function NeonLogo({ subtitle }: { subtitle?: ComponentChildren }) {
  return (
    <div class="brand">
      <ThemeMarks />
      <div class="brand-text">
        <h1 class="logo" aria-label={texts.appName}>
          {[...texts.appName].map((char, index) => (
            <span key={index} aria-hidden="true">
              {char}
            </span>
          ))}
        </h1>
        {subtitle !== undefined && <p class="brand-sub">{subtitle}</p>}
      </div>
      <span class="open-sign" aria-hidden="true">
        {texts.openSign}
      </span>
      <span class="bulbs" aria-hidden="true">
        <Bulbs />
        {phases.map((phase) => (
          <Bulbs key={phase} phase={phase} />
        ))}
      </span>
    </div>
  );
}

export function Sign({ id, tone = "cyan", children }: { id: string; tone?: Tone; children: ComponentChildren }) {
  return (
    <h2 id={id} class={`sign tone-${tone}`}>
      {children}
    </h2>
  );
}
