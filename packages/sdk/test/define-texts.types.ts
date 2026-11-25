import { defineTexts } from "../src/client";

const texts = defineTexts({
  en: { yourTurn: "Your turn", cards: (n: number) => (n === 1 ? "1 card" : `${n} cards`) },
  de: { yourTurn: "Du bist dran", cards: (n: number) => (n === 1 ? "1 Karte" : `${n} Karten`) },
});

export const shown: string[] = [texts("de").yourTurn, texts().cards(2)];

// @ts-expect-error a key missing in one language
defineTexts({ en: { a: "A", b: "B" }, de: { a: "A" } });

// @ts-expect-error a text in one language and a function in the other
defineTexts({ en: { a: (n: number) => `${n}` }, de: { a: "A" } });

// @ts-expect-error functions with different parameters
defineTexts({ en: { a: (n: number) => `${n}` }, de: { a: (n: number, unit: string) => `${n} ${unit}` } });

// @ts-expect-error an unknown key
export const missing: string = texts("en").yourMove;
