import { Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { CellSelection } from "./map-view";

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
interface InspectorSection {
  name: string;
  fields: readonly Field[];
}

const roots = new WeakMap<HTMLElement, Root>();

function CellInspector({ selection }: { selection: CellSelection | null }) {
  if (!selection) {
    return <p>Выберите клетку на карте. Стрелки перемещают фокус, Enter или пробел выбирают.</p>;
  }

  const sections: InspectorSection[] = [];

  function section(name: string, fields: readonly Field[]): void {
    sections.push({ name, fields });
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

  return sections.map(({ name, fields }) => (
    <section key={name}>
      <h3>{name}</h3>
      <dl>
        {fields.map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  ));
}

/** React экранирует значения сценария; один root переиспользуется между снимками. */
export function renderCellInspector(root: HTMLElement, selection: CellSelection | null): void {
  let reactRoot = roots.get(root);

  if (!reactRoot) {
    reactRoot = createRoot(root);
    roots.set(root, reactRoot);
  }

  reactRoot.render(<CellInspector selection={selection} />);
}

export function destroyCellInspector(root: HTMLElement): void {
  roots.get(root)?.unmount();
  roots.delete(root);
}
