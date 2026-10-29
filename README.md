# MusicLoader

Учебная основа расширения Google Chrome на Manifest V3: компактный popup в тёмной теме, демонстрационные треки и очередь с имитацией загрузок.

Стек: React, TypeScript strict, Rsbuild, Tailwind CSS, Sass/SCSS, оригинальные компоненты shadcn/ui, Zustand и Lucide React. Проект собирается напрямую через Rsbuild, без фреймворка для расширений.

**Аудиофайлы не скачиваются.** Треки и прогресс демонстрационные. Интеграция с API Звука, авторизация, воспроизведение и обход DRM не реализованы.

## Быстрый старт

Требуются Node.js **22.18 или новее**, npm и Chrome **120 или новее**. Выполните из корня проекта:

```sh
npm install
npm run dev
```

Откройте [http://127.0.0.1:3000/popup.html](http://127.0.0.1:3000/popup.html). Это удобный браузерный предпросмотр интерфейса с обновлением при изменении исходников. Chrome Messaging API в обычной вкладке отсутствует; интерфейс работает в демонстрационном режиме.

После установки зависимостей `package-lock.json` фиксирует версии; для повторяемой установки используйте `npm ci`.

## Сборка и установка в Chrome

```sh
npm run typecheck
npm test
npm run build
```

Команда `build` создаёт production-файлы в `dist/` и запускает проверку расширения. Папка `dist/` — готовый каталог для установки:

1. Откройте `chrome://extensions`.
2. Включите «Режим разработчика».
3. Нажмите «Загрузить распакованное расширение».
4. Выберите **папку `dist`**, а не корень проекта.
5. Закрепите MusicLoader через меню расширений и откройте popup.

Для разработки непосредственно в Chrome:

```sh
npm run dev:extension
```

Эта команда пересобирает расширение в `dist/` при изменениях, используя development-сборку с source maps. После изменений нажмите «Обновить» у расширения на `chrome://extensions` и снова откройте popup. Если менялся content script, обновите также вкладку Звука. HMR-клиент в сборку расширения не включается.

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Предпросмотр popup через сервер Rsbuild |
| `npm run dev:extension` | Development-сборка расширения в режиме наблюдения |
| `npm run typecheck` | Проверка TypeScript без генерации файлов |
| `npm test` | Тесты через Node.js и `tsx` |
| `npm run build` | Production-сборка и проверка её результата |
| `npm run validate:extension` | Повторная проверка уже собранной папки `dist/` |
| `npm run test:browser` | Автоматическая проверка в отдельном временном профиле браузера |

## Как работает демонстрация

При открытии уже есть три примера: ожидающая задача, завершённая и ошибочная. Добавьте другой демотрек кнопкой в карточке; соседняя кнопка переключает трек. Приложение последовательно имитирует изменение прогресса и переходы между состояниями `pending`, `downloading`, `completed` и `error`. Задачу можно удалить, завершённые задачи — очистить, ошибочную — повторить. Кнопка паузы останавливает исполнение, а фильтры показывают все, незавершённые или готовые задачи.

«На своей волне» намеренно получает ошибку на 42% при первой попытке; повтор завершается успешно. Это воспроизводимый демонстрационный сценарий, а не ошибка соединения.

Очередь живёт **только в контексте открытого popup**. Закрытие окна останавливает демонстрационные таймеры; при следующем открытии состояние создаётся заново. Очередь не сохраняется на диск и не продолжает работать в service worker. Это сознательное ограничение текущего учебного этапа.

## Структура

```text
src/
├── app/                        # Корневое приложение и точка входа popup
├── components/
│   ├── ui/                     # Примитивы, добавленные через shadcn CLI
│   └── <Component>/            # Составной компонент: TSX + SCSS + index.ts
├── features/
│   └── downloads/              # Очередь, её компоненты, hooks и Zustand store
├── entrypoints/
│   ├── background/index.ts     # Service worker Manifest V3
│   └── content/index.ts        # Скрипт в DOM страницы Звука
├── shared/
│   ├── lib/                   # Общие утилиты, включая cn()
│   └── messaging/             # Типы и работа с Chrome Messaging API
└── styles/globals.css         # Tailwind, базовые стили и токены тёмной темы
public/manifest.json           # Manifest с фиксированными путями к скриптам
components.json               # Конфигурация shadcn CLI
rsbuild.config.ts             # Отдельные окружения сборки
tsconfig.json                 # Strict TypeScript и алиас @/
```

### Границы ответственности

* `components/ui` содержит готовые UI-примитивы: кнопки, карточки, индикаторы и другие элементы shadcn/ui. Их стили используют Tailwind и стандартные варианты библиотеки.
* Собственные составные компоненты отвечают за композицию и отображение. Каждый самостоятельный визуальный компонент имеет свой БЭМ-блок и расположенный рядом SCSS-файл.
* Hooks, services и Zustand store содержат поведение и бизнес-логику. UI не должен самостоятельно управлять Chrome Messaging API или демонстрационным таймером очереди.
* `shared` содержит используемые в нескольких местах типы и небольшие утилиты. Отдельные слои ради будущей функциональности не создаются.

## Компоненты и стили

Используйте **shadcn/ui**, когда нужен стандартный примитив: Button, Card, Badge, Progress, Dialog и подобные элементы. Добавление нового примитива:

```sh
npx shadcn@latest add dialog
```

CLI читает `components.json` и записывает исходники в `src/components/ui/`. Установленные здесь Button, Card, Badge, Progress, Tabs, Dialog и Tooltip получены официальным CLI; импорты `cn()` адаптированы к `@/shared/lib/utils`, подписи закрытия переведены, а Progress передаёт значение и в доступный Radix Root. При добавлении нового компонента проверьте импорт `cn`: актуальный CLI может импортировать одноимённый npm-пакет напрямую. Компоненты остаются обычными исходниками проекта. Не создавайте для каждого примитива SCSS-файл и не переписывайте его Tailwind-стили на БЭМ.

Используйте **БЭМ + SCSS**, когда создаёте составную часть интерфейса. Например:

```text
src/components/TrackSummary/
├── TrackSummary.tsx
├── TrackSummary.scss
└── index.ts
```

```tsx
// TrackSummary.tsx
import { Badge } from '@/components/ui/badge';
import './TrackSummary.scss';

interface TrackSummaryProps {
  title: string;
  artist: string;
}

export function TrackSummary({ title, artist }: TrackSummaryProps) {
  return (
    <article className="track-summary">
      <h3 className="track-summary__title">{title}</h3>
      <p className="track-summary__artist">{artist}</p>
      <Badge variant="secondary">Демо</Badge>
    </article>
  );
}
```

```scss
// TrackSummary.scss
.track-summary {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);

  &__title {
    color: var(--foreground);
    font-weight: 600;
  }

  &__artist {
    color: var(--muted-foreground);
  }
}
```

В `index.ts` экспортируйте компонент. Классы пишутся в kebab-case: блок `track-summary`, элемент `track-summary__title`, модификатор `track-summary--active`. Вложенные элементы вроде `track-summary__body__title` не используются. SCSS одного блока не должен менять внутреннее устройство другого самостоятельного компонента.

Специфичные стили составных компонентов задавайте в SCSS, без Tailwind utility-классов в их JSX. Готовые примитивы shadcn/ui можно использовать внутри этих компонентов напрямую.

`globals.css` хранит Tailwind-директивы, базовые правила и CSS-переменные общей тёмной темы. Компонентный SCSS использует эти переменные. Tailwind обрабатывается через PostCSS отдельно от Sass.

## Zustand и очередь

Store расположен в `src/features/downloads/store/`. Задача содержит `id`, `title`, `artist`, `progress` и `status`:

```ts
type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error';
```

Основные действия:

| Действие | Назначение |
| --- | --- |
| `addTask` | Добавить задачу |
| `removeTask` | Удалить задачу по идентификатору |
| `updateProgress` | Обновить прогресс |
| `updateStatus` | Изменить статус |
| `clearCompleted` | Удалить завершённые задачи |

Повтор ошибочной задачи возвращает её в очередь. Демонстрационное выполнение организовано отдельно от отображения списка; компоненты читают нужные значения через селекторы Zustand. Счётчики, фильтрованные списки и другие производные значения вычисляются из задач, а не дублируются в store.

Zustand не синхронизирует разные JavaScript-контексты. Store popup не доступен автоматически ни background, ни content script. Для будущей общей очереди потребуется явно определить владельца состояния, протокол сообщений и сохранение; текущая демонстрация этого не делает.

## Background, content script и сообщения

Три точки входа собираются независимо:

| Контекст | Роль | Формат |
| --- | --- | --- |
| Popup | React-интерфейс и локальная очередь | `popup.html`, JS и CSS |
| Background | Обработчик сообщений и посредник между popup и вкладкой | `background/background.js`, отдельный скрипт для web worker |
| Content script | Чтение доступного DOM-контекста страницы | `content/content.js`, самостоятельный классический скрипт |

Скрипты, на которые ссылается Manifest, имеют стабильные имена. Background не содержит React, DOM-зависимостей или общего runtime popup; content script не требует загрузки дополнительных чанков. Production-код минифицируется, а сборка расширения не использует `eval` или удалённые скрипты.

Обмен сообщениями использует нативные `chrome.runtime.sendMessage`, `chrome.runtime.onMessage` и `chrome.tabs.sendMessage`:

1. Popup отправляет `PING` в background для проверки соединения.
2. Popup запрашивает `GET_ACTIVE_PAGE`; background находит активную вкладку и передаёт `READ_PAGE_CONTEXT` её content script.
3. Content script возвращает заголовок документа и origin. При запуске он также отправляет `CONTENT_READY` в background.

Сообщения типизированы в `shared/messaging`. Отсутствие content script на активной вкладке — обычное состояние: popup продолжает показывать демонстрационные данные. Название реального трека из плеера сейчас не извлекается.

Content script объявлен статически для `https://*.zvuk.com/*`; этот шаблон включает и корневой домен `https://zvuk.com/`. Он работает в изолированном контексте расширения и читает DOM, не обращаясь к API музыкального сервиса. Доступ к произвольным сайтам не запрашивается. Разрешения `downloads`, `storage` и `tabs` для текущей функциональности не требуются.

## Проверка результата

Автоматические проверки запускаются командами `npm run typecheck`, `npm test` и `npm run build`. Отдельная `npm run validate:extension` проверяет собранные файлы и ссылки Manifest. Эти проверки не заменяют запуск расширения в Chrome.

Браузерный сценарий запускается после сборки. По умолчанию используется Playwright Chromium:

```sh
npx playwright install chromium
npm run test:browser
```

Можно использовать установленный актуальный Google Chrome; пример для PowerShell:

```powershell
$env:MUSICLOADER_BROWSER_CHANNEL = 'chrome'
npm run test:browser
```

Сценарий загружает `dist` в отдельный временный профиль через [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked), открывает страницу popup, проверяет service worker, сообщения, реальные content scripts на HTML-заглушке, действия очереди, окно справки и предпросмотр без Chrome API. Снимки сохраняются в `artifacts/`. Файлы не скачиваются; запросы к странице Звука перехватываются локальной заглушкой, API сервиса не вызывается.

При создании проекта 29.10.2026 выполнены TypeScript strict, 19 тестов, production-сборка и проверка Manifest. Development-сборка проверена отдельно: source maps присутствуют, HMR runtime отсутствует. В Google Chrome 156 проверены страница popup установленного расширения, MV3 worker, messaging, очередь, стили и ширина 320 px; также проверено отображение через сервер `npm run dev`. Реальная страница сервиса и открытие из кнопки панели Chrome остаются для ручной проверки.

`npm audit` сообщает о двух связанных предупреждениях низкой важности в инструментах сборки (`@rsbuild/plugin-sass` → `deepmerge`); автоматическое исправление предлагает несовместимое понижение Sass-плагина. Оно не применяется. Эти пакеты не включаются в расширение.

Ручная проверка после установки:

* На `chrome://extensions` нет ошибок загрузки Manifest и service worker.
* Popup открывается, тёмная тема, шрифты, карточки и иконки отображаются корректно.
* Добавление, прогресс, удаление, очистка завершённых и повтор после ошибки работают.
* При пустой очереди отображается пустое состояние.
* Управление доступно с клавиатуры, фокус заметен, длинные названия не ломают окно.
* На открытой странице Звука доступен обмен сообщениями с content script. После установки расширения обновите уже открытую страницу.
* На другой странице popup корректно остаётся в демонстрационном режиме.
* После закрытия и открытия popup очередь создаётся заново согласно текущей модели.

Если браузерная проверка не проводилась в вашей среде, её нельзя считать выполненной только по успешной сборке.

## Документация

* [Rsbuild: сборка нескольких окружений](https://rsbuild.rs/guide/advanced/environments)
* [shadcn/ui: установка в существующий проект](https://ui.shadcn.com/docs/installation/manual)
* [Tailwind CSS: интеграция через PostCSS](https://tailwindcss.com/docs/installation/using-postcss)
* [Zustand](https://zustand.docs.pmnd.rs/)
* [Chrome: обмен сообщениями](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
* [Chrome: content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
