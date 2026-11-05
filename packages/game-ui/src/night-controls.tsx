import { createRoot } from "react-dom/client";
import { createSimulation } from "@deathwarriors/game-core/simulation";
import type {
  SimulationSession,
  SimulationSnapshot,
  SimulationUpdate,
} from "@deathwarriors/game-core/simulation";
import type { JournalEntry } from "@deathwarriors/game-core/journal";
import type { WorldState } from "@deathwarriors/game-core";
import demo from "./night-demo.json?raw";

const PAGE_SIZE = 50;
const TURN_DELAY = 350;
const statusNames = {
  running: "Ночь идёт",
  completed: "Ночь завершена",
  defeat: "Поражение",
  error: "Ошибка симуляции",
};

/** Таймер задаёт только темп показа; один тик вызывает полный ход публичного API core. */
export function createNightControls(
  container: HTMLElement,
  onWorld: (world: WorldState, name: string) => void,
): { pause(): void; clear(): void; destroy(): void } {
  const root = createRoot(container);
  let session: SimulationSession | null = null;
  let snapshot: SimulationSnapshot | null = null;
  let events: readonly JournalEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playing = false;
  let disposed = false;
  let requestVersion = 0;
  let name = "";
  let error = "";
  let page: number | null = null;

  function stop(): void {
    playing = false;
    clearTimeout(timer);
    timer = undefined;
  }

  function show(update: SimulationUpdate, replace = false): void {
    snapshot = update.snapshot;
    events = replace ? update.events : [...events, ...update.events];

    if (snapshot.status !== "running") {
      stop();
    }

    onWorld(snapshot.world, name);
    render();
  }

  function step(): void {
    if (!session || snapshot?.status !== "running" || disposed) {
      return;
    }

    show(session.step());
  }

  function schedule(): void {
    timer = setTimeout(() => {
      timer = undefined;

      if (!playing || disposed) {
        return;
      }

      step();

      if (playing) {
        schedule();
      }
    }, TURN_DELAY);
  }

  function load(json: string, nextName: string): void {
    // Некорректный вход не заменяет уже принятую сессию и её журнал.
    const next = createSimulation(JSON.parse(json));
    stop();
    session = next;
    name = nextName;
    error = "";
    page = null;
    show({ snapshot: next.getSnapshot(), events: next.getEvents() }, true);
  }

  async function loadFile(file: File): Promise<void> {
    const version = ++requestVersion;
    stop();
    render();

    try {
      const json = await file.text();

      if (disposed || version !== requestVersion) {
        return;
      }

      load(json, file.name);
    } catch (reason) {
      if (disposed || version !== requestVersion) {
        return;
      }

      error = reason instanceof Error ? reason.message : "Не удалось прочитать JSON ночи";
      render();
    }
  }

  function render(): void {
    if (disposed) {
      return;
    }

    const canStep = snapshot?.status === "running";
    const lastPage = Math.max(0, Math.ceil(events.length / PAGE_SIZE) - 1);
    const currentPage = Math.min(page ?? lastPage, lastPage);
    const visible = events.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    root.render(
      <>
        <div className="scenario-controls" role="group" aria-label="Управление ночью">
          <button type="button" onClick={() => {
            requestVersion++;
            load(demo, "Демо ночи · дверь и ловушка");
          }}>Демо ночи</button>
          <label className="file-control">
            Загрузить JSON ночи
            <input type="file" accept=".json,application/json" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";

              if (file) {
                void loadFile(file);
              }
            }} />
          </label>
          <button type="button" disabled={!canStep || playing} onClick={step}>Шаг</button>
          <button type="button" disabled={!canStep || playing} onClick={() => {
            if (playing || snapshot?.status !== "running") {
              return;
            }

            playing = true;
            schedule();
            render();
          }}>Пуск</button>
          <button type="button" disabled={!playing} onClick={() => {
            stop();
            render();
          }}>Пауза</button>
          <button type="button" disabled={!session} onClick={() => {
            requestVersion++;
            stop();
            error = "";
            page = null;

            if (session) {
              show(session.reset(), true);
            }
          }}>Сброс ночи</button>
        </div>
        <p className="night-status" aria-live="polite" data-status={snapshot?.status ?? "idle"}>
          {snapshot
            ? statusNames[snapshot.status]
              + (canStep ? ` · ${playing ? "Пуск" : "Пауза"}` : "")
            : "Откройте демо ночи или JSON с seed, content и scenario."}
        </p>
        {snapshot && <dl className="night-facts">
          <div><dt>Seed</dt><dd>{snapshot.seed}</dd></div>
          <div><dt>Раунд</dt><dd data-testid="night-round">{snapshot.round}</dd></div>
          <div>
            <dt>Ходов завершено</dt>
            <dd data-testid="night-turns">{snapshot.turnsTaken}</dd>
          </div>
          <div>
            <dt>Следующий юнит</dt>
            <dd data-testid="night-next">{snapshot.nextUnitId ?? "—"}</dd>
          </div>
          <div><dt>Последний ход</dt><dd>{snapshot.lastTurn?.ownerId ?? "—"}</dd></div>
        </dl>}
        <p className="scenario-error" role="alert" hidden={!error && !snapshot?.error}>
          {error || snapshot?.error?.message}
        </p>
        <details className="night-journal">
          <summary>Журнал событий · <span data-testid="event-count">{events.length}</span></summary>
          <p className="map-note">Полный диагностический журнал core, включая внутренние данные.</p>
          <div className="scenario-controls" role="group" aria-label="Страницы журнала">
            <button type="button" disabled={currentPage === 0} onClick={() => {
              page = currentPage - 1;
              render();
            }}>Раньше</button>
            <span>Страница {currentPage + 1} / {lastPage + 1}</span>
            <button type="button" disabled={currentPage === lastPage} onClick={() => {
              page = currentPage + 1;
              render();
            }}>Позже</button>
            <button type="button" disabled={page === null} onClick={() => {
              page = null;
              render();
            }}>Последние события</button>
          </div>
          <ol className="event-list" aria-label="События core">
            {visible.map((entry) => (
              <li key={entry.sequence} data-event-sequence={entry.sequence}>
                <details>
                  <summary>
                    #{entry.sequence} · {entry.kind} · раунд {entry.scope.round ?? "—"}
                    {entry.scope.ownerId && ` · ${entry.scope.ownerId}`}
                  </summary>
                  <pre>{JSON.stringify(entry, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      </>,
    );
  }

  render();

  function clear(): void {
    requestVersion++;
    stop();
    session = null;
    snapshot = null;
    events = [];
    error = "";
    page = null;
    render();
  }

  return {
    pause() {
      requestVersion++;
      stop();
      render();
    },
    clear,
    destroy() {
      if (disposed) {
        return;
      }

      clear();
      disposed = true;
      root.unmount();
    },
  };
}
