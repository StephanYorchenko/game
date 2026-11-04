# Game Core

Ядро организовано по логическим доменам. В каждой папке рядом находятся публичный `index.ts`, тесты `*.test.mjs` и документация `README.md`. Внутренние части одного домена остаются в этой же папке; например, модель состояния и загрузчик сценария относятся к `world`.

| Домен | Содержимое |
| --- | --- |
| [world](src/world/README.md) | Состояние карты, сущностей и загрузка сценария |
| [movement](src/movement/README.md) | Проходимость и допустимые шаги |
| [geometry](src/geometry/README.md) | Маски и supercover |
| [pathfinding](src/pathfinding/README.md) | Кратчайшие пути до позиции действия |
| [random](src/random/README.md) | Seeded RNG |
| [initiative](src/initiative/README.md) | Очередь инициативы |
| [stats](src/stats/README.md) | Характеристики, HP и лечение |
| [execution](src/execution/README.md) | Очередь атомарных эффектов |
| [effects](src/effects/README.md) | Фазовые стеки и независимые снимки |
| [targets](src/targets/README.md) | Селекторы и контекст |
| [operations](src/operations/README.md) | Декларативные операции эффектов |
| [death](src/death/README.md) | Граница смерти и стек DEATH |
| [turn](src/turn/README.md) | Фазы хода и последовательные слоты действий |

`src/index.ts` сохраняет корневой API состояния и движения. Остальные домены доступны через прежние subpath imports, например `@deathwarriors/game-core/death`. Физические пути сборки задаются в exports пакета; потребители не импортируют внутренний `dist/` напрямую.

В исходниках используются короткие относительные импорты: `from "../death"`, `from "./state"`. TypeScript проверяет их в режиме Bundler; после компиляции tsc-alias восстанавливает полные относительные пути в JavaScript и декларациях типов для Node ESM. Дополнительный загрузчик при запуске пакета не требуется. Расширения в exports и готовом dist — часть формата сборки, их не нужно писать в исходных импортах.

`pnpm --filter @deathwarriors/game-core check` проверяет типы, собирает реализацию и запускает все тесты, включая расположенные внутри доменных папок. TypeScript собирает только `.ts`; тесты `.mjs` и README остаются рядом с исходниками и не попадают в runtime-пакет. Общие команды и запуск UI описаны в корневом README репозитория.
