import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type {
  OverlayMode,
  OverlayState,
} from "./map-overlays";

const roots = new WeakMap<HTMLElement, Root>();
const modes = [
  { value: "none", name: "Без слоя" },
  { value: "attack", name: "Маска атаки" },
  { value: "movement", name: "Проходимость" },
] as const;

export function renderOverlayControls(
  container: HTMLElement,
  state: OverlayState,
  onChange: (mode: OverlayMode) => void,
): void {
  let root = roots.get(container);

  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }

  root.render(
    <>
      <fieldset className="overlay-controls" disabled={!state.available}>
        <legend className="sr-only">Диагностический слой</legend>
        {modes.map(({ value, name }) => (
          <label key={value}>
            <input
              type="radio"
              name="map-overlay"
              value={value}
              checked={state.mode === value}
              onChange={() => onChange(value)}
            />
            {name}
          </label>
        ))}
      </fieldset>
      {!state.available && <p>Выберите живого юнита на карте.</p>}
      {state.mode === "attack" && <p>○ — линия свободна · / — перекрыта</p>}
      {state.mode === "movement" && <p>+ — проходима · × — нет · • — занята</p>}
      <p className="map-note">
        Базовые параметры, без модификаторов контента. Диагностика клетки и геометрии,
        не маршрут и не решение AI.
      </p>
    </>,
  );
}

export function destroyOverlayControls(container: HTMLElement): void {
  roots.get(container)?.unmount();
  roots.delete(container);
}
