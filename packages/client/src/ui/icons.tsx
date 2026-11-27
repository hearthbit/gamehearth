const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const;

export function BackIcon() {
  return (
    <svg {...common}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...common}>
      <circle cx="12" cy="5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg {...common}>
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

export function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg {...common}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {on ? <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" /> : <path d="M17 9l5 6M22 9l-5 6" />}
    </svg>
  );
}

export function MusicIcon({ on }: { on: boolean }) {
  return (
    <svg {...common}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
      {on ? null : <path d="M3 3l18 18" />}
    </svg>
  );
}

export function EffectsIcon({ on }: { on: boolean }) {
  return (
    <svg {...common}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      {on ? <path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /> : null}
      <circle cx="12" cy="12" r={on ? 3 : 2.5} fill={on ? "currentColor" : "none"} />
    </svg>
  );
}


export function TvIcon() {
  return (
    <svg {...common}>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
