import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import { texts } from "../client/src/texts";
import {
  canUseJoker,
  describeMove,
  describeTable,
  joinNames,
  moveFor,
  opponents,
  profileLine,
  revealLine,
  rowPositions,
  soundFor,
  statusLine,
  type Players,
  type Snapshot,
} from "../client/src/view";

const en = texts("en");
const de = texts("de");

const players: Players = {
  p1: { name: "Anna", connected: true, you: true },
  p2: { name: "Ben", connected: true, you: false },
  p3: { name: "Clara", connected: false, you: false },
};

function snapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    player: "p1",
    players: ["p1", "p2", "p3"],
    public: {
      round: 2,
      scores: { p1: 1, p2: 0, p3: 0 },
      played: { p1: false, p2: true, p3: false },
      lastReveal: { cards: { p1: 17, p2: 4, p3: 9 }, jokers: [], winners: ["p1"] },
      deckSize: 18,
      finished: false,
    },
    me: { cards: [21, 3, 12], chosen: null, joker: false },
    moves: [
      { type: "play", card: 21 },
      { type: "play", card: 3 },
      { type: "play", card: 12 },
    ],
    version: 4,
    ...extra,
  };
}

describe("UI", () => {
  it("says what to do", () => {
    expect(statusLine(en, snapshot(), players, { rounds: 5 })).toBe("Round 2 of 5: Choose a card.");
    expect(statusLine(en, snapshot(), players, { rounds: 3 })).toBe("Round 2 of 3: Choose a card.");
    const before = snapshot();
    const waiting = snapshot({ moves: [], me: { cards: [21, 3], chosen: 12, joker: false }, public: { ...before.public, played: { p1: true, p2: true, p3: false } } });
    expect(statusLine(en, waiting, players, { rounds: 5 })).toBe("Round 2 of 5: You played the 12. Waiting for Clara.");
  });

  it("names the winner and a tie", () => {
    expect(statusLine(en, snapshot({ result: { winners: ["p1"] } }), players, { rounds: 5 })).toBe("You win!");
    expect(statusLine(en, snapshot({ result: { winners: ["p2", "p3"] } }), players, { rounds: 5 })).toBe("Tie: Ben and Clara.");
  });

  it("shows the cards revealed last", () => {
    expect(revealLine(en, snapshot(), players)).toBe("Revealed: You 17, Ben 4, Clara 9. Point for you.");
    expect(describeTable(en, snapshot(), players)).toContain("Your cards: 3, 12, 21.");
  });

  it("shows jokers in the profile, in the reveal and as separate moves", () => {
    expect(profileLine(en, { items: { joker: 2 }, stats: { wins: 3 }, flags: {} })).toBe("Your jokers: 2 · Your wins: 3");
    expect(profileLine(en, { items: {}, stats: {}, flags: {} })).toBe("Your jokers: 0 · Your wins: 0");
    const before = snapshot();
    const doubled = snapshot({ public: { ...before.public, lastReveal: { cards: { p1: 17, p2: 9, p3: 4 }, jokers: ["p2"], winners: ["p2"] } } });
    expect(revealLine(en, doubled, players)).toBe("Revealed: You 17, Ben 9 with joker (18), Clara 4. Point for Ben.");
    expect(canUseJoker(snapshot())).toBe(false);
    const withJoker = snapshot({ moves: [...before.moves, { type: "play", card: 21, joker: true }] });
    expect(canUseJoker(withJoker)).toBe(true);
    expect(moveFor(withJoker, 21)).toEqual({ type: "play", card: 21 });
    expect(moveFor(withJoker, 21, true)).toEqual({ type: "play", card: 21, joker: true });
    expect(moveFor(withJoker, 3, true)).toBeUndefined();
    expect(describeMove(en, { type: "play", card: 21, joker: true })).toBe("Play card 21 with joker (counts double)");
  });

  it("speaks German when the platform passes de, and English for languages the game does not have", () => {
    expect(statusLine(de, snapshot(), players, { rounds: 5 })).toBe("Runde 2 von 5: Wähle eine Karte.");
    expect(statusLine(de, snapshot({ result: { winners: ["p2", "p3"] } }), players, { rounds: 5 })).toBe("Unentschieden: Ben und Clara.");
    expect(revealLine(de, snapshot(), players)).toBe("Aufgedeckt: Du 17, Ben 4, Clara 9. Punkt für dich.");
    expect(describeTable(de, snapshot(), players)).toContain("Deine Karten: 3, 12, 21.");
    expect(profileLine(de, { items: { joker: 1 }, stats: { wins: 2 }, flags: {} })).toBe("Deine Joker: 1 · Deine Siege: 2");
    expect(describeMove(de, { type: "play", card: 21 })).toBe("Karte 21 spielen");
    expect(de.yourMoves).toBe("Deine Züge");
    expect(texts("de-AT")).toBe(texts("de"));
  });

  it("plays a sound when you play, when the cards are revealed and at the end", () => {
    const before = snapshot();
    const played = snapshot({ moves: [], me: { cards: [21, 3], chosen: 12, joker: false } });
    expect(soundFor(undefined, before)).toBeUndefined();
    expect(soundFor(before, before)).toBeUndefined();
    expect(soundFor(before, played)).toBe("select");
    const won = snapshot({ public: { ...before.public, round: 3, lastReveal: { cards: { p1: 12, p2: 5, p3: 2 }, jokers: [], winners: ["p1"] } } });
    expect(soundFor(played, won)).toBe("coin");
    const lost = snapshot({ public: { ...before.public, round: 3, lastReveal: { cards: { p1: 12, p2: 15, p3: 2 }, jokers: [], winners: ["p2"] } } });
    expect(soundFor(played, lost)).toBe("pop");
    expect(soundFor(played, snapshot({ ...lost, result: { winners: ["p1", "p2"] } }))).toBe("win");
    expect(soundFor(played, snapshot({ ...lost, result: { winners: ["p2"] } }))).toBe("lose");
  });

  it("orders the other players starting after the own seat", () => {
    expect(opponents(snapshot({ player: "p2" }))).toEqual(["p3", "p1"]);
    expect(joinNames(en, ["Anna", "Ben", "Clara"])).toBe("Anna, Ben and Clara");
  });

  it("centers a row and pushes it together when space is short", () => {
    expect(rowPositions(1, 300, 50, 10)).toEqual([150]);
    expect(rowPositions(3, 300, 50, 10)).toEqual([90, 150, 210]);
    const tight = rowPositions(5, 200, 80, 10);
    expect(tight[0]).toBeCloseTo(40);
    expect(tight.at(-1)).toBeCloseTo(160);
  });
});

describe("Languages", () => {
  it("has a block of texts for every language of the manifest, the default language first", () => {
    const languages = manifest.languages;
    for (const language of languages) {
      expect(texts(language)).toBeDefined();
    }
    expect(texts("xx")).toBe(texts(languages[0]));
    expect(new Set(languages.map((language) => texts(language))).size).toBe(languages.length);
  });
});
