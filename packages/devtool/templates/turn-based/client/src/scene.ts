import Phaser from "phaser";
import type { GameConnection, GameUpdate } from "@gamehearth/sdk/client";
import type { DuelAction, DuelState, Ids, Options } from "../../src/index";
import type { Texts } from "./texts";
import {
  canUseJoker,
  jokerCount,
  moveFor,
  nameOf,
  opponents,
  playable,
  profileLine,
  revealLine,
  rowPositions,
  scoreLine,
  seatState,
  sortedHand,
  statusLine,
  type Snapshot,
} from "./view";

type Update = GameUpdate<DuelState, DuelAction, Options, Ids>;

const font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";
const colors = {
  table: 0x24324a,
  card: 0xfffdf8,
  cardText: "#26303f",
  back: 0x8c3b4a,
  highlight: 0xf2b84b,
  text: "#f3f0ea",
  muted: "#a9b4c6",
};

export class DuelScene extends Phaser.Scene {
  readonly #connection: GameConnection<DuelState, DuelAction, Options, Ids>;
  readonly #u: number;
  readonly #t: Texts;
  #update: Update | undefined;
  #busy = false;
  #withJoker = false;
  #layer!: Phaser.GameObjects.Container;

  constructor(connection: GameConnection<DuelState, DuelAction, Options, Ids>, dpr: number, t: Texts) {
    super("duel");
    this.#connection = connection;
    this.#u = dpr;
    this.#t = t;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.table);
    this.#layer = this.add.container(0, 0);
    this.scale.on("resize", () => this.#render());
    this.#connection.onUpdate((update) => {
      this.#update = update;
      this.#render();
    });
  }

  #render(): void {
    const update = this.#update;
    if (update === undefined) {
      return;
    }
    const snapshot = update.snapshot as Snapshot;
    const players = update.players;
    const u = this.#u;
    const t = this.#t;
    const width = this.scale.width;
    const height = this.scale.height;
    const cardWidth = Phaser.Math.Clamp(width / 5, 56 * u, 110 * u);
    const cardHeight = cardWidth * 1.4;
    this.#layer.removeAll(true);

    const others = opponents(snapshot);
    const seatX = rowPositions(others.length, width, width / Math.max(others.length, 1), 0);
    others.forEach((seat, index) => {
      const x = seatX[index] ?? width / 2;
      const y = 24 * u;
      const name = nameOf(t, seat, players);
      this.#text(x, y, players[seat]?.connected === false ? t.offline(name) : name, 15, colors.text, true);
      this.#text(x, y + 22 * u, [scoreLine(t, seat, snapshot), seatState(t, seat, snapshot)].filter((part) => part !== "").join(" · "), 13, colors.muted);
      const revealed = snapshot.public.lastReveal?.cards[seat];
      if (revealed !== undefined) {
        this.#card(x, y + 50 * u + (cardHeight * 0.6) / 2, cardWidth * 0.6, String(revealed), false);
      }
    });

    let y = height * 0.4;
    for (const [value, size, color, bold] of [
      [statusLine(t, snapshot, players, update.options), 17, colors.text, true],
      [revealLine(t, snapshot, players), 13, colors.muted, false],
      [t.yourPoints(scoreLine(t, snapshot.player, snapshot)), 14, colors.text, false],
      [profileLine(t, update.profile), 13, colors.muted, false],
    ] as const) {
      y += this.#text(width / 2, y, value, size, color, bold).height + 10 * u;
    }
    if (!canUseJoker(snapshot)) {
      this.#withJoker = false;
    } else {
      const label = this.#withJoker ? t.jokerOn(jokerCount(update.profile)) : t.useJoker(jokerCount(update.profile));
      const toggle = this.#text(width / 2, y, label, 14, this.#withJoker ? "#f2b84b" : colors.text, true);
      toggle.setInteractive({ useHandCursor: true }).on("pointerup", () => {
        this.#withJoker = !this.#withJoker;
        this.#render();
      });
    }

    const handY = height - cardHeight / 2 - 18 * u;
    if (snapshot.me.chosen !== null) {
      this.#card(width / 2, handY - cardHeight - 12 * u, cardWidth * 0.8, String(snapshot.me.chosen), false, true);
    }
    const hand = sortedHand(snapshot);
    const legal = playable(snapshot);
    const handX = rowPositions(hand.length, width, cardWidth, 10 * u);
    hand.forEach((card, index) => {
      const canPlay = legal.has(card);
      const shape = this.#card(handX[index] ?? width / 2, canPlay ? handY - 8 * u : handY, cardWidth, String(card), canPlay);
      shape.setAlpha(canPlay || legal.size === 0 ? 1 : 0.6);
      if (canPlay) {
        shape.setInteractive({ useHandCursor: true }).on("pointerup", () => this.#play(card));
      }
    });
  }

  #play(card: number): void {
    const snapshot = this.#update?.snapshot as Snapshot | undefined;
    const move = snapshot === undefined ? undefined : moveFor(snapshot, card, this.#withJoker);
    if (move === undefined || this.#busy) {
      return;
    }
    this.#busy = true;
    void this.#connection
      .move(move)
      .then((answer) => {
        if (answer.ok) {
          this.#withJoker = false;
        }
      })
      .finally(() => {
        this.#busy = false;
        this.#render();
      });
  }

  #card(x: number, y: number, width: number, label: string, highlight: boolean, faceDown = false): Phaser.GameObjects.Container {
    const u = this.#u;
    const height = width * 1.4;
    const body = this.add.graphics();
    body.fillStyle(faceDown ? colors.back : colors.card, 1);
    body.fillRoundedRect(-width / 2, -height / 2, width, height, 8 * u);
    if (highlight) {
      body.lineStyle(3 * u, colors.highlight, 1);
      body.strokeRoundedRect(-width / 2, -height / 2, width, height, 8 * u);
    }
    const text = this.add
      .text(0, 0, label, { fontFamily: font, fontSize: `${Math.round(width * 0.38)}px`, fontStyle: "700", color: faceDown ? colors.text : colors.cardText })
      .setOrigin(0.5);
    const card = this.add.container(x, y, [body, text]);
    card.setSize(width, height);
    this.#layer.add(card);
    return card;
  }

  #text(x: number, y: number, value: string, size: number, color: string, bold = false): Phaser.GameObjects.Text {
    const u = this.#u;
    const text = this.add
      .text(x, y, value, {
        fontFamily: font,
        fontSize: `${size * u}px`,
        fontStyle: bold ? "700" : "400",
        color,
        align: "center",
        wordWrap: { width: this.scale.width - 32 * u },
      })
      .setOrigin(0.5, 0);
    this.#layer.add(text);
    return text;
  }
}
