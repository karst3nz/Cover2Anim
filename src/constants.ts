// Все настраиваемые параметры аддона собраны здесь.
// Меняйте значения в этом файле, чтобы подстроить поведение canvas-фона
// (число blob'ов, скорость анимации, размеры текстур, шаги сэмплирования и т.д.)
// без необходимости лезть в логику CanvasBackground.

// --- DOM-селекторы модалки полноэкранного плеера ---
const MODAL_SELECTOR = 'div[data-test-id="FULLSCREEN_PLAYER_MODAL"]'
const POSTER_CONTENT_SELECTOR = '[data-test-id="FULLSCREEN_PLAYER_POSTER_CONTENT"]'
const COVER_SELECTOR = 'img[data-test-id="ENTITY_COVER_IMAGE"]'

// --- Палитра по умолчанию (применяется до загрузки обложки через CORS). ---
const FALLBACK_PALETTE = ['#ff3366', '#ff8800', '#ffcc00', '#00ccff', '#4466ff', '#aa00ff']

// Цвет фона до первого applyPalette и для случаев, когда CORS-загрузка обложки упала.
const INITIAL_BACKGROUND_COLOR = '#050505'

// --- Тайминги ---
// Время (мс) полного бленда палитры blob'ов и фона при смене обложки.
const PALETTE_FADE_MS = 1800
// Допустимый диапазон slider'а в UI PulseSync (handleEvents.json → paletteFadeMs: min=0, max=5000).
const PALETTE_FADE_MS_MIN = 0
const PALETTE_FADE_MS_MAX = 5000
// Допустимый диапазон slider'а в UI PulseSync (handleEvents.json → paletteBlendSpeed: min=0.5, max=3).
const PALETTE_BLEND_SPEED_MIN = 0.5
const PALETTE_BLEND_SPEED_MAX = 3

// Начальное значение lastDt для первого кадра RAF, пока time ещё не накоплен.
const INITIAL_FRAME_DELTA_MS = 16

// Задержка между попытками найти модалку, если её ещё нет в DOM.
const RETRY_DELAY_MS = 1500
const MAX_RETRIES = 100

// Debounce на смену src обложки: карусели/превью часто дёргают src раз в 50–200 мс,
// ждём «тишины» и грузим только последнюю обложку.
const COVER_DEBOUNCE_MS = 200

// FPS-счётчик обновляет textContent не каждый кадр, а раз в этот интервал —
// иначе reflow DOM съест несколько процентов FPS.
const FPS_UPDATE_INTERVAL_MS = 500

// --- Фон: множитель L (HSL) для доминирующего цвета обложки. ---
// bgDiv сохраняет оттенок и насыщенность топового кластера палитры,
// а L линейно интерполируется между BG_LIGHTNESS_DARK_FLOOR (для L=0)
// и BG_LIGHTNESS (для L=1). На практике при дефолте 0.9 фон почти
// совпадает с доминантой — блобы читаются на фоне обложки, а не на
// «грязной» подложке.
const BG_LIGHTNESS = 0.9
const BG_LIGHTNESS_MIN = 0
const BG_LIGHTNESS_MAX = 1
// Минимальный L фона: даже для L=0 в обложке bgDiv остаётся читаемым,
// а не «уходит» в чёрный. 0.18 — небольшой подъём, чтобы UI плеера
// не проваливался.
const BG_LIGHTNESS_DARK_FLOOR = 0.18

// --- Адаптивность по ширине viewport (px). ---
const MOBILE_BREAKPOINT_PX = 768

// --- Blob'ы: количество ---
// Снижено с 96 до 40: при 1920×1080 каждый блоб радиуса 360-720 — это огромный
// overdraw (каждый пиксель рисуется ~30 раз). Шейдер всё равно процедурный и
// выглядит «полно» даже с 40 блобами, потому что они крупные.
const BLOB_COUNT_MIN = 40
const BLOB_COUNT_MAX = BLOB_COUNT_MIN * 2
const BLOB_COUNT_MIN_SETTING_MIN = 16
const BLOB_COUNT_MIN_SETTING_MAX = 80

// Приблизительная «ширина холста» в пикселях на один blob — даёт плавное масштабирование.
const BLOB_COUNT_DIVISOR_PX = 240

// --- Blob'ы: радиус (базовый, без пульсации) ---
// Облака в стиле Apple Music крупнее прежних клякс: блоб занимает ~30-50% короткой стороны canvas.
// Уменьшено с 360 до 280 для баланса между «плотным» и «невесомым» фоном.
const BLOB_RADIUS_MIN = 280
const BLOB_RADIUS_MAX = BLOB_RADIUS_MIN * 2
// Стартовое значение currentRadius до первого updateBlobs (выровнено по середине диапазона).
const BLOB_RADIUS_INITIAL = 350

// --- Blob'ы: амплитуда пульсации радиуса ---
const BLOB_PULSE_AMPLITUDE = 90

// --- Blob'ы: орбита (амплитуда колебаний baseX/baseY) ---
// Орбита крупнее, чтобы блобы реально «плавали» через сцену, а не дёргались на месте.
const BLOB_ORBIT_MIN = 200
const BLOB_ORBIT_MAX = 800

// --- Blob'ы: скорости ---
// Дрейф X/Y: множитель t в sin/cos. Скорости снижены ~1.5x — облака «дышат»,
// а не бегают по сцене, что и даёт медитативный эффект Apple Music.
const BLOB_SPEED_DRIFT_MIN = 0.00007
const BLOB_SPEED_DRIFT_MAX = 0.00025
// Пульсация радиуса: множитель t в sin. Скорость пульса тоже ниже, чтобы дыхание
// было плавным и незаметным на глаз.
const BLOB_SPEED_PULSE_MIN = 0.0002
const BLOB_SPEED_PULSE_MAX = 0.00045

// --- Blob'ы: шейдерные эффекты ---
// Сила domain warping в фрагментном шейдере: 0 = почти статичные кляксы,
// 1 = ярко выраженные «облака» с текучей формой. UI-слайдер PulseSync.
const BLOB_WARP_DEFAULT = 0.6
const BLOB_WARP_MIN = 0
const BLOB_WARP_MAX = 1

// Скорость течения шума (как быстро «кипит» внутренность облака).
// 0 = форма почти статична, 1 = форма быстро течёт.
const BLOB_FLOW_DEFAULT = 0.5
const BLOB_FLOW_MIN = 0
const BLOB_FLOW_MAX = 1

// Дополнительная насыщенность в шейдере (поверх CSS-фильтра). 1 = без усиления,
// 1.15 = сочное Apple-Music-как-в-рекламе. <1 = приглушённый пастельный фон.
const BLOB_SATURATION_DEFAULT = 1.15
const BLOB_SATURATION_MIN = 0.8
const BLOB_SATURATION_MAX = 1.5

// Подсветка центра пятна: «горячая середина», как у бликов в Apple Music.
// 0 = равномерный цвет, 1 = заметное осветление в центре.
const BLOB_HIGHLIGHT_DEFAULT = 0.4
const BLOB_HIGHLIGHT_MIN = 0
const BLOB_HIGHLIGHT_MAX = 1

// Скорость блобов
const BLOB_SPEED_MIN = 0.25
const BLOB_SPEED_MAX = 4

// --- Blob'ы: волна бленда палитры ---
// colorOffset распределяет старт бленда по blob'ам: colorOffset = (i / count) * WAVE_SPREAD.
// Меньше значение — больше blob'ов блендится одновременно (видимая часть бленда длиннее).
const PALETTE_WAVE_SPREAD = 0.25

// --- Текстура blob'а (offscreen canvas) ---
// Больше не используется: альфа блоба формируется процедурно во фрагментном шейдере
// (FBM + domain warping), offscreen canvas убран ради экономии памяти GPU.
const BLOB_TEXTURE_SIZE_PX = 512

// --- Поворот холста ---
// Глобальное вращение canvas вокруг центра (рад/мс). 0.00001 — едва заметный «дышащий» поворот.
const CANVAS_ROTATION_RAD_PER_MS = 0.00001

// --- Размытие canvas ---
const BLUR_DESKTOP_PX = 100
const BLUR_MOBILE_PX = 70

// --- Извлечение палитры из обложки ---
// Если у HTMLImageElement ещё нет naturalWidth/Height (не загрузилась) —
// используем этот размер как fallback для createImageData.
const COVER_DEFAULT_SIZE_PX = 800
// Целевой размер обложки при CORS-загрузке: подменяет финальный сегмент
// `<W>x<H>` в URL (например, `…/400x400` → `…/1000x1000`). CDN Яндекса
// отдаёт нужный размер по этому сегменту пути. Если сегмента в URL нет,
// URL используется как есть.
const COVER_FETCH_SIZE = '1000x1000'
// Целевое число сэмплов пикселей по всей обложке (для усреднения цвета и палитры).
const COVER_SAMPLE_TARGET_COUNT = 4000
// Порог склейки кластеров по RGB: d² < (MERGE_RGB_DIST)². 70 — баланс между
// подавлением JPEG-шума и различением оттенков (коричневый vs чёрный).
const CLUSTER_MERGE_RGB_DIST = 70
// Сколько цветов берём из кластеров в финальную палитру.
const EXTRACTED_PALETTE_SIZE = 6

// --- Логирование ---
const LOG_PREFIX = '[Cover2Anim]'

export {
    BLOB_COUNT_DIVISOR_PX,
    BLOB_COUNT_MAX,
    BLOB_COUNT_MIN,
    BLOB_ORBIT_MAX,
    BLOB_ORBIT_MIN,
    BLOB_PULSE_AMPLITUDE,
    BLOB_RADIUS_INITIAL,
    BLOB_RADIUS_MAX,
    BLOB_RADIUS_MIN,
    BLOB_SPEED_DRIFT_MAX,
    BLOB_SPEED_DRIFT_MIN,
    BLOB_SPEED_PULSE_MAX,
    BLOB_SPEED_PULSE_MIN,
    BLOB_TEXTURE_SIZE_PX,
    BLUR_DESKTOP_PX,
    BLUR_MOBILE_PX,
    BG_LIGHTNESS,
    BG_LIGHTNESS_DARK_FLOOR,
    CANVAS_ROTATION_RAD_PER_MS,
    CLUSTER_MERGE_RGB_DIST,
    COVER_DEBOUNCE_MS,
    COVER_DEFAULT_SIZE_PX,
    COVER_FETCH_SIZE,
    COVER_SAMPLE_TARGET_COUNT,
    COVER_SELECTOR,
    EXTRACTED_PALETTE_SIZE,
    FALLBACK_PALETTE,
    FPS_UPDATE_INTERVAL_MS,
    INITIAL_BACKGROUND_COLOR,
    INITIAL_FRAME_DELTA_MS,
    LOG_PREFIX,
    MAX_RETRIES,
    MODAL_SELECTOR,
    MOBILE_BREAKPOINT_PX,
    PALETTE_FADE_MS,
    PALETTE_WAVE_SPREAD,
    POSTER_CONTENT_SELECTOR,
    RETRY_DELAY_MS,
    BLOB_COUNT_MIN_SETTING_MAX,
    BLOB_COUNT_MIN_SETTING_MIN,
    BG_LIGHTNESS_MAX,
    BG_LIGHTNESS_MIN,
    BLOB_SPEED_MAX,
    BLOB_SPEED_MIN,
    PALETTE_BLEND_SPEED_MAX,
    PALETTE_BLEND_SPEED_MIN,
    PALETTE_FADE_MS_MAX,
    PALETTE_FADE_MS_MIN,
    BLOB_WARP_DEFAULT,
    BLOB_WARP_MIN,
    BLOB_WARP_MAX,
    BLOB_FLOW_DEFAULT,
    BLOB_FLOW_MIN,
    BLOB_FLOW_MAX,
    BLOB_SATURATION_DEFAULT,
    BLOB_SATURATION_MIN,
    BLOB_SATURATION_MAX,
    BLOB_HIGHLIGHT_DEFAULT,
    BLOB_HIGHLIGHT_MIN,
    BLOB_HIGHLIGHT_MAX,
}
