import { getCell, getOccupant } from "@deathwarriors/game-core";
import type {
  Structure,
  WorldState,
} from "@deathwarriors/game-core";

const structureNames = {
  wall: "Стена",
  obstacle: "Препятствие",
  door: "Дверь",
  window: "Окно",
};
const openingNames = { open: "открыто", closed: "закрыто", destroyed: "разрушено" };
const openingMarks = { open: "О", closed: "З", destroyed: "Р" };

function label(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function drawStructure(tile: HTMLElement, structure: Structure): string {
  const name = structureNames[structure.kind];
  tile.dataset.structure = structure.kind;

  if (structure.kind === "wall" || structure.kind === "obstacle") {
    tile.append(label(`structure ${structure.kind}`, structure.kind === "wall" ? "▦" : "◆"));
    return `${name}: ${structure.id}`;
  }

  tile.dataset.state = structure.state;
  const mark = structure.kind === "door" ? "Д" : "О";
  tile.append(label("structure opening", `${mark}·${openingMarks[structure.state]}`));
  let description = `${name}: ${structure.id}, ${openingNames[structure.state]}`;

  if (structure.reinforcement) {
    const { hp, maxHP } = structure.reinforcement;
    tile.append(label("reinforcement", `+ ${hp}/${maxHP}`));
    description += `, укрепление ${hp}/${maxHP}`;
  }

  return description;
}

export interface MapView {
  render(world: WorldState): void;
  destroy(): void;
}

/** Принимает корректный WorldState; загрузку неизвестных данных выполняет core. */
export function createMapView(root: HTMLElement): MapView {
  return {
    render(world) {
      const table = document.createElement("table");
      table.className = "map-grid";
      const caption = document.createElement("caption");
      caption.className = "sr-only";
      caption.textContent = `Карта ${world.map.width} × ${world.map.height}`;
      table.append(caption);
      const head = table.createTHead().insertRow();
      head.append(document.createElement("td"));

      for (let x = 0; x < world.map.width; x++) {
        const heading = document.createElement("th");
        heading.scope = "col";
        heading.textContent = String(x);
        head.append(heading);
      }

      const body = table.createTBody();

      for (let y = 0; y < world.map.height; y++) {
        const row = body.insertRow();
        const heading = document.createElement("th");
        heading.scope = "row";
        heading.textContent = String(y);
        row.append(heading);

        for (let x = 0; x < world.map.width; x++) {
          const cell = getCell(world.map, { x, y });

          if (!cell) {
            throw new Error(`В WorldState отсутствует клетка (${x}, ${y})`);
          }

          const td = row.insertCell();
          const tile = document.createElement("div");
          tile.className = `tile ${cell.surface} ${cell.area}`;
          td.dataset.x = String(x);
          td.dataset.y = String(y);
          const description = [
            `(${x}, ${y})`,
            cell.surface === "floor" ? "Пол" : "Грунт",
            cell.area === "inside" ? "Внутри здания" : "Снаружи здания",
          ];

          if (cell.structure) {
            description.push(drawStructure(tile, cell.structure));
          }

          const occupant = getOccupant(world, { x, y });

          if (occupant?.kind === "unit" && occupant.alive) {
            const defender = occupant.side === "defender";
            tile.dataset.occupant = occupant.id;
            tile.append(label(`token ${occupant.side}`, defender ? "З" : "В"));
            tile.append(label("unit-hp", `${occupant.stats.hp}/${occupant.stats.maxHP}`));
            description.push(
              `${defender ? "Защитник" : "Противник"}: ${occupant.id}`,
              `HP ${occupant.stats.hp}/${occupant.stats.maxHP}`,
            );
          } else if (occupant?.kind === "trap") {
            tile.dataset.occupant = occupant.id;
            tile.append(label("trap", "×"));
            description.push(`Ловушка: ${occupant.id}`);
          }

          td.setAttribute("aria-label", description.join("; "));
          tile.title = description.join("; ");
          tile.setAttribute("aria-hidden", "true");
          td.append(tile);
        }
      }

      root.replaceChildren(table);
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
