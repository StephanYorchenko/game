import { createDemoWorld } from "./demo";
import { createMapView } from "./map-view";
import { destroyCellInspector, renderCellInspector } from "./cell-inspector";
import "./style.css";

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
});
