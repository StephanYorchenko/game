import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChangeEvent } from "react";
import {
  parseWorld,
  ScenarioValidationError,
  serializeWorld,
} from "@deathwarriors/game-core";
import type { WorldState } from "@deathwarriors/game-core";
import { createDemoWorld } from "./demo";

interface ScenarioControlsProps {
  onWorld: (world: WorldState, name: string) => void;
}

function ScenarioControls({ onWorld }: ScenarioControlsProps) {
  const [initialWorld] = useState(createDemoWorld);
  const [error, setError] = useState("");
  const world = useRef(initialWorld);
  const requestVersion = useRef(0);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    onWorld(initialWorld, "Дом у опушки");

    return () => {
      active.current = false;
      requestVersion.current++;
    };
  }, [initialWorld, onWorld]);

  function show(next: WorldState, name: string): void {
    onWorld(next, name);
    world.current = next;
    setError("");
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    event.currentTarget.value = "";
    const version = ++requestVersion.current;

    try {
      const json = await file.text();

      if (!active.current || version !== requestVersion.current) {
        return;
      }

      show(parseWorld(json), file.name);
    } catch (error) {
      if (!active.current || version !== requestVersion.current) {
        return;
      }

      setError(error instanceof ScenarioValidationError
        ? error.message
        : "Не удалось прочитать файл. Выберите его ещё раз.");
    }
  }

  function reset(): void {
    requestVersion.current++;
    show(createDemoWorld(), "Дом у опушки");
  }

  function download(): void {
    const blob = new Blob([serializeWorld(world.current)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "deathwarriors-scenario.json";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <>
      <div className="scenario-controls" role="group" aria-label="Сценарий карты">
        <label className="file-control">
          Открыть JSON
          <input type="file" accept=".json,application/json" onChange={loadFile} />
        </label>
        <button type="button" onClick={download}>Скачать JSON</button>
        <button type="button" onClick={reset}>Вернуть демо</button>
      </div>
      <p className="scenario-error" role="alert" hidden={!error}>{error}</p>
    </>
  );
}

export function createScenarioControls(
  container: HTMLElement,
  onWorld: ScenarioControlsProps["onWorld"],
): { destroy(): void } {
  const root = createRoot(container);
  root.render(<ScenarioControls onWorld={onWorld} />);

  return {
    destroy() {
      root.unmount();
    },
  };
}
