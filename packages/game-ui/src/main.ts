import { createMapView } from "./map-view";
import { destroyCellInspector, renderCellInspector } from "./cell-inspector";
import { createScenarioControls } from "./scenario-controls";
import "./style.css";
import { destroyOverlayControls, renderOverlayControls } from "./overlay-controls";

const overlays = document.getElementById("overlay-controls");

if (!overlays) {
  throw new Error("Не найден контейнер диагностических слоёв");
}

const root = document.getElementById("map");
const size = document.getElementById("map-size");
const summary = document.getElementById("summary");
const inspector = document.getElementById("cell-inspector");
const controls = document.getElementById("scenario-controls");
const name = document.getElementById("scenario-name");

if (!root || !size || !summary || !inspector || !controls || !name) {
  throw new Error("Не найден контейнер карты");
}

const view = createMapView(root, {
  onSelect: (selection) => renderCellInspector(inspector, selection),
  onOverlayState(state) {
    renderOverlayControls(overlays, state, (mode) => view.setOverlay(mode));
  },
});
const scenarioControls = createScenarioControls(controls, (world, scenarioName) => {
  view.render(world);
  name.textContent = scenarioName;
  size.textContent = `${world.map.width} × ${world.map.height}`;
  const defenders = world.units.filter((unit) => unit.alive && unit.side === "defender").length;
  const enemies = world.units.filter((unit) => unit.alive && unit.side === "enemy").length;
  summary.textContent = [
    `Защитники: ${defenders}`,
    `Противники: ${enemies}`,
    `Ловушки: ${world.traps.length}`,
  ].join(" · ");
});

import.meta.hot?.dispose(() => {
  scenarioControls.destroy();
  view.destroy();
  destroyCellInspector(inspector);
  destroyOverlayControls(overlays);
});
