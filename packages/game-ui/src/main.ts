import { createDemoWorld } from "./demo";
import { createMapView } from "./map-view";
import { destroyCellInspector, renderCellInspector } from "./cell-inspector";
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

if (!root || !size || !summary || !inspector) {
  throw new Error("Не найден контейнер карты");
}

const world = createDemoWorld();
const view = createMapView(root, {
  onSelect: (selection) => renderCellInspector(inspector, selection),
  onOverlayState(state) {
    renderOverlayControls(overlays, state, (mode) => view.setOverlay(mode));
  },
});
view.render(world);
size.textContent = `${world.map.width} × ${world.map.height}`;
const defenders = world.units.filter((unit) => unit.alive && unit.side === "defender").length;
const enemies = world.units.filter((unit) => unit.alive && unit.side === "enemy").length;
summary.textContent = [
  `Защитники: ${defenders}`,
  `Противники: ${enemies}`,
  `Ловушки: ${world.traps.length}`,
].join(" · ");

import.meta.hot?.dispose(() => {
  view.destroy();
  destroyCellInspector(inspector);
  destroyOverlayControls(overlays);
});
