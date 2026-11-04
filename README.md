# DeathWarriors

Монорепозиторий на pnpm workspaces. Первый пакет — независимое от интерфейса игровое ядро `@deathwarriors/game-core`. Ядро содержит модель состояния и базовые API; браузерный просмотр карты находится в `packages/game-ui`. Правила находятся в [spec/game-rules.md](spec/game-rules.md), порядок работы — в [AGENTS.md](AGENTS.md).

## Начало работы

Нужны Node.js 24 или новее и pnpm 11.25.0 — версия закреплена в `package.json`. При необходимости установить pnpm: `npm install --global pnpm@11.25.0`. Из корня репозитория:

```sh
pnpm install --frozen-lockfile
pnpm --filter @deathwarriors/game-ui exec playwright install chromium
pnpm check
```

`check` выполняет проверки пакетов в порядке зависимостей. Каждый пакет проверяет типы, собирается и запускает тесты. Команда подходит для локальной проверки и CI.

Отдельные команды:

| Команда | Результат |
| --- | --- |
| `pnpm typecheck` | Проверка типов пакетов без записи файлов |
| `pnpm build` | Сборка core (ESM и типы) и браузерного UI в `dist/` пакетов |
| `pnpm test` | Тесты пакетов; предварительно нужна сборка |
| `pnpm --filter @deathwarriors/game-core check` | Полная проверка только игрового ядра |

## Структура

- `packages/game-core/src/` — ядро, без DOM, React, Phaser, Node.js API и графических ассетов. В конфигурации типов доступна только стандартная библиотека ECMAScript.
- `packages/game-core/test/` — проверки пакета в Node.js. Первая проверка загружает публичную точку входа через `exports`, чтобы выявлять ошибки сборки и подключения пакета.
- `tsconfig.base.json` — общие настройки TypeScript; пути исходников и сборки задаются в каждом пакете отдельно.
- `dist/` и `node_modules/` не входят в Git. Все зависимости фиксируются в одном `pnpm-lock.yaml` в корне.
- `packages/game-core/src/index.ts` — публичный API состояния и движения; дополнительные API доступны через `exports` пакета.
- `packages/game-ui/` — браузерный просмотр карты и отдельные Playwright-тесты.

## Автоматические проверки

GitHub Actions выполняет независимые джобы core и UI для каждого PR в `master` и каждого push в `master`. Core проверяет типы, сборку и свои тесты; UI собирает API core и запускает собственные типы, сборку и браузерные тесты в Chromium. Установка зависимостей использует закреплённую версию pnpm и `--frozen-lockfile`. Неуспех проверки типов, сборки или тестов завершает workflow с ошибкой.

Новый коммит отменяет устаревший прогон того же PR. Прогоны `master` независимы и не отменяют друг друга. Workflow также можно запустить вручную через вкладку Actions.

## Добавление модулей

Новый модуль размещается в `packages/<имя>` со своим `package.json` и командами `build`, `typecheck`, `test`, `check`. Шаблон `packages/*` автоматически включает его в workspace и общие команды. Связи между локальными пакетами задаются зависимостями `workspace:*`; модули за пределами ядра не должны добавлять зависимости интерфейса в само ядро.

## Просмотр карты

`pnpm dev:ui` собирает API core и запускает браузерный UI. `pnpm test:ui` запускает только UI-тесты после сборки. Перед первым запуском тестов установите Chromium: `pnpm --filter @deathwarriors/game-ui exec playwright install chromium`. Контракт отображения и границы MVP описаны в [packages/game-ui/README.md](packages/game-ui/README.md).
