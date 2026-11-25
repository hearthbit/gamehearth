import { defineTexts } from "@gamehearth/sdk/client";

export const texts = defineTexts({
  en: {
    name: "Tag",
    fallback: "This game only runs in Gamehearth. To try it out: npm run dev.",
    pad: "D-pad",
    up: "Up",
    left: "Left",
    right: "Right",
    down: "Down",
    catcher: (name: string) => `Catcher: ${name}`,
    seconds: (seconds: number) => `${seconds.toFixed(1)} s`,
    nobodyWins: "Nobody wins",
    wins: (name: string) => `${name} wins`,
    tie: (names: string) => `Tie: ${names}`,
    youCatchSoon: "You are the catcher! Starting in a moment …",
    youCatch: "You are the catcher! Catch someone.",
    runFrom: (name: string) => `Run away from ${name}!`,
  },
  de: {
    name: "Fangen",
    fallback: "Dieses Spiel läuft nur in Gamehearth. Zum Ausprobieren: npm run dev.",
    pad: "Steuerkreuz",
    up: "Hoch",
    left: "Links",
    right: "Rechts",
    down: "Runter",
    catcher: (name: string) => `Fänger: ${name}`,
    seconds: (seconds: number) => `${seconds.toFixed(1).replace(".", ",")} s`,
    nobodyWins: "Niemand gewinnt",
    wins: (name: string) => `${name} gewinnt`,
    tie: (names: string) => `Unentschieden: ${names}`,
    youCatchSoon: "Du fängst! Gleich geht es los …",
    youCatch: "Du fängst! Fang jemanden.",
    runFrom: (name: string) => `Lauf weg vor ${name}!`,
  },
});

export type Texts = ReturnType<typeof texts>;
