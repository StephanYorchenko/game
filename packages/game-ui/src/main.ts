import { createDemoWorld } from "./demo.js";
import { createMapView } from "./map-view.js";
import "./style.css";

const root = document.getElementById("map");
const size = document.getElementById("map-size");
const summary = document.getElementById("summary");

if (!root || !size || !summary) {
  throw new Error("Не найден контейнер карты");
}

const world = createDemoWorld();
const view = createMapView(root);
view.render(world);
size.textContent = `${world.map.width} × ${world.map.height}`;
const defenders = world.units.filter((unit) => unit.alive && unit.side === "defender").length;
const enemies = world.units.filter((unit) => unit.alive && unit.side === "enemy").length;
summary.textContent = [
  `Защитники: ${defenders}`,
  `Противники: ${enemies}`,
  `Ловушки: ${world.traps.length}`,
].join(" · ");
