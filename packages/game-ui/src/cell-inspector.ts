import type { CellSelection } from "./map-view.js";

const structureNames = {
  wall: "Стена",
  obstacle: "Препятствие",
  door: "Дверь",
  window: "Окно",
};
const openingNames = {
  open: "Открыто",
  closed: "Закрыто",
  destroyed: "Разрушено",
};

type Field = readonly [name: string, value: string | number];

/** Поля сценария всегда выводятся как текст, без интерпретации HTML или контента. */
export function renderCellInspector(root: HTMLElement, selection: CellSelection | null): void {
  const content = document.createDocumentFragment();

  function section(name: string, fields: readonly Field[]): void {
    const heading = document.createElement("h3");
    heading.textContent = name;
    const list = document.createElement("dl");

    for (const [name, value] of fields) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = name;
      description.textContent = String(value);
      list.append(term, description);
    }

    content.append(heading, list);
  }

  if (!selection) {
    const hint = document.createElement("p");
    hint.textContent = "Выберите клетку на карте. " +
      "Стрелки перемещают фокус, Enter или пробел выбирают.";
    root.replaceChildren(hint);
    return;
  }

  const { position, cell, occupant } = selection;
  section(`Клетка (${position.x}, ${position.y})`, [
    ["Поверхность", cell.surface === "floor" ? "Пол" : "Грунт"],
    ["Область", cell.area === "inside" ? "Внутри здания" : "Снаружи здания"],
  ]);

  const structure = cell.structure;

  if (structure) {
    const fields: Field[] = [["ID", structure.id]];

    if (structure.kind === "obstacle") {
      fields.push(
        ["Блокирует движение", structure.blocksMovement ? "Да" : "Нет"],
        ["Блокирует атаку", structure.blocksAttack ? "Да" : "Нет"],
      );
    } else if (structure.kind === "door" || structure.kind === "window") {
      fields.push(["Состояние", openingNames[structure.state]]);
    }

    section(structureNames[structure.kind], fields);

    if (
      (structure.kind === "door" || structure.kind === "window") &&
      structure.reinforcement
    ) {
      section("Укрепление", [
        ["HP", `${structure.reinforcement.hp} / ${structure.reinforcement.maxHP}`],
        ["Сопротивление", structure.reinforcement.resistance],
      ]);
    }
  } else {
    section("Структура", [["Состояние", "Нет"]]);
  }

  if (occupant?.kind === "unit" && occupant.alive) {
    section("Юнит", [
      ["ID", occupant.id],
      ["definitionId", occupant.definitionId],
      ["Сторона", occupant.side === "defender" ? "Защитник" : "Противник"],
      ["HP", `${occupant.stats.hp} / ${occupant.stats.maxHP}`],
      ["Сопротивление", occupant.stats.resistance],
      ["Сила", occupant.stats.strength],
      ["Ловкость", occupant.stats.agility],
      ["Урон", occupant.stats.damage],
      ["Движение", occupant.stats.movement],
      ["Ключевые слова", occupant.keywords.join(", ") || "Нет"],
    ]);
  } else if (occupant?.kind === "trap") {
    section("Ловушка", [["ID", occupant.id], ["definitionId", occupant.definitionId]]);
  } else {
    section("Сущности", [["Состояние", "Клетка свободна"]]);
  }

  root.replaceChildren(content);
}
