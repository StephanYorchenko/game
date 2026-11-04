import { getCell, getOccupant } from "@deathwarriors/game-core";
import { createPhaserMap } from "./phaser-map";
import { getOverlayCells } from "./map-overlays";
import type {
  OverlayMode,
  OverlayState,
} from "./map-overlays";
import type {
  Cell,
  Position,
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
const views = new WeakMap<HTMLElement, MapView>();

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
  setOverlay(mode: OverlayMode): void;
  destroy(): void;
}

export interface CellSelection {
  position: Position;
  cell: Cell;
  occupant: ReturnType<typeof getOccupant>;
}

export interface MapViewOptions {
  onSelect?: (selection: CellSelection | null) => void;
  onOverlayState?: (state: OverlayState) => void;
}

/** Принимает корректный WorldState; загрузку неизвестных данных выполняет core. */
export function createMapView(root: HTMLElement, options: MapViewOptions = {}): MapView {
  views.get(root)?.destroy();
  const stage = document.createElement("div");
  stage.className = "map-stage";
  const canvasRoot = document.createElement("div");
  canvasRoot.className = "phaser-map";
  canvasRoot.setAttribute("aria-hidden", "true");
  stage.append(canvasRoot);
  root.replaceChildren(stage);
  const renderer = createPhaserMap(canvasRoot, (position) => {
    buttonAt(position)?.focus({ preventScroll: true });
    select(position);
  });
  let currentWorld: WorldState | null = null;
  let selected: Position | null = null;
  let focused: Position = { x: 0, y: 0 };
  let buttons: HTMLButtonElement[] = [];
  let overlayMode: OverlayMode = "none";

  function updateOverlay(): void {
    const unit = currentWorld && selected ? getOccupant(currentWorld, selected) : undefined;
    const available = unit?.kind === "unit" && unit.alive && unit.position !== null;

    if (!available) {
      overlayMode = "none";
    }

    const cells = currentWorld && available
      ? getOverlayCells(currentWorld, unit, overlayMode)
      : [];

    for (const button of buttons) {
      const base = button.dataset.cellLabel ?? "";
      delete button.dataset.overlay;
      button.setAttribute("aria-label", base);
      button.parentElement?.setAttribute("aria-label", base);
    }

    for (const cell of cells) {
      const button = buttonAt(cell.position);

      if (button) {
        button.dataset.overlay = cell.kind;
        const description = `${button.dataset.cellLabel}; ${cell.label}`;
        button.setAttribute("aria-label", description);
        button.parentElement?.setAttribute("aria-label", description);
      }
    }

    renderer.setOverlay(cells);
    options.onOverlayState?.({ mode: overlayMode, available });
  }

  function samePosition(left: Position | null, right: Position): boolean {
    return left?.x === right.x && left.y === right.y;
  }

  function buttonAt(position: Position): HTMLButtonElement | undefined {
    return currentWorld ? buttons[position.y * currentWorld.map.width + position.x] : undefined;
  }

  function notifySelection(): void {
    updateOverlay();
    const cell = currentWorld && selected ? getCell(currentWorld.map, selected) : undefined;

    if (!currentWorld || !selected || !cell) {
      options.onSelect?.(null);
      return;
    }

    options.onSelect?.({
      position: { ...selected },
      cell,
      occupant: getOccupant(currentWorld, selected),
    });
  }

  function select(position: Position): void {
    if (selected) {
      buttonAt(selected)?.setAttribute("aria-pressed", "false");
    }

    selected = { ...position };
    buttonAt(selected)?.setAttribute("aria-pressed", "true");
    renderer.highlight(selected, focused);
    notifySelection();
  }

  function focus(position: Position): void {
    const button = buttonAt(position);

    if (!button) {
      return;
    }

    const previous = buttonAt(focused);

    if (previous) {
      previous.tabIndex = -1;
    }

    focused = { ...position };
    button.tabIndex = 0;
    renderer.highlight(selected, focused);
  }

  function handleKey(event: KeyboardEvent, position: Position): void {
    const directions: Record<string, Position> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const direction = directions[event.key];

    if (!direction || !currentWorld) {
      return;
    }

    event.preventDefault();
    const next = {
      x: Math.max(0, Math.min(currentWorld.map.width - 1, position.x + direction.x)),
      y: Math.max(0, Math.min(currentWorld.map.height - 1, position.y + direction.y)),
    };
    focus(next);
    buttonAt(next)?.focus({ preventScroll: true });
    buttonAt(next)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const view: MapView = {
    render(world) {
      const restoreFocus = root.contains(document.activeElement);
      currentWorld = world;
      buttons = [];

      if (selected && !getCell(world.map, selected)) {
        selected = null;
      }

      if (!getCell(world.map, focused)) {
        focused = { x: 0, y: 0 };
      }

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
          const tile = document.createElement("button");
          const position = { x, y };
          tile.type = "button";
          tile.tabIndex = samePosition(focused, position) ? 0 : -1;
          tile.setAttribute("aria-pressed", String(samePosition(selected, position)));
          tile.addEventListener("click", () => select(position));
          tile.addEventListener("focus", () => focus(position));
          tile.addEventListener("blur", (event) => {
            if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) {
              renderer.highlight(selected, null);
            }
          });
          tile.addEventListener("keydown", (event) => handleKey(event, position));
          buttons.push(tile);
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
          tile.setAttribute("aria-label", description.join("; "));
          tile.dataset.cellLabel = description.join("; ");
          td.append(tile);
        }
      }

      stage.querySelector("table")?.remove();
      stage.append(table);
      renderer.render(world);
      renderer.highlight(selected, restoreFocus ? focused : null);
      notifySelection();

      if (restoreFocus) {
        buttonAt(focused)?.focus({ preventScroll: true });
      }
    },
    setOverlay(mode) {
      overlayMode = mode;
      updateOverlay();
    },
    destroy() {
      root.replaceChildren();
      currentWorld = null;
      selected = null;
      focused = { x: 0, y: 0 };
      buttons = [];
      notifySelection();
      renderer.destroy();
      views.delete(root);
    },
  };
  views.set(root, view);
  return view;
}
