import Phaser from "phaser";
import { getCell, getOccupant } from "@deathwarriors/game-core";
import type {
  Position,
  WorldState,
} from "@deathwarriors/game-core";

const CELL_SIZE = 48;
const STEP = 51;
const MARGIN = 24;
const openingMarks = { open: "О", closed: "З", destroyed: "Р" };

export interface PhaserMap {
  render(world: WorldState): void;
  highlight(selected: Position | null, focused: Position | null): void;
  destroy(): void;
}

/** Сцена рисует снимок core; выбор клетки не запускает игровых действий. */
export function createPhaserMap(
  root: HTMLElement,
  onSelect: (position: Position) => void,
): PhaserMap {
  let world: WorldState | null = null;
  let selected: Position | null = null;
  let focused: Position | null = null;
  let disposed = false;

  class WorldScene extends Phaser.Scene {
    private ready = false;
    private markers: Phaser.GameObjects.Graphics | undefined;

    create(): void {
      if (disposed) {
        return;
      }

      this.ready = true;
      this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        const x = pointer.worldX - MARGIN;
        const y = pointer.worldY - MARGIN;
        const position = { x: Math.floor(x / STEP), y: Math.floor(y / STEP) };

        if (
          world &&
          x >= 0 &&
          y >= 0 &&
          x % STEP < CELL_SIZE &&
          y % STEP < CELL_SIZE &&
          getCell(world.map, position)
        ) {
          onSelect(position);
        }
      });
      this.drawWorld();
    }

    private text(x: number, y: number, value: string, color = "#e5e9de", size = 12): void {
      this.add.text(x, y, value, {
        fontFamily: "Segoe UI, sans-serif",
        fontSize: `${size}px`,
        color,
      }).setOrigin(0.5);
    }

    drawWorld(): void {
      if (!this.ready || !world || disposed) {
        return;
      }

      this.children.removeAll(true);
      this.markers = undefined;
      const width = MARGIN + world.map.width * STEP;
      const height = MARGIN + world.map.height * STEP;
      this.scale.resize(width, height);
      const graphics = this.add.graphics();

      for (let x = 0; x < world.map.width; x++) {
        this.text(MARGIN + x * STEP + CELL_SIZE / 2, 10, String(x), "#b2bdae", 10);
      }

      for (let y = 0; y < world.map.height; y++) {
        this.text(10, MARGIN + y * STEP + CELL_SIZE / 2, String(y), "#b2bdae", 10);

        for (let x = 0; x < world.map.width; x++) {
          const cell = getCell(world.map, { x, y });

          if (!cell) {
            throw new Error(`В WorldState отсутствует клетка (${x}, ${y})`);
          }

          const left = MARGIN + x * STEP;
          const top = MARGIN + y * STEP;
          const cx = left + CELL_SIZE / 2;
          const cy = top + CELL_SIZE / 2;
          graphics.fillStyle(cell.surface === "floor" ? 0x484d3f : 0x283c33);
          graphics.fillRect(left, top, CELL_SIZE, CELL_SIZE);
          graphics.lineStyle(1, cell.area === "inside" ? 0x6a715e : 0x4d6555);

          if (cell.area === "inside") {
            graphics.strokeRect(left, top, CELL_SIZE, CELL_SIZE);
          } else {
            this.dashedBorder(graphics, left, top);
          }

          const structure = cell.structure;

          if (structure?.kind === "wall") {
            graphics.fillStyle(0x353d37);
            graphics.fillRect(left + 1, top + 1, CELL_SIZE - 2, CELL_SIZE - 2);
            this.text(cx, cy, "▦", "#aab0a2", 24);
          } else if (structure?.kind === "obstacle") {
            this.text(cx, cy, "◆", "#c0ad90", 22);
          } else if (structure?.kind === "door" || structure?.kind === "window") {
            const mark = structure.kind === "door" ? "Д" : "О";
            this.text(cx, cy - 8, `${mark}·${openingMarks[structure.state]}`, "#e8ca8e");

            if (structure.reinforcement) {
              const { hp, maxHP } = structure.reinforcement;
              this.text(cx, top + 7, `+ ${hp}/${maxHP}`, "#e8ca8e", 9);
            }
          }

          const occupant = getOccupant(world, { x, y });

          if (occupant?.kind === "unit" && occupant.alive) {
            const defender = occupant.side === "defender";
            graphics.fillStyle(defender ? 0xa3c9b3 : 0xde9b88);

            if (defender) {
              graphics.fillCircle(cx, cy + 2, 12);
            } else {
              graphics.fillPoints([
                new Phaser.Math.Vector2(cx, cy - 11),
                new Phaser.Math.Vector2(cx + 13, cy + 2),
                new Phaser.Math.Vector2(cx, cy + 15),
                new Phaser.Math.Vector2(cx - 13, cy + 2),
              ], true);
            }

            this.text(cx, cy + 2, defender ? "З" : "В", "#152c21");
            this.text(cx, top + 42, `${occupant.stats.hp}/${occupant.stats.maxHP}`, "#edf2e8", 9);
          } else if (occupant?.kind === "trap") {
            this.text(cx, cy, "×", "#f4d894", 27);
          }
        }
      }

      this.markers = this.add.graphics();
      this.drawMarkers();
      root.dataset.ready = "true";
    }

    private dashedBorder(graphics: Phaser.GameObjects.Graphics, left: number, top: number): void {
      for (let offset = 0; offset < CELL_SIZE; offset += 6) {
        const end = Math.min(offset + 3, CELL_SIZE);
        graphics.lineBetween(left + offset, top, left + end, top);
        graphics.lineBetween(left + offset, top + CELL_SIZE, left + end, top + CELL_SIZE);
        graphics.lineBetween(left, top + offset, left, top + end);
        graphics.lineBetween(left + CELL_SIZE, top + offset, left + CELL_SIZE, top + end);
      }
    }

    drawMarkers(): void {
      const graphics = this.markers;

      if (!graphics) {
        return;
      }

      graphics.clear();

      if (selected) {
        const x = MARGIN + selected.x * STEP;
        const y = MARGIN + selected.y * STEP;
        graphics.lineStyle(2, 0xd4d59b);
        graphics.strokeRect(x + 2, y + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        graphics.fillStyle(0xd4d59b);
        graphics.fillTriangle(x + 39, y + 3, x + 45, y + 3, x + 45, y + 9);
      }

      if (focused) {
        graphics.lineStyle(1, 0xffffff);
        this.dashedBorder(graphics, MARGIN + focused.x * STEP, MARGIN + focused.y * STEP);
      }
    }
  }

  const scene = new WorldScene("world-map");
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: root,
    width: 1,
    height: 1,
    transparent: true,
    banner: false,
    autoFocus: false,
    fps: { limit: 30 },
    audio: { noAudio: true },
    scene: [scene],
  });

  // React-панели и прокрутка меняют положение canvas без resize самого canvas.
  // Обновляем границы в capture-фазе, до преобразования координат ввода Phaser.
  function refreshInputBounds(): void {
    game.scale.updateBounds();
  }

  root.addEventListener("mousedown", refreshInputBounds, true);
  root.addEventListener("touchstart", refreshInputBounds, { capture: true, passive: true });

  return {
    render(next) {
      world = next;
      root.dataset.ready = "false";
      scene.drawWorld();
    },
    highlight(nextSelected, nextFocused) {
      selected = nextSelected;
      focused = nextFocused;
      scene.drawMarkers();
    },
    destroy() {
      if (disposed) {
        return;
      }

      disposed = true;
      root.removeEventListener("mousedown", refreshInputBounds, true);
      root.removeEventListener("touchstart", refreshInputBounds, true);
      game.destroy(true);
      root.replaceChildren();
    },
  };
}
