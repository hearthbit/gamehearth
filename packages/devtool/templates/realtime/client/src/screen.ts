import Phaser from "phaser";
import { createTimeline, type ScreenConnection, type Timeline } from "@gamehearth/sdk/client";
import { fieldHeight, fieldWidth, radius, type TagState } from "../../src/index";
import type { Texts } from "./texts";
import { blendPositions, clock, fitField, nameOf, ranking, resultLine, screenSound, seatColor, type Screen } from "./view";

const font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const colors = { background: 0x1d2a3d, field: 0x2c4a3b, line: 0xd8e6d0, text: "#f3f0ea", muted: "#a9b4c6", ring: 0xffffff };

export class FieldScene extends Phaser.Scene {
  readonly #game: ScreenConnection<TagState>;
  readonly #u: number;
  readonly #t: Texts;
  #timeline!: Timeline<Screen>;
  #graphics!: Phaser.GameObjects.Graphics;
  #labels = new Map<string, Phaser.GameObjects.Text>();
  #header!: Phaser.GameObjects.Text;
  #board!: Phaser.GameObjects.Text;
  #result!: Phaser.GameObjects.Text;

  constructor(game: ScreenConnection<TagState>, dpr: number, t: Texts) {
    super("field");
    this.#game = game;
    this.#u = dpr;
    this.#t = t;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.background);
    this.#timeline = createTimeline(this.#game);
    this.#graphics = this.add.graphics();
    this.#header = this.#text(colors.text, 22, "700").setOrigin(0.5, 0);
    this.#board = this.#text(colors.muted, 16, "400").setOrigin(1, 0);
    this.#result = this.#text(colors.text, 34, "700").setOrigin(0.5);
    let previous: Screen | undefined;
    this.#game.onUpdate(({ snapshot }) => {
      const sound = screenSound(previous, snapshot);
      if (sound !== undefined) {
        this.#game.sound(sound);
      }
      previous = snapshot;
    });
  }

  override update(): void {
    const frame = this.#timeline.frame();
    if (frame === undefined) {
      return;
    }
    const u = this.#u;
    const { width, height } = this.scale;
    const players = this.#game.current.players;
    const view = frame.to.public;
    const fit = fitField(fieldWidth, fieldHeight, width, height - 90 * u, 12 * u);
    const top = fit.top + 50 * u;
    const g = this.#graphics;
    g.clear();
    g.fillStyle(colors.field, 1);
    g.fillRoundedRect(fit.left, top, fieldWidth * fit.scale, fieldHeight * fit.scale, 12 * u);
    g.lineStyle(2 * u, colors.line, 0.5);
    g.strokeRoundedRect(fit.left, top, fieldWidth * fit.scale, fieldHeight * fit.scale, 12 * u);

    const positions = blendPositions(frame.from.public, view, frame.alpha);
    for (const [seat, point] of Object.entries(positions)) {
      const x = fit.left + point.x * fit.scale;
      const y = top + point.y * fit.scale;
      const size = radius * fit.scale;
      g.fillStyle(seatColor(seat), view.catcher === seat && view.frozen > 0 ? 0.5 : 1);
      g.fillCircle(x, y, size);
      if (view.catcher === seat) {
        g.lineStyle(4 * u, colors.ring, 1);
        g.strokeCircle(x, y, size + 5 * u);
      }
      const label = this.#labels.get(seat) ?? this.#text(colors.text, 14, "600").setOrigin(0.5, 1);
      this.#labels.set(seat, label);
      label.setText(nameOf(seat, players)).setPosition(x, y - size - 6 * u);
    }

    const t = this.#t;
    this.#header.setText(`${t.name} · ${clock(view.ticksLeft)} · ${t.catcher(nameOf(view.catcher, players))}`).setPosition(width / 2, 12 * u);
    this.#board
      .setText(ranking(t, view, players).map((entry) => `${entry.name}: ${entry.time}`).join("   "))
      .setPosition(width - 16 * u, height - 30 * u);
    const result = frame.to.result;
    this.#result.setText(result === undefined ? "" : resultLine(t, result.winners, players)).setPosition(width / 2, height / 2);
  }

  #text(color: string, size: number, weight: string): Phaser.GameObjects.Text {
    return this.add.text(0, 0, "", { fontFamily: font, fontSize: `${size * this.#u}px`, fontStyle: weight, color });
  }
}
