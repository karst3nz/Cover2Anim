---
name: pulsesync-canvas-bg
description: Перенос canvas-анимации из index.html в src/main.ts аддона PulseSync с подменой фона полноэкранного плеера
source: auto-skill
extracted_at: '2026-06-25T19:09:01.453Z'
---

# Подмена фона полноэкранного плеера PulseSync на canvas-анимацию

## Контекст

PulseSync addon (тип `script`) собирается Vite в IIFE-бандл `script.js` + `script.css`.
Точка входа — `src/main.ts`. Никаких собственных `<input type="file">` или контролов
быть не должно — ввод пользователя идёт через настройки аддона (`addon/handleEvents.json`)
или через события клиента (смена трека, смена обложки).

Стандартный фон плеера рисуется псевдоэлементами `::before/::after` контейнера
`div[data-test-id="FULLSCREEN_PLAYER_MODAL"]`. Обложка трека — это
`img[data-test-id="ENTITY_COVER_IMAGE"]` (атрибуты `src` и `srcset`).

## Когда применять

- Есть `<canvas>`-визуализация (lava-lamp, blob, шейдер, размытие), которую нужно
  показать вместо обычного заднего фона.
- Источник палитры/текстуры — обложка текущего трека, а не пользовательский файл.
- Аддон работает в клиенте PulseSync, не как отдельная HTML-страница.

## Процедура

### 1. CSS (добавить в `src/styles.css`)

```css
div[data-test-id="FULLSCREEN_PLAYER_MODAL"].canvas-mode::before,
div[data-test-id="FULLSCREEN_PLAYER_MODAL"].canvas-mode::after {
    display: none !important;
}

.betterplayer-canvas-bg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: -2;
    pointer-events: none;
}
```

`.canvas-mode` навешивается из JS — без него псевдоэлементы останутся поверх canvas.

### 2. Точка входа `src/main.ts`

Структура менеджера `CanvasBackground`:

- **Селекторы выносим в константы** наверх файла:
  `MODAL_SELECTOR = 'div[data-test-id="FULLSCREEN_PLAYER_MODAL"]'`
  `COVER_SELECTOR = 'img[data-test-id="ENTITY_COVER_IMAGE"]'`
- **Конструктор**:
  - создаёт `<canvas class="betterplayer-canvas-bg">`
  - `insertBefore` его в контейнер первым ребёнком
  - добавляет класс `canvas-mode`
  - инициализирует DPR-aware resize, RAF-цикл, `ResizeObserver` (или fallback на `window.resize`)
  - находит текущую обложку и применяет палитру
- **Слежение за сменой трека** — `MutationObserver` с
  `attributes: true, attributeFilter: ['src', 'srcset'], subtree: true, childList: true`.
  На каждое изменение `src` подходящего `<img>` — пересчитать палитру и либо
  `createBlobs` (если ещё пусто), либо `updatePalette` (плавный переход цветов).
- **Lifecycle**: один синглтон `backgroundInstance`. Проверка `document.querySelector(MODAL_SELECTOR)`
  откладывается до появления модалки (DOM может ещё не содержать плеер).
- **Старт**: на `DOMContentLoaded` или сразу, если документ уже готов. Дополнительно
  `MutationObserver` на `document.body` ловит момент появления `FULLSCREEN_PLAYER_MODAL`
  и лениво поднимает инстанс.

### 3. Логирование

Все сообщения обязательно с префиксом `[Cover2Anim]` (или фактическим именем аддона)
через тонкие обёртки `log/warn/error`. Это сильно упрощает дебаг в клиенте,
где в консоли смешиваются сообщения разных аддонов.

### 4. Чего НЕ делать

- Не использовать `fetch + blob URL` для обложки — лишний сетевой запрос, Yandex
  отдаёт нужный CORS сам; достаточно `new Image()` с `img.src`.
- Не использовать напрямую DOM-`<img>` плеера для `drawImage` в canvas без
  `crossOrigin='anonymous'` — canvas станет tainted и `getImageData` упадёт
  с `SecurityError`. Всегда поднимать **отдельный `Image()` с
  `crossOrigin='anonymous'` + `referrerPolicy='no-referrer'`** и тянуть пиксели
  с него.
- Не сбрасывать `blobs.length = 0` при `updatePalette` — иначе не будет плавного
  перехода, и анимация «дёрнется». Сброс только при первой инициализации.
- Не удалять `template/`, `pulsesync.ts`, `index.html`, `podmena.txt` без явной
  просьбы пользователя — они могут быть опорными при отладке, а замечание про
  удаление в коде уже отменялось пользователем.
- Не вешать `MutationObserver` на `document` целиком без `subtree: false` или
  без фильтра — будет шуметь и тратить CPU.

### 5. CORS-обложка и tainted canvas

Обложки с внешних CDN (например `https://avatars.yandex.net/...`) кросс-доменные.
DOM-`<img>` плеера грузится без CORS — использовать его для `drawImage` нельзя,
канвас заtaint'ится. Шаблон безопасной загрузки:

```ts
const corsImage = new Image()
corsImage.crossOrigin = 'anonymous'
corsImage.referrerPolicy = 'no-referrer'
corsImage.onload = () => applyPalette(extractColors(corsImage))
corsImage.onerror = () => applyPalette(FALLBACK_PALETTE)
corsImage.src = img.currentSrc || img.src
```

Дополнительно:

- `extractColors` оборачивается в `try/catch` — при `SecurityError` отдаём
  `FALLBACK_PALETTE` (дефолтная радуга) и пишем `warn`, чтобы аддон не падал.
- В `addon.config.mjs` добавляем хост в `allowedUrls`, иначе PulseSync/Electron
  может блокировать запрос: `allowedUrls: ['https://avatars.yandex.net']`.

### 6. Ленивый старт и ретраи

`FULLSCREEN_PLAYER_MODAL` появляется не сразу. `MutationObserver` на
`document.body` без фильтра может спамить `ensureBackground` на каждое добавление
узла и повесить клиент. Обязательно:

- Константы `RETRY_DELAY_MS = 1500`, `MAX_RETRIES = 10` (~15 с суммарно).
- Хранить `retryTimer` (`number | null`); `ensureBackground` шедулится только
  если таймер не активен. Это убирает двойной шедулинг.
- В обратном вызове `MutationObserver` проверять `retryTimer === null` прежде
  чем звать `ensureBackground`.
- После успешной инициализации — `clearRetry()` и сброс `retriesLeft` до
  `MAX_RETRIES`, чтобы при будущем перезапуске инстанса снова был запас.
- После исчерпания попыток — `warn` и тишина, без бесконечного цикла.

### 7. Диагностический логгер

`error()` должна печатать `Error.message` и `Error.stack` **отдельными строками**
с префиксом — в свёрнутом выводе Chromium иначе теряется, кто бросил.

```ts
function error(message: string, ...args: unknown[]): void {
    console.error(`${LOG_PREFIX} ${message}`, ...args)
    for (const arg of args) {
        if (arg instanceof Error) {
            if (arg.message) console.error(`${LOG_PREFIX}   message:`, arg.message)
            if (arg.stack) console.error(`${LOG_PREFIX}   stack:`, arg.stack)
        }
    }
}
```

При бросании из конструктора `CanvasBackground` (`getContext('2d')` вернул `null`)
полезно класть в `Error.message` диагностические поля: `isConnected`,
`getBoundingClientRect`, к какому `Document` принадлежит элемент — по одной
строке на причину сразу понятно, почему не удалось.

### 8. Сборка и проверка

- `yarn build` кладёт `script.js`, `script.css`, `metadata.json` в `dist/<addonDirectoryName>`.
- Размер CSS минимизируется `esbuild` в release (`minify: 'esbuild'`).
- TypeScript-проверка: `yarn tsc --noEmit` (поле `noEmit: true` в `tsconfig.json`).
- Не запускать `yarn tsc`/dev-build без подтверждения — пользователь отменял shell-команды.

### 9. Настройки аддона через `addon/handleEvents.json`

Пользователь управляет фоном через стандартный экран настроек PulseSync. Схема
живёт в `addon/handleEvents.json`, пользовательские значения — в
`pulsesync.settings.json` (создаёт сам клиент).

В этом проекте сейчас используется **только одна настройка** — `enabled`:

```json
{
    "title": "Cover2Anim",
    "items": [
        { "id": "enabled", "type": "button", "bool": true, "defaultParameter": true }
    ]
}
```

**Важно:** пользователь просил добавить слайдеры (`blobRadius`,
`paletteStrength`, `animationSpeed`, `brightness`, `blur` 0..100, шаг 1), но
после интеграции откатил рендер к исходному — теперь рендер blob'ов жёстко
зашит в коде и **не реагирует** на эти слайдеры. Схема должна описывать только
то, что реально применяется. Не добавлять в `handleEvents.json` поля, которые
в коде мёртвым грузом — это вводит пользователя в заблуждение.

Если позже понадобится снова включить слайдеры:

- `button + bool` — это «включить/выключить».
- Слайдеры всегда 0–100, шаг 1. Маппинг в физические диапазоны — в JS, не в схеме.
- Внутри JS хранить `Cover2AnimSettings` с осмысленными дефолтами и
  `DEFAULT_SETTINGS` рядом как единственный источник правды.
- `pulsesync.ts` уже умеет `readBooleanSetting`/`readStringSetting`. Для чисел
  нужен `readNumberSetting`: достаёт `value` или `default` через `unwrapSetting`,
  парсит `Number(...)` и подменяет фолбэк при `NaN`.
- Подписка через `settingsStore.onChange` — обязательна, иначе слайдеры
  сработают только после перезагрузки.

### 10. Реактивное обновление настроек

Чтение и подписка — в `ensureBackground`, сразу после создания инстанса:

```ts
const settingsStore = getAddonSettings(addonConfig.name)
const initial = readSettings(settingsStore.getCurrent())
backgroundInstance = new CanvasBackground(container, initial)
settingsStore.onChange(next => {
    backgroundInstance?.applySettings(readSettings(next))
})
```

В `CanvasBackground`:

- `private settings: Cover2AnimSettings` (полный набор на будущее) +
  `private disabled: boolean` (флаг ранней остановки).
- `applySettings()` — публичный метод. Если `enabled=false` и аддон ещё не
  выключен — выставляем `disabled = true`, логируем и больше не рисуем.
  На включение обратно полноценный эффект лучше требовать переоткрытия плеера
  (не пересоздавать instance на горячую).

### 11. Чёткое извлечение палитры из обложки

**Анти-паттерн**: эвристики «brightness > 220», «relativeSat > 0.18», доля
светлых пикселей — на белой/светлой обложке они всё равно пропускали
off-white пиксели с краёв (`saturation 50..70`, `brightness ~210`) и давали
**радугу на белой обложке**. Любая попытка «починить» через дополнительные
порога приводит к порочному кругу.

**Правильное решение — детерминированный алгоритм без порогов по типу цвета:**

```ts
const SAMPLE = 150
const GRID = 8                       // сетка 8x8 = 64 ячейки
c.width = SAMPLE; c.height = SAMPLE
x.drawImage(img, 0, 0, SAMPLE, SAMPLE)
const data = x.getImageData(0, 0, SAMPLE, SAMPLE).data

// 1. Средний RGB по каждой ячейке сетки
const cellSize = SAMPLE / GRID
const cells: { r: number; g: number; b: number; sat: number }[] = []
for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
        // усредняем RGB всех пикселей в ячейке
    }
}

// 2. 8 самых насыщенных ячеек (max(r,g,b) - min(r,g,b)) — это кандидаты
const candidates = [...cells].sort((a, b) => b.sat - a.sat).slice(0, 8)

// 3. Кластеризация: RGB d² < 40² ≈ 1600 — сливаем в один кластер
const MERGE_DIST_SQ = 40 * 40
const clusters: typeof cells = []
for (const cell of candidates) {
    let merged = false
    for (const cluster of clusters) {
        const dr = cluster.r - cell.r, dg = cluster.g - cell.g, db = cluster.b - cell.b
        if (dr*dr + dg*dg + db*db < MERGE_DIST_SQ) {
            if (cell.sat > cluster.sat) { /* перезаписать на более насыщенный */ }
            merged = true; break
        }
    }
    if (!merged) clusters.push({ ...cell })
}

// 4. До 6 финальных цветов, отсортированных по насыщенности
const colors = clusters.sort((a, b) => b.sat - a.sat).slice(0, 6)
    .map(c => rgbToHex(Math.round(c.r), Math.round(c.g), Math.round(c.b)))
```

Поведение на разных обложках:

- **Пёстрая яркая** → 6 насыщенных цветов.
- **Чёрно-белая** → серые/белые blob'ы (это честная палитра).
- **Белая** → светло-серые blob'ы. **Никакой радуги** — радуга была
  побочным эффектом эвристик.

Единственный случай, когда возвращается `FALLBACK_PALETTE` (дефолтная радуга) —
`getImageData` бросил `SecurityError` (кросс-домен без CORS).

### 12. Плавный переход палитры при смене трека

`updatePalette(colors)` не должен мапить палитру на blob'ы по индексу
(`colors[i % colors.length]`) — после кластеризации порядок цветов меняется
и blob'ы начнут хаотично «перекрашиваться» в случайные новые цвета.

Правильный алгоритм — **жадный матчинг по RGB-расстоянию**:

```ts
private updatePalette(colors: string[]): void {
    if (this.blobs.length === 0 || colors.length === 0) return

    // Стартовый набор targetColor — растягиваем через модуль
    const initialRgb = this.blobs.map((_, i) =>
        this.hexToRgb(colors[i % colors.length]))
    const newRgb = colors.map(hex => this.hexToRgb(hex))
    const used = new Array<boolean>(newRgb.length).fill(false)

    this.blobs.forEach((blob, i) => {
        let bestIdx = -1, bestDist = Number.POSITIVE_INFINITY
        for (let j = 0; j < newRgb.length; j++) {
            if (used[j]) continue
            const dr = newRgb[j].r - initialRgb[i].r
            const dg = newRgb[j].g - initialRgb[i].g
            const db = newRgb[j].b - initialRgb[i].b
            const dist = dr*dr + dg*dg + db*db
            if (dist < bestDist) { bestDist = dist; bestIdx = j }
        }
        if (bestIdx === -1) bestIdx = i % newRgb.length
        else used[bestIdx] = true
        blob.targetColor = colors[bestIdx]
        blob.colorMix = 0   // запускаем плавный бленд в updateBlobs
    })
}
```

Для максимально плавного визуального перехода три ингредиента:

1. **Длительный бленд** — `PALETTE_FADE_MS = 4000`. Линейный 1.2 с воспринимался
   как «рывок», особенно при сильно отличающихся палитрах. 4 с + smoothstep —
   достаточно медленно, чтобы глаз воспринял как непрерывный поток.
2. **Smoothstep-кривая** вместо линейного `t`:
   ```ts
   const rawT = Math.max(0, Math.min(1, blob.colorMix - blob.colorOffset))
   const t = rawT * rawT * (3 - 2 * rawT)
   ```
   `t²·(3−2t)` убирает резкий старт и резкий финиш — оба конца интервала
   имеют нулевую производную.
3. **Волна вместо синхронной вспышки** — у каждого blob'а свой `colorOffset`:
   ```ts
   colorOffset: (i / count) * 0.8
   ```
   При смене трека все `colorMix` сбрасываются в 0, но `rawT = colorMix - colorOffset`
   означает, что blob №0 стартует сразу, blob №N — с задержкой
   `0.8 · PALETTE_FADE_MS ≈ 3.2 с`. Суммарное время полной смены палитры:
   ~7 с. Переход идёт волной по холсту, а не одновременной вспышкой.

В `Blob`-типе должно быть поле `colorOffset: number`, в `createBlobs` оно
вычисляется как `(i / count) * 0.8`, в `updatePalette` НЕ сбрасывается
(привязано к индексу blob'а, не к смене трека).

В `updateBlobs`:
```ts
blob.colorMix = Math.min(1, blob.colorMix + dt / fadeMs)
const rawT = Math.max(0, Math.min(1, blob.colorMix - blob.colorOffset))
const t = rawT * rawT * (3 - 2 * rawT)
if (t > 0) {
    const currentColor = this.blendHex(blob.color, blob.targetColor, t)
    blob.texture = this.createBlobTexture(currentColor)
}
if (blob.colorMix >= 1) blob.color = blob.targetColor
```

### 13. Алгоритм «какого цвета больше всего» (топ по площади)

Сортировка по **насыщенности** (`max(r,g,b) - min(r,g,b)`) даёт красивую
палитру на пёстрых обложках, но не отражает реальную композицию: если обложка
70% чёрная + 20% красная + 10% белая, по насыщенности побеждает красный, а
должен быть чёрный. Пользователь ожидает именно топ **по занимаемой площади**.

Алгоритм:

```ts
const SAMPLE = 150
const GRID = 8
c.width = SAMPLE; c.height = SAMPLE
x.drawImage(img, 0, 0, SAMPLE, SAMPLE)
const data = x.getImageData(0, 0, SAMPLE, SAMPLE).data

// 1. Средний RGB + вес (количество пикселей) по каждой ячейке 8x8
const cellSize = SAMPLE / GRID
const cells: { r: number; g: number; b: number; weight: number }[] = []
for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
        // усредняем RGB, weight = count пикселей в ячейке
        cells.push({ r, g, b, weight: count })
    }
}

// 2. Сортируем по весу (самые «большие» цвета сверху)
const ordered = [...cells].sort((a, b) => b.weight - a.weight)

// 3. Кластеризация: идём от больших к меньшим, RGB d² < 40² —
//    склеиваем с усреднением по весам, чтобы топ отражал долю площади
const MERGE_DIST_SQ = 40 * 40
type Cluster = { r: number; g: number; b: number; weight: number }
const clusters: Cluster[] = []
for (const cell of ordered) {
    let bestIdx = -1, bestDist = Infinity
    for (let i = 0; i < clusters.length; i++) {
        const dist = (clusters[i].r - cell.r) ** 2 +
                     (clusters[i].g - cell.g) ** 2 +
                     (clusters[i].b - cell.b) ** 2
        if (dist < MERGE_DIST_SQ && dist < bestDist) {
            bestIdx = i; bestDist = dist
        }
    }
    if (bestIdx === -1) {
        clusters.push({ r: cell.r, g: cell.g, b: cell.b, weight: cell.weight })
    } else {
        const c = clusters[bestIdx]
        const total = c.weight + cell.weight
        c.r = (c.r * c.weight + cell.r * cell.weight) / total
        c.g = (c.g * c.weight + cell.g * cell.weight) / total
        c.b = (c.b * c.weight + cell.b * cell.weight) / total
        c.weight = total
    }
}

clusters.sort((a, b) => b.weight - a.weight)
const colors = clusters.slice(0, 6)
    .map(c => rgbToHex(Math.round(c.r), Math.round(c.g), Math.round(c.b)))
```

Ключевое отличие от сортировки по насыщенности — усреднение цвета кластера
**по весам ячеек**, а не по равным долям. Это даёт топ, который отражает
композицию обложки, а не «самые яркие точки».

Поведение:

- Красная обложка (70% / 20% чёрный / 10% белый) → `#cc1a1a`, `#0e0e0e`, `#f0f0f0`.
- Пёстрая с 5 зонами → 5 доминирующих оттенков, близкие слиты.
- Белая → светло-серые/белые (честная палитра, без радуги).

### 14. Настройки — только подстановка в переменные

Если просят добавить настройки в `handleEvents.json` **без смены логики
рендера**, действуем так:

1. Поля в схеме называем как пользовательскую фичу: `blobRadius`, `blobCount`,
   `blur`, `speed`, `brightness`, `paletteFadeMs`.
2. Слайдеры 0–100 или в осмысленных диапазонах (для `blobRadius` 100–500 px,
   для `paletteFadeMs` 500–8000 мс шаг 100). Шаг 1, кроме `paletteFadeMs`.
3. Тип `Cover2AnimSettings` + `DEFAULT_SETTINGS` как единственный источник
   правды по дефолтам.
4. `readSettings()` через `readNumberSetting`/`readBooleanSetting` —
   число парсится из строки и подменяется на дефолт при `NaN`.
5. **Подстановка в существующие переменные**, без новых веток в логике:

```ts
// createBlobs
const count = window.innerWidth < 768
    ? Math.min(6, this.settings.blobCount)
    : Math.min(18, this.settings.blobCount)
const radiusBase = this.settings.blobRadius
// в объекте blob:
radius: radiusBase * 0.6 + Math.random() * radiusBase * 0.4,
currentRadius: radiusBase,

// updateBlobs
const speedFactor = this.settings.speed / 100
this.animationTime += dt * speedFactor
const fadeMs = this.settings.paletteFadeMs
// ...
blob.colorMix = Math.min(1, blob.colorMix + dt / fadeMs)

// draw
const blur = window.innerWidth < 768
    ? Math.min(this.settings.blur, 70)
    : this.settings.blur
const brightnessFactor = BRIGHTNESS_MIN
    + (Math.min(Math.max(this.settings.brightness, 0), 100) / 100)
      * (BRIGHTNESS_MAX - BRIGHTNESS_MIN)
this.ctx.filter = `blur(${blur}px) brightness(${brightnessFactor})`
```

6. Реактивное обновление в `applySettings`:
   - `enabled` — включение/выключение.
   - При изменении `blobRadius` или `blobCount` — `createBlobs(this.basePalette)`
     (пересоздание геометрии, цвета те же — мягкого бленда не нужно).
   - Остальные поля (`blur`, `brightness`, `speed`, `paletteFadeMs`) применяются
     на следующем кадре без пересоздания.

7. **Не** добавлять в `handleEvents.json` поля, которые в коде мёртвым грузом —
   это вводит пользователя в заблуждение. Если после интеграции рендер
   откатывается на зашитые в код константы, нужно либо:
   - реально подставить настройки в переменные (предпочтительно),
   - либо убрать поля из схемы.

## Артефакты интеграции в этом проекте

- `src/main.ts` — менеджер `CanvasBackground` + watcher + логгер с префиксом `[Cover2Anim]`.
- `src/pulsesync.ts` — `readBooleanSetting`, `readStringSetting`, `readNumberSetting`.
- `src/styles.css` — только правила для `canvas-mode` и `.betterplayer-canvas-bg`.
- `addon/handleEvents.json` — секция `Cover2Anim` с настройками `enabled`,
  `blobRadius`, `blobCount`, `blur`, `speed`, `brightness`, `paletteFadeMs`
  (подставляются в переменные рендера, см. п. 14).
- `addon.config.mjs` — `allowedUrls: ['https://avatars.yandex.net']` для CORS-обложек.
