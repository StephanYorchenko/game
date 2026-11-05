# Общий ESLint монорепозитория

Точка входа — `eslint.config.mjs` в корне. `pnpm lint` проверяет весь репозиторий,
а не фиксированный список пакетов; новые JS/TS-модули автоматически получают базовые
правила. `pnpm lint:fix` применяет доступные автоматические исправления.

| Конфиг | Область и правила |
| --- | --- |
| base.mjs | Все JS/MJS/CJS/JSX/TS/TSX/MTS/CTS: ESLint recommended, Promise recommended, import recommended, общие правила из комментария ENG-36, двойные кавычки и многострочные блоки. |
| typescript.mjs | Все TS/TSX/MTS/CTS: typescript-eslint recommended, поддержка TS-импортов, naming-convention и остальные уровни warn/error из комментария. |
| react.mjs | Любой JSX/TSX и исходники game-ui: React recommended, jsx-runtime, hooks recommended, правила React и Emotion из комментария. Версия React читается из package.json интерфейса. |
| Корневой конфиг | Node-глобалы только для инструментов, конфигов, тестов и примеров; браузерные глобалы для UI/JSX и browser-тестов. Исключены node_modules, dist, coverage и отчёты тестов во всех пакетах. |

Обычный JS использует no-unused-vars с теми же warn и исключением префикса подчёркивания,
что TypeScript-расширение. В TS базовое правило отключено в пользу расширения.
Отдельные import type допустимы рядом с обычным импортом из того же модуля; реальные
дубли остаются предупреждением. Для no-use-before-define разрешены hoisted function
объявления; переменные и классы сохраняют предупреждение. Это позволяет взаимную
рекурсию компилятора контента и обычные отложенные обработчики.

Запрошенный no-empty-interface сохранён как warn. Более новое recommended-правило
no-empty-object-type продолжает проверять пустые объектные типы, но не дублирует
диагностику интерфейсов. Единственное локальное исключение React относится к неизменяемому
начальному снимку сценария: его useState намеренно не использует setter.

## Зависимости и импорты

Линтер и плагины закреплены в корневом package.json и общем pnpm-lock.yaml.
Используются актуальные npm-релизы, проверенные при реализации ENG-36 (05.11.2026):
ESLint 10.14.0, typescript-eslint 8.72.1, pnpm 12.16.1; Vite обновлён до 8.3.6.
Остальные существующие зависимости пакетов уже соответствовали latest.

TypeScript 7.0.2 остаётся компилятором пакетов и корневым tsc через alias
`@typescript/native`. API линтера использует alias
`typescript: npm:@typescript/typescript6@6.0.2` — актуальный официальный пакет
совместимости: TypeScript 7.0 не предоставляет старый JS API для typescript-eslint.
Это [рекомендованная схема совместного запуска](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0),
а не понижение компилятора до TypeScript 6.

React, import и Emotion пока декларируют старые peer-диапазоны ESLint, поэтому установка
может предупреждать об этих peer dependencies. Правила подключены через официальный
`@eslint/compat`; метаданные чужих пакетов не переписываются. Реальное исполнение
React/hooks/Emotion и проверка import подтверждаются config.test.mjs.
[Официальный адаптер правил](https://eslint.org/blog/2024/05/eslint-compatibility-utilities/).

Resolver использует локальный tsconfig.json только как карту исходников для lint:
короткие относительные пути, корневой API game-core и его доменные входы разрешаются
без предварительной сборки dist. Шаблон @deathwarriors/* покрывает корневой API новых
workspace-пакетов; новые нестандартные subpath exports добавляются в эту карту.
Browser URL /src/* в Playwright также разрешается к настоящему исходнику game-ui;
несуществующий URL остаётся ошибкой, а не исключением из проверки.

## Проверки и CI

`pnpm test:lint` проверяет настоящие диагностики ESLint на небольших примерах,
включая новый workspace-пакет, окружения Node/browser, React/hooks/Emotion, рабочие и
сломанные импорты, а также исключение артефактов сборки.

Локальный `pnpm check` включает lint и test:lint перед проверками пакетов.
В GitHub Actions для PR и master есть **отдельная advisory-джоба lint** с
`continue-on-error: true`: при неуспехе она публикует warning, слияние не блокирует.
Уровни warn/error самих правил сохранены; глобального max-warnings=0 нет.
Core/UI проверяются своими независимыми обязательными джобами без зависимости needs
от lint, а тесты конфигурации запускаются внутри advisory-джобы.
