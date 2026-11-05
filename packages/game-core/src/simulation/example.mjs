import { readFile } from "node:fs/promises";
import { createSimulation } from "@deathwarriors/game-core/simulation";

const content = JSON.parse(
  await readFile(new URL("../content/minimal.json", import.meta.url), "utf8"),
);
const scenario = JSON.parse(await readFile(new URL("./example.json", import.meta.url), "utf8"));
const simulation = createSimulation({ seed: 33, content, scenario });
const { snapshot } = simulation.runToEnd();
console.log(
  JSON.stringify(
    {
      status: snapshot.status,
      completedRounds: snapshot.completedRounds,
      turnsTaken: snapshot.turnsTaken,
      defenders: snapshot.world.units
        .filter((unit) => unit.side === "defender" && unit.alive)
        .map((unit) => ({ id: unit.id, hp: unit.stats.hp })),
      events: simulation.getEvents().length,
    },
    null,
    2,
  ),
);

if (snapshot.status === "error") {
  process.exitCode = 1;
}
