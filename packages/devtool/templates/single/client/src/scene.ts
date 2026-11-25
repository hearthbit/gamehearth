import Phaser from "phaser";
import type { SoundName } from "@gamehearth/sdk/client";
import { levels, type Cell } from "../../src/levels";
import type { Controls } from "./controls";
import type { Texts } from "./texts";
import { cell, frameMs, hudHeight, hudLine, steerTowardLane, velocity } from "./view";

export const columns = Math.max(...levels.map((level) => level.width));
export const rows = Math.max(...levels.map((level) => level.height));
export const fieldWidth = columns * cell;
export const fieldHeight = rows * cell + hudHeight;

const colors = { background: 0x1f3326, wall: 0x5b4a3a, wallEdge: 0x3d3127, floor: 0x2c4a33, cap: 0xd9443a, stem: 0xf3ead8, figure: 0xf2b84b, text: "#f3f0ea" };

export interface LevelStart {
  level?: number;
  elapsedMs?: number;
  onDone?: (levelMs: number) => void;
}

export class LevelScene extends Phaser.Scene {
  readonly #controls: Controls;
  readonly #zoom: number;
  readonly #t: Texts;
  readonly #sound: (sound: SoundName) => void;
  #start: LevelStart = {};
  #player: Phaser.Physics.Arcade.Sprite | undefined;
  #hud: Phaser.GameObjects.Text | undefined;
  #found = 0;
  #total = 0;
  #levelMs = 0;
  #done = false;

  constructor(controls: Controls, zoom: number, t: Texts, sound: (sound: SoundName) => void = () => undefined) {
    super("level");
    this.#controls = controls;
    this.#zoom = zoom;
    this.#t = t;
    this.#sound = sound;
  }

  get attemptMs(): number {
    return this.#levelMs;
  }

  init(data: LevelStart): void {
    this.#start = data;
    this.#player = undefined;
    this.#hud = undefined;
    this.#found = 0;
    this.#total = 0;
    this.#levelMs = 0;
    this.#done = false;
  }

  create(): void {
    this.#makeTextures();
    this.cameras.main.setBackgroundColor(colors.background).setZoom(this.#zoom).centerOn(fieldWidth / 2, fieldHeight / 2);
    const index = this.#start.level;
    const level = index === undefined ? undefined : levels[index];
    if (level === undefined) {
      return;
    }
    const at = (spot: Cell) => ({ x: spot.x * cell + cell / 2, y: hudHeight + spot.y * cell + cell / 2 });
    this.add.rectangle(fieldWidth / 2, hudHeight + (level.height * cell) / 2, level.width * cell, level.height * cell, colors.floor);
    const walls = this.physics.add.staticGroup();
    for (const wall of level.walls) {
      const spot = at(wall);
      walls.create(spot.x, spot.y, "wall");
    }
    const mushrooms = this.physics.add.staticGroup();
    for (const mushroom of level.mushrooms) {
      const spot = at(mushroom);
      const sprite = mushrooms.create(spot.x, spot.y, "mushroom") as Phaser.Physics.Arcade.Image;
      sprite.setCircle(8, 4, 4);
    }
    this.#total = level.mushrooms.length;
    const start = at(level.start);
    const player = this.physics.add.sprite(start.x, start.y, "figure");
    player.setCircle(10, 2, 2);
    this.physics.add.collider(player, walls);
    this.physics.add.overlap(player, mushrooms, (_player, mushroom) => {
      (mushroom as Phaser.Physics.Arcade.Image).disableBody(true, true);
      this.#found += 1;
      this.#sound("pop");
    });
    this.#player = player;
    this.#hud = this.add.text(10, 12, "", { fontFamily: "system-ui, sans-serif", fontSize: "18px", color: colors.text }).setResolution(this.#zoom);
  }

  override update(_time: number, delta: number): void {
    const player = this.#player;
    const index = this.#start.level;
    if (player === undefined || index === undefined || this.#done) {
      return;
    }
    this.#levelMs += frameMs(delta);
    const dir = this.#controls.direction;
    const move = velocity(dir);
    if (dir === "up" || dir === "down") {
      player.setVelocity(steerTowardLane(player.x, 0), move.y);
    } else if (dir === "left" || dir === "right") {
      player.setVelocity(move.x, steerTowardLane(player.y, hudHeight));
    } else {
      player.setVelocity(0, 0);
    }
    this.#hud?.setText(hudLine(this.#t, index,(this.#start.elapsedMs ?? 0) + this.#levelMs, this.#found, this.#total));
    if (this.#found >= this.#total) {
      this.#done = true;
      player.setVelocity(0, 0);
      this.#start.onDone?.(this.#levelMs);
    }
  }

  #makeTextures(): void {
    if (this.textures.exists("wall")) {
      return;
    }
    const g = this.add.graphics();
    g.fillStyle(colors.wallEdge).fillRect(0, 0, cell, cell);
    g.fillStyle(colors.wall).fillRoundedRect(2, 2, cell - 4, cell - 4, 5);
    g.generateTexture("wall", cell, cell);
    g.clear();
    g.fillStyle(colors.stem).fillRect(9, 12, 6, 10);
    g.fillStyle(colors.cap).fillEllipse(12, 10, 22, 14);
    g.fillStyle(colors.stem).fillCircle(8, 8, 2).fillCircle(15, 7, 2);
    g.generateTexture("mushroom", 24, 24);
    g.clear();
    g.fillStyle(colors.figure).fillCircle(12, 12, 11);
    g.fillStyle(0x1d2a3d).fillCircle(8, 10, 2).fillCircle(16, 10, 2);
    g.generateTexture("figure", 24, 24);
    g.destroy();
  }
}
