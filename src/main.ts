import './styles.css'

import addonConfig from '../addon.config.mjs'
import { getAddonSettings, readBooleanSetting, readNumberSetting, readStringSetting, readSelectSetting } from './pulsesync'
import {
    BG_LIGHTNESS,
    BG_LIGHTNESS_DARK_FLOOR,
    BLOB_COUNT_DIVISOR_PX,
    BLOB_COUNT_MAX,
    BLOB_COUNT_MIN,
    BLOB_COUNT_MIN_SETTING_MAX,
    BLOB_COUNT_MIN_SETTING_MIN,
    BLOB_FLOW_DEFAULT,
    BLOB_FLOW_MAX,
    BLOB_FLOW_MIN,
    BLOB_HIGHLIGHT_DEFAULT,
    BLOB_HIGHLIGHT_MAX,
    BLOB_HIGHLIGHT_MIN,
    BLOB_ORBIT_MAX,
    BLOB_ORBIT_MIN,
    BLOB_PULSE_AMPLITUDE,
    BLOB_RADIUS_INITIAL,
    BLOB_RADIUS_MAX,
    BLOB_RADIUS_MIN,
    BLOB_SATURATION_DEFAULT,
    BLOB_SATURATION_MAX,
    BLOB_SATURATION_MIN,
    BLOB_SPEED_DRIFT_MAX,
    BLOB_SPEED_DRIFT_MIN,
    BLOB_SPEED_MAX,
    BLOB_SPEED_MIN,
    BLOB_SPEED_PULSE_MAX,
    BLOB_SPEED_PULSE_MIN,
    BLOB_WARP_DEFAULT,
    BLOB_WARP_MAX,
    BLOB_WARP_MIN,
    BLUR_DESKTOP_PX,
    BLUR_MOBILE_PX,
    BG_LIGHTNESS_MAX,
    BG_LIGHTNESS_MIN,
    CANVAS_ROTATION_RAD_PER_MS,
    CLUSTER_MERGE_RGB_DIST,
    COVER_DEBOUNCE_MS,
    COVER_DEFAULT_SIZE_PX,
    COVER_SAMPLE_TARGET_COUNT,
    COVER_SELECTOR,
    EXTRACTED_PALETTE_SIZE,
    FALLBACK_PALETTE,
    FPS_UPDATE_INTERVAL_MS,
    INITIAL_BACKGROUND_COLOR,
    INITIAL_FRAME_DELTA_MS,
    JSON_POLLER_INTERVAL_MS,
    JSON_POLLER_URL,
    LOG_PREFIX,
    MAX_RETRIES,
    MODAL_SELECTOR,
    MOBILE_BREAKPOINT_PX,
    PALETTE_BLEND_SPEED_MAX,
    PALETTE_BLEND_SPEED_MIN,
    PALETTE_FADE_MS,
    PALETTE_FADE_MS_MAX,
    PALETTE_FADE_MS_MIN,
    PALETTE_SOURCE_COVER,
    PALETTE_SOURCE_DEFAULT,
    PALETTE_SOURCE_DERIVED,
    PALETTE_SOURCE_MIXED,
    PALETTE_SOURCE_VALUES,
    PALETTE_WAVE_SPREAD,
    POSTER_CONTENT_SELECTOR,
    RETRY_DELAY_MS,
} from './constants'

// ---------------------------------------------------------------------------
// Шейдеры WebGL2
// ---------------------------------------------------------------------------

// Вершинный шейдер:
// Преобразует локальные вершины quad'а блоба (-1..1) в clip-space.
// Применяет поворот холста (как mat2-юниформ) вокруг центра холста.
// Все позиционные вычисления ведутся в CSS-пикселях; DPR учитывается во viewport.
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Единичный квадрат: (-1,-1) … (1,1)
in vec2 a_unitPos;

uniform vec2  u_resolution;  // размер холста в CSS-пикселях
uniform mat2  u_rotation;    // матрица поворота вокруг центра холста
uniform vec2  u_blobCenter;  // центр блоба в CSS-пикселях
uniform float u_blobRadius;  // радиус блоба в CSS-пикселях

out vec2 v_localPos;         // передаётся во фрагментный шейдер (-1..1)

void main() {
    v_localPos = a_unitPos;

    // Мировая позиция в CSS-пикселях
    vec2 worldPos = u_blobCenter + a_unitPos * u_blobRadius;

    // Поворот вокруг центра холста
    vec2 centre = u_resolution * 0.5;
    worldPos = u_rotation * (worldPos - centre) + centre;

    // CSS-пиксели → clip-space (Y инвертируется)
    vec2 clip = (worldPos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
`

// Фрагментный шейдер (v2.1 — Apple Music style «дышащие облака», оптимизирован):
//
// - Без offscreen canvas: альфа блоба формируется полностью процедурно.
// - Одноуровневый domain warping: координаты пикселя деформируются одной итерацией
//   FBM, что даёт текучую форму без квадратичной стоимости двухуровневого варианта.
// - FBM развёрнут вручную (3 октавы, без цикла) — компилятор GPU разворачивает
//   детерминированно и инлайнит, тогда как цикл с int-счётчиком часто не векторизуется.
// - Early-discard по dist > 0.65: отсекает ~40% пикселей в каёвочной зоне до того,
//   как мы заплатим за FBM. Эти пиксели всё равно были бы с альфой 0.
// - При u_warp=0 не считается второй проход fbm(p): форма вырождается в mix(0.5, ...),
//   сохраняя визуальный результат (без деформации шум всё равно [0..1]).
// - Внутренний highlight: центр пятна заметно ярче, имитируя блик/свечение, как
//   в полноэкранном плеере Apple Music.
// - Saturation boost: финальный цвет проходит через linear-luma-mix.
const FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_localPos;

uniform vec3  u_color;        // целевой (новый) цвет в линейном RGB [0-1]
uniform vec3  u_prevColor;    // предыдущий цвет в линейном RGB [0-1]
uniform float u_blendT;       // 0 = prevColor, 1 = color  (до smoothstep)
uniform float u_time;         // глобальное время в секундах (для FBM)
uniform float u_aspect;       // width/height canvas (для круглых, а не эллиптических пятен)
uniform float u_warp;         // сила domain warping [0..1]
uniform float u_flow;         // скорость течения шума [0..1]
uniform float u_saturation;   // boost насыщенности [0.8..1.5]
uniform float u_highlight;    // подсветка центра [0..1]

out vec4 outColor;

// 2D hash (без текстуры, чистый GLSL). Полиномиальный hash — стабильный
// на любых драйверах, тогда как fract(sin(dot(...))) часто даёт полосы.
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// Value noise с бикубической интерполяцией (u = f*f*(3-2f)).
// 4 вызова hash21 на пиксель — это самый тяжёлый кусок шейдера, поэтому
// считаем его минимальное количество раз.
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 3-октавный FBM, развёрнутый вручную (без цикла). Лакьюнес 0.5.
// На мобильных Adreno/Mali развёрнутый FBM на 30-50% быстрее циклического.
float fbm3(vec2 p) {
    float v = 0.5 * vnoise(p);
    v += 0.25 * vnoise(p * 2.0 + vec2(7.3, 1.7));
    v += 0.125 * vnoise(p * 4.0 + vec2(3.1, 9.4));
    return v;
}

void main() {
    // 1. Локальные координаты в «единицах радиуса» (-1..1), исправляем эллиптичность.
    vec2 p = vec2(v_localPos.x * u_aspect, v_localPos.y);
    float dist = length(p);

    // 2. Early discard: за пределами 0.65 радиуса пиксель всё равно
    //    прозрачный (radial = 0 при dist >= 1.0, на 0.65 уже 0.27,
    //    и умножение на noiseMod вряд ли даст >0.01). Экономим FBM
    //    на ~40% пикселей всех блобов.
    if (dist > 0.65) discard;

    // 3. Базовая мягкая круглая маска: 1 в центре → 0 на радиусе 1.0.
    float radial = 1.0 - smoothstep(0.45, 1.0, dist);

    // 4. Один проход domain warping. q.x и q.y считаются ОДНИМ fbm3
    //    с большим смещением между осями (3.7 vs 11.2) — это даёт
    //    независимые каналы при одном проходе по шуму (4 вызова vnoise,
    //    а не 8, как было бы при двух fbm).
    float t = u_time * u_flow;
    vec2 q = vec2(
        fbm3(p * 0.9 + vec2(0.0, 0.0) + t * 0.13),
        fbm3(p * 0.9 + vec2(3.7, 11.2) + t * 0.17)
    );

    // 5. Финальный FBM. При u_warp=0 — не считаем warped вовсе, берём
    //    нейтральный 0.5, что соответствует «нет деформации» (fbm без
    //    смещения всё равно колеблется около 0.5).
    float f = (u_warp > 0.0) ? fbm3(p * 2.0 + u_warp * 2.0 * q) : 0.5;

    // 6. Модуляция альфа шумом: 0.5..1.3 от радиальной маски.
    float noiseMod = 0.5 + 0.8 * f;
    float alpha = radial * noiseMod * 0.85;
    alpha = clamp(alpha, 0.0, 0.95);

    if (alpha < 0.005) discard;

    // 7. Цвет с цветовым лерпом prev→current (smoothstep для естественного темпа).
    float bT = u_blendT * u_blendT * (3.0 - 2.0 * u_blendT);
    vec3 baseColor = mix(u_prevColor, u_color, bT);

    // 8. Подсветка центра.
    float hl = u_highlight * (1.0 - dist);
    vec3 finalColor = mix(baseColor, min(baseColor + vec3(0.22), vec3(1.0)), hl);

    // 9. Saturation boost.
    float luma = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
    finalColor = mix(vec3(luma), finalColor, u_saturation);

    outColor = vec4(finalColor, alpha);
}
`

// ---------------------------------------------------------------------------
// Логирование
// ---------------------------------------------------------------------------

function log(message: string, ...args: unknown[]): void {
    if (getAddonSettings(addonConfig.name).getCurrent().enableLogging.value === true) {
        console.log(`${LOG_PREFIX} ${message}`, ...args)
    }
}

function debug(message: string, ...args: unknown[]): void {
    if (getAddonSettings(addonConfig.name).getCurrent().enableLogging.value === true) {
        console.debug(`${LOG_PREFIX} ${message}`, ...args)
    }
}

function error(message: string, ...args: unknown[]): void {
    if (getAddonSettings(addonConfig.name).getCurrent().enableLogging.value === true) {
        console.error(`${LOG_PREFIX} ${message}`, ...args)
        for (const arg of args) {
            if (arg instanceof Error) {
                if (arg.message) console.error(`${LOG_PREFIX}   message:`, arg.message)
                if (arg.stack) console.error(`${LOG_PREFIX}   stack:`, arg.stack)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

// Blob больше не хранит canvas-текстуры — смешивание цветов выполняется
// полностью во фрагментном шейдере через u_prevColor / u_color / u_blendT.
type Blob = {
    color: string // текущий «от»-цвет (hex) — начало перехода
    targetColor: string // «к»-цвет (hex) — конец перехода
    baseX: number
    baseY: number
    radius: number
    currentRadius: number
    orbitX: number
    orbitY: number
    phaseX: number
    phaseY: number
    speedX: number
    speedY: number
    pulsePhase: number
    pulseSpeed: number
    colorMix: number // 0→1, прогресс текущего перехода цвета
    colorOffset: number // сдвиг фазы для волнового перехода
}

// Все настройки, читаемые из PulseSync, + выводимые runtime-параметры.
type PaletteSource = '0' | '1' | '2' // 0 - cover 1 - derivedColors 2 - mixed

type AddonRuntimeSettings = {
    enabled: boolean
    showFps: boolean
    enableLogging: boolean
    filter: string
    paletteFadeMs: number
    blobCountMin: number
    blobSpeed: number
    bgLightness: number
    paletteBlendSpeed: number
    warp: number
    flow: number
    saturation: number
    highlight: number
    paletteSource: PaletteSource
}

// ---------------------------------------------------------------------------
// Хелперы настроек (без изменений)
// ---------------------------------------------------------------------------

// Единая карта ключей настроек PulseSync → удобно перебирать и не даёт
// разъехаться именам констант и реальным ключам в хранилище.
const SETTING_KEYS = {
    enabled: 'enabled',
    paletteSource: 'paletteSource',
    showFps: 'showFps',
    enableLogging: 'enableLogging',
    filter: 'filter',
    paletteFadeMs: 'paletteFadeMs',
    paletteBlendSpeed: 'paletteBlendSpeed',
    blobCountMin: 'blobCountMin',
    blobSpeed: 'blobSpeed',
    bgLightness: 'bgLightness',
    warp: 'warp',
    flow: 'flow',
    saturation: 'saturation',
    highlight: 'highlight',
} as const

const DEFAULT_RUNTIME_SETTINGS: AddonRuntimeSettings = {
    enabled: true,
    showFps: false,
    enableLogging: false,
    filter: '',
    paletteFadeMs: PALETTE_FADE_MS,
    blobCountMin: BLOB_COUNT_MIN,
    blobSpeed: 1,
    bgLightness: BG_LIGHTNESS,
    paletteBlendSpeed: 1,
    warp: BLOB_WARP_DEFAULT,
    flow: BLOB_FLOW_DEFAULT,
    saturation: BLOB_SATURATION_DEFAULT,
    highlight: BLOB_HIGHLIGHT_DEFAULT,
    paletteSource: PALETTE_SOURCE_DEFAULT,
}

function sanitizeFilter(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value || value.toLowerCase() === 'none') {
        log('sanitizeFilter: значение пустое или "none" → используем "blur(100px)"')
        return 'blur(100px)'
    }
    const FUNCTIONS = ['blur', 'saturate', 'contrast', 'brightness', 'hue-rotate', 'invert', 'grayscale', 'sepia', 'drop-shadow']
    const allowed = new RegExp(`^([a-z-]+\\([^()]*\\)\\s*)+$`, 'i')
    if (!allowed.test(value)) {
        log(`sanitizeFilter: значение "${value}" не прошло проверку синтаксиса CSS-фильтра, откат к дефолту "${DEFAULT_RUNTIME_SETTINGS.filter}"`)
        return DEFAULT_RUNTIME_SETTINGS.filter
    }
    for (const fn of FUNCTIONS) {
        if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(value)) {
            log(`sanitizeFilter: значение "${value}" принято (найдена разрешённая функция "${fn}")`)
            return value
        }
    }
    log(`sanitizeFilter: значение "${value}" не содержит ни одной разрешённой функции фильтра, откат к дефолту`)
    return DEFAULT_RUNTIME_SETTINGS.filter
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
}

function sanitizeSettings(raw: Partial<AddonRuntimeSettings>): AddonRuntimeSettings {
    log('sanitizeSettings: получены сырые настройки для валидации', raw)
    const result: AddonRuntimeSettings = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_RUNTIME_SETTINGS.enabled,
        showFps: typeof raw.showFps === 'boolean' ? raw.showFps : DEFAULT_RUNTIME_SETTINGS.showFps,
        enableLogging: typeof raw.enableLogging === 'boolean' ? raw.enableLogging : DEFAULT_RUNTIME_SETTINGS.enableLogging,
        filter: sanitizeFilter(raw.filter ?? DEFAULT_RUNTIME_SETTINGS.filter),
        paletteFadeMs: clampNumber(raw.paletteFadeMs ?? DEFAULT_RUNTIME_SETTINGS.paletteFadeMs, PALETTE_FADE_MS_MIN, PALETTE_FADE_MS_MAX),
        blobCountMin: Math.round(
            clampNumber(raw.blobCountMin ?? DEFAULT_RUNTIME_SETTINGS.blobCountMin, BLOB_COUNT_MIN_SETTING_MIN, BLOB_COUNT_MIN_SETTING_MAX),
        ),
        blobSpeed: clampNumber(raw.blobSpeed ?? DEFAULT_RUNTIME_SETTINGS.blobSpeed, BLOB_SPEED_MIN, BLOB_SPEED_MAX),
        bgLightness: clampNumber(raw.bgLightness ?? DEFAULT_RUNTIME_SETTINGS.bgLightness, BG_LIGHTNESS_MIN, BG_LIGHTNESS_MAX),
        paletteBlendSpeed: clampNumber(
            raw.paletteBlendSpeed ?? DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed,
            PALETTE_BLEND_SPEED_MIN,
            PALETTE_BLEND_SPEED_MAX,
        ),
        warp: clampNumber(raw.warp ?? DEFAULT_RUNTIME_SETTINGS.warp, BLOB_WARP_MIN, BLOB_WARP_MAX),
        flow: clampNumber(raw.flow ?? DEFAULT_RUNTIME_SETTINGS.flow, BLOB_FLOW_MIN, BLOB_FLOW_MAX),
        saturation: clampNumber(raw.saturation ?? DEFAULT_RUNTIME_SETTINGS.saturation, BLOB_SATURATION_MIN, BLOB_SATURATION_MAX),
        highlight: clampNumber(raw.highlight ?? DEFAULT_RUNTIME_SETTINGS.highlight, BLOB_HIGHLIGHT_MIN, BLOB_HIGHLIGHT_MAX),
        paletteSource: (() => {
            const n = Number(raw.paletteSource)

            if (Number.isInteger(n) && n >= 0 && n < PALETTE_SOURCE_VALUES.length) {
                return n as PaletteSource
            }

            return DEFAULT_RUNTIME_SETTINGS.paletteSource
        })(),
    }
    log('sanitizeSettings: итоговые провалидированные настройки', result)
    return result
}

// Читает «сырое» значение настроек PulseSync (объект settings, полученный
// через store.getCurrent() или из колбэка onChange) и приводит его к
// AddonRuntimeSettings. Единая точка чтения — используется и при первом
// старте (readRuntimeSettings), и при live-обновлении настроек (watchModal),
// чтобы порядок полей и дефолты не могли разъехаться между двумя местами.
function buildRuntimeSettingsFromStore(settings: unknown): AddonRuntimeSettings {
    return {
        enabled: readBooleanSetting(settings, SETTING_KEYS.enabled, DEFAULT_RUNTIME_SETTINGS.enabled),
        showFps: readBooleanSetting(settings, SETTING_KEYS.showFps, DEFAULT_RUNTIME_SETTINGS.showFps),
        enableLogging: readBooleanSetting(settings, SETTING_KEYS.enableLogging, DEFAULT_RUNTIME_SETTINGS.enableLogging),
        filter: readStringSetting(settings, SETTING_KEYS.filter, DEFAULT_RUNTIME_SETTINGS.filter),
        paletteFadeMs: readNumberSetting(settings, SETTING_KEYS.paletteFadeMs, DEFAULT_RUNTIME_SETTINGS.paletteFadeMs),
        paletteBlendSpeed: readNumberSetting(settings, SETTING_KEYS.paletteBlendSpeed, DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed),
        blobCountMin: readNumberSetting(settings, SETTING_KEYS.blobCountMin, DEFAULT_RUNTIME_SETTINGS.blobCountMin),
        blobSpeed: readNumberSetting(settings, SETTING_KEYS.blobSpeed, DEFAULT_RUNTIME_SETTINGS.blobSpeed),
        bgLightness: readNumberSetting(settings, SETTING_KEYS.bgLightness, DEFAULT_RUNTIME_SETTINGS.bgLightness),
        warp: readNumberSetting(settings, SETTING_KEYS.warp, DEFAULT_RUNTIME_SETTINGS.warp),
        flow: readNumberSetting(settings, SETTING_KEYS.flow, DEFAULT_RUNTIME_SETTINGS.flow),
        saturation: readNumberSetting(settings, SETTING_KEYS.saturation, DEFAULT_RUNTIME_SETTINGS.saturation),
        highlight: readNumberSetting(settings, SETTING_KEYS.highlight, DEFAULT_RUNTIME_SETTINGS.highlight),
        paletteSource: readSelectSetting(settings, SETTING_KEYS.paletteSource, DEFAULT_RUNTIME_SETTINGS.paletteSource, PALETTE_SOURCE_VALUES),
    }
}

// Формирует лог-строку с ключевыми runtime-параметрами — используется и при
// старте, и при каждом изменении настроек, чтобы формат сообщения не расходился.
function describeRuntimeSettings(runtime: AddonRuntimeSettings): string {
    return (
        `enabled=${runtime.enabled}, showFps=${runtime.showFps}, filter=${runtime.filter}, ` +
        `paletteFadeMs=${runtime.paletteFadeMs}, paletteBlendSpeed=${runtime.paletteBlendSpeed}, ` +
        `blobCountMin=${runtime.blobCountMin}, blobSpeed=${runtime.blobSpeed}, bgLightness=${runtime.bgLightness}, ` +
        `warp=${runtime.warp}, flow=${runtime.flow}, saturation=${runtime.saturation}, highlight=${runtime.highlight}, ` +
        `paletteSource=${runtime.paletteSource}`
    )
}

function readRuntimeSettings(): AddonRuntimeSettings {
    log('readRuntimeSettings: читаю текущие настройки аддона из хранилища PulseSync')
    const settingsStore = getAddonSettings(addonConfig.name)
    const rawSettings = settingsStore.getCurrent()
    log('readRuntimeSettings: сырые данные из хранилища получены', rawSettings)
    return buildRuntimeSettingsFromStore(rawSettings)
}

// ---------------------------------------------------------------------------
// TrackJsonPoller — опрашивает локальный JSON-эндпоинт с состоянием плеера
// и уведомляет о смене трека. Палитра применяется ТОЛЬКО при смене track.id,
// чтобы не дёргать бленд блобов каждые 2.5 с.
// ---------------------------------------------------------------------------

// Минимальный набор полей из ответа 127.0.0.1:2007/get_track.
type JsonTrackDerivedColors = {
    accent?: unknown
    waveText?: unknown
    miniPlayer?: unknown
    average?: unknown
}
type JsonTrack = {
    id?: unknown
    derivedColors?: JsonTrackDerivedColors
}
type JsonTrackResponse = {
    track?: JsonTrack
}

type TrackUpdate = {
    id: string
    colors: [string, string, string, string] // accent, waveText, miniPlayer, average
}

class TrackJsonPoller {
    private readonly url: string
    private readonly intervalMs: number
    private readonly onUpdate: (update: TrackUpdate) => void
    private readonly onError: (err: unknown) => void

    private timerId: number | null = null
    private controller: AbortController | null = null
    private inFlight = false

    constructor(url: string, intervalMs: number, onUpdate: (u: TrackUpdate) => void, onError: (e: unknown) => void) {
        this.url = url
        this.intervalMs = intervalMs
        this.onUpdate = onUpdate
        this.onError = onError
    }

    start(): void {
        if (this.timerId !== null) {
            log(`TrackJsonPoller.start: поллер уже запущен (url=${this.url}), повторный запуск проигнорирован`)
            return
        }
        log(`TrackJsonPoller.start: запуск опроса ${this.url} с интервалом ${this.intervalMs}мс`)
        // Сразу дёргаем один раз — не ждём первый tick, иначе первый кадр пустой.
        void this.tick()
        this.timerId = window.setInterval(() => void this.tick(), this.intervalMs)
    }

    stop(): void {
        if (this.timerId !== null) {
            window.clearInterval(this.timerId)
            this.timerId = null
            log('TrackJsonPoller.stop: интервал опроса остановлен')
        } else {
            log('TrackJsonPoller.stop: интервал уже был остановлен ранее')
        }
        if (this.controller) {
            log('TrackJsonPoller.stop: прерываю активный fetch-запрос (AbortController.abort)')
        }
        this.controller?.abort()
        this.controller = null
        this.inFlight = false
    }

    private async tick(): Promise<void> {
        if (this.inFlight) {
            log('TrackJsonPoller.tick: предыдущий запрос ещё выполняется, пропускаю тик')
            return
        }
        this.inFlight = true
        this.controller = new AbortController()
        const startedAt = performance.now()
        log(`TrackJsonPoller.tick: отправляю запрос → ${this.url}`)
        try {
            const res = await fetch(this.url, { signal: this.controller.signal, cache: 'no-store' })
            const elapsed = (performance.now() - startedAt).toFixed(1)
            if (!res.ok) {
                log(`TrackJsonPoller.tick: сервер вернул ошибку HTTP ${res.status} (за ${elapsed}мс)`)
                this.onError(new Error(`HTTP ${res.status}`))
                return
            }
            log(`TrackJsonPoller.tick: ответ получен за ${elapsed}мс, статус ${res.status}, разбираю JSON`)
            const data = (await res.json()) as JsonTrackResponse
            const update = parseTrackUpdate(data)
            if (update) {
                log(`TrackJsonPoller.tick: получено валидное обновление трека id="${update.id}", цвета:`, update.colors)
                this.onUpdate(update)
            } else {
                log('TrackJsonPoller.tick: ответ не содержит валидных данных трека (нет id или derivedColors), игнорирую')
            }
        } catch (err) {
            // AbortError при stop() — не считаем ошибкой.
            if (err instanceof DOMException && err.name === 'AbortError') {
                log('TrackJsonPoller.tick: запрос был прерван (AbortError), это ожидаемо при остановке поллера')
                return
            }
            log('TrackJsonPoller.tick: ошибка при выполнении запроса или разборе JSON', err)
            this.onError(err)
        } finally {
            this.inFlight = false
        }
    }
}

// Валидирует hex-цвет из track.derivedColors.
// Принимает '#RGB' / '#RRGGBB' (регистр любой). Возвращает нормализованный '#rrggbb' либо null.
function normalizeHexColor(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        log(`normalizeHexColor: ожидалась строка, получено значение типа "${typeof raw}"`, raw)
        return null
    }
    const value = raw.trim()
    if (!value.startsWith('#')) {
        log(`normalizeHexColor: строка "${value}" не начинается с "#"`)
        return null
    }
    const hex = value.slice(1)
    if (hex.length === 3) {
        const expanded = hex
            .split('')
            .map(ch => ch + ch)
            .join('')
        if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
            log(`normalizeHexColor: короткий hex "${value}" содержит недопустимые символы`)
            return null
        }
        return `#${expanded.toLowerCase()}`
    }
    if (hex.length === 6) {
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
            log(`normalizeHexColor: hex "${value}" содержит недопустимые символы`)
            return null
        }
        return `#${hex.toLowerCase()}`
    }
    log(`normalizeHexColor: неподдерживаемая длина hex-строки "${value}" (${hex.length} символов, ожидалось 3 или 6)`)
    return null
}

// Извлекает из JSON { track: { id, derivedColors: { accent, waveText, miniPlayer, average } } }
// валидный update. Если id или любой из 4 цветов отсутствует/невалиден — возвращает null.
function parseTrackUpdate(data: unknown): TrackUpdate | null {
    if (!data || typeof data !== 'object') {
        log('parseTrackUpdate: корневой объект ответа отсутствует или не является объектом', data)
        return null
    }
    const root = data as JsonTrackResponse
    const track = root.track
    if (!track || typeof track !== 'object') {
        log('parseTrackUpdate: поле "track" отсутствует или не является объектом')
        return null
    }

    const id = track.id
    if (typeof id !== 'string' || id.length === 0) {
        log('parseTrackUpdate: поле "track.id" отсутствует, не строка или пустое', id)
        return null
    }

    const dc = track.derivedColors
    if (!dc || typeof dc !== 'object') {
        log(`parseTrackUpdate: track.id="${id}" — поле "derivedColors" отсутствует или не является объектом`)
        return null
    }

    const accent = normalizeHexColor(dc.accent)
    const waveText = normalizeHexColor(dc.waveText)
    const miniPlayer = normalizeHexColor(dc.miniPlayer)
    const average = normalizeHexColor(dc.average)

    if (!accent || !waveText || !miniPlayer || !average) {
        log(`parseTrackUpdate: track.id="${id}" — один или несколько цветов невалидны`, {
            accent,
            waveText,
            miniPlayer,
            average,
        })
        return null
    }

    log(
        `parseTrackUpdate: track.id="${id}" успешно разобран, цвета: accent=${accent} waveText=${waveText} miniPlayer=${miniPlayer} average=${average}`,
    )
    return { id, colors: [accent, waveText, miniPlayer, average] }
}

// Дополняет 4-цветную палитру от derivedColors до EXTRACTED_PALETTE_SIZE=6,
// повторяя первые два цвета. Так палитра блобов «дышит» равномерно и попадает
// в 6-цветный контракт extractColors().
function expandDerivedPalette(colors: readonly [string, string, string, string]): string[] {
    const expanded = [colors[0], colors[1], colors[2], colors[3], colors[0], colors[1]]
    log('expandDerivedPalette: 4-цветная палитра расширена до 6 цветов', { исходная: colors, результат: expanded })
    return expanded
}

// HSL-блендинг двух hex-цветов 50/50. Используется для mixed-режима, где
// derived-цвета усредняются с топовыми цветами обложки в HSL-пространстве.
function blendHslHalf(hexA: string, hexB: string): string {
    const a = hexToHsl(hexA)
    const b = hexToHsl(hexB)
    // Hue идёт по короткой дуге (если разница > 180° — берём +360 для a, чтобы не ходить через 0).
    let h = a.h
    const diff = b.h - a.h
    if (diff > 180) h += 360
    else if (diff < -180) h -= 360
    const mixedH = (h + b.h) / 2
    const normalizedH = ((mixedH % 360) + 360) % 360
    const mixedS = (a.s + b.s) / 2
    const mixedL = (a.l + b.l) / 2
    return hslToHex(normalizedH, mixedS, mixedL)
}

// Смешивает 4-цветную derived-палитру с 2 топовыми цветами обложки попарно
// (HSL-блендинг 50/50) и дополняет до 6 уникальных цветов повтором первых двух.
// Если topColors пуст (обложка ещё не пришла в mixed-режиме) — fallback на
// expandDerivedPalette.
function mixDerivedWithCover(derived: readonly [string, string, string, string], topColors: readonly string[]): string[] {
    if (topColors.length < 2) {
        log('mixDerivedWithCover: топовые цвета обложки отсутствуют, fallback на expandDerivedPalette')
        return expandDerivedPalette(derived)
    }
    const [t0, t1] = topColors
    const mixed: string[] = [blendHslHalf(derived[0], t0), blendHslHalf(derived[1], t1), blendHslHalf(derived[2], t0), blendHslHalf(derived[3], t1)]
    const expanded = [mixed[0], mixed[1], mixed[2], mixed[3], mixed[0], mixed[1]]
    log('mixDerivedWithCover: 4 derived × 2 cover → 6 mixed (HSL 50/50)', { derived, top: topColors, mixed: expanded })
    return expanded
}

// ---------------------------------------------------------------------------
// Цветовые утилиты — единая реализация hex/rgb/hsl-конвертации.
// Используются и на уровне модуля (blendHslHalf/mixDerivedWithCover), и
// внутри CanvasBackground (блобы, переходы фона, извлечение палитры из
// обложки), чтобы не поддерживать две параллельные реализации одной и той же
// математики.
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value))
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    }
}

// Нормализует hex-цвет к тройке float [0, 1] — формат, который ожидают
// WebGL-юниформы u_color/u_prevColor.
function hexToRgbFloat(hex: string): [number, number, number] {
    const { r, g, b } = hexToRgb(hex)
    return [r / 255, g / 255, b / 255]
}

function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

// Линейно интерполирует между двумя hex-цветами в RGB-пространстве.
function blendHex(a: string, b: string, t: number): string {
    const ca = hexToRgb(a)
    const cb = hexToRgb(b)
    return rgbToHex(Math.round(lerp(ca.r, cb.r, t)), Math.round(lerp(ca.g, cb.g, t)), Math.round(lerp(ca.b, cb.b, t)))
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (max !== min) {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch (max) {
            case rn:
                h = (gn - bn) / d + (gn < bn ? 6 : 0)
                break
            case gn:
                h = (bn - rn) / d + 2
                break
            default:
                h = (rn - gn) / d + 4
        }
        h *= 60
    }
    return { h, s, l }
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
    const { r, g, b } = hexToRgb(hex)
    return rgbToHsl(r, g, b)
}

// HSL → (r, g, b) в [0, 255]. h в градусах [0, 360), s/l в [0, 1].
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    let r1 = 0
    let g1 = 0
    let b1 = 0
    if (h < 60) {
        r1 = c
        g1 = x
        b1 = 0
    } else if (h < 120) {
        r1 = x
        g1 = c
        b1 = 0
    } else if (h < 180) {
        r1 = 0
        g1 = c
        b1 = x
    } else if (h < 240) {
        r1 = 0
        g1 = x
        b1 = c
    } else if (h < 300) {
        r1 = x
        g1 = 0
        b1 = c
    } else {
        r1 = c
        g1 = 0
        b1 = x
    }
    return {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255),
    }
}

function hslToHex(h: number, s: number, l: number): string {
    const { r, g, b } = hslToRgb(h, s, l)
    return rgbToHex(r, g, b)
}

// Вычисляет цвет bgDiv по топовому кластеру палитры обложки: сохраняет H и S,
// а L линейно интерполируется от BG_LIGHTNESS_DARK_FLOOR (для L=0 в обложке)
// к bgLightness (для L=1). При bgLightness=1 фон совпадает с доминантой; при
// bgLightness=0.9 — почти совпадает; floor не даёт провалиться в чёрный для
// очень тёмных обложек.
function dominantBgFromPalette(palette: string[], bgLightness: number): string {
    const dominant = palette.length > 0 ? palette[0] : FALLBACK_PALETTE[0]
    const { h, s, l } = hexToHsl(dominant)
    const l2 = BG_LIGHTNESS_DARK_FLOOR + (bgLightness - BG_LIGHTNESS_DARK_FLOOR) * l
    const { r, g, b } = hslToRgb(h, s, clamp01(l2))
    return rgbToHex(r, g, b)
}

// ---------------------------------------------------------------------------
// CanvasBackground
// ---------------------------------------------------------------------------

class CanvasBackground {
    private readonly container: HTMLElement
    private readonly canvas: HTMLCanvasElement
    private readonly gl: WebGL2RenderingContext

    // WebGL-ресурсы — инициализируются в initGL(), освобождаются в destroy().
    private program!: WebGLProgram
    private vao!: WebGLVertexArrayObject
    private positionBuffer!: WebGLBuffer

    // Локации юниформов (кэшируются после линковки программы).
    // «Шейдерные» юниформы (uWarp / uFlow / uSaturation / uHighlight) обновляются
    // «на лету» из applySettings() — без перекомпиляции шейдера и без recreateBlobs().
    private uResolution!: WebGLUniformLocation
    private uRotation!: WebGLUniformLocation
    private uBlobCenter!: WebGLUniformLocation
    private uBlobRadius!: WebGLUniformLocation
    private uColor!: WebGLUniformLocation
    private uPrevColor!: WebGLUniformLocation
    private uBlendT!: WebGLUniformLocation
    private uTime!: WebGLUniformLocation
    private uAspect!: WebGLUniformLocation
    private uWarp!: WebGLUniformLocation
    private uFlow!: WebGLUniformLocation
    private uSaturation!: WebGLUniformLocation
    private uHighlight!: WebGLUniformLocation

    // Фоновый <div>, рендерящийся ПОД прозрачным WebGL-канвасом.
    // Переходы цвета фона применяются здесь, чтобы CSS-blur на canvas
    // размывал только блобы, но не фоновую заливку.
    private bgDiv: HTMLDivElement

    private blobs: Blob[] = []
    private animationTime = 0
    private lastTime = 0
    private lastDt = INITIAL_FRAME_DELTA_MS
    private rafId = 0
    private resizeObserver: ResizeObserver | null = null
    private coverObserver: MutationObserver | null = null

    private settings: AddonRuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS }
    private basePalette: string[] = []
    // Топ-2 цвета обложки (по убыванию веса кластера). Нужны для mixed-режима,
    // где 4 derived-цвета HSL-блендятся с 2 топовыми цветами обложки.
    private coverTopPalette: string[] = []
    private disabled = false

    private fpsElement: HTMLDivElement | null = null
    private fpsFrames = 0
    private fpsLastSampleTime = 0

    private backgroundColor: string = INITIAL_BACKGROUND_COLOR
    private targetBackgroundColor: string = INITIAL_BACKGROUND_COLOR
    private backgroundMix: number = 1

    private coverRequestId = 0
    private lastAppliedSrc: string | null = null
    private coverDebounceTimer: number | null = null
    private pendingCoverSrc: string | null = null
    private lastAppliedTrackId: string | null = null

    // Источник палитры: 'cover' (обложка) / 'derivedColors' (JSON 127.0.0.1:2007).
    // Если usingJsonPalette=true — applyCover/loadCover игнорируются,
    // поллер применяет палитру от derivedColors при смене track.id.
    private usingJsonPalette = false
    private jsonPoller: TrackJsonPoller | null = null
    private lastJsonTrackId: string | null = null
    private lastPaletteUpdateTime: number = 0

    // Источник, для которого сейчас реально запущены поллер/observer (см.
    // applyPaletteFromSource). Нужен, чтобы отличить настоящую смену режима
    // от повторного вызова requestPaletteRefresh() без смены источника —
    // иначе каждый такой вызов сбрасывал бы lastJsonTrackId/lastAppliedTrackId
    // и палитра переприменялась бы по несколько раз на одну смену трека.
    private activePaletteSource: string | null = null

    // Последний узел poster-content, на который навешан coverObserver.
    // Позволяет делать observeCover() идемпотентным: повторный вызов с тем же
    // узлом ничего не пересоздаёт.
    private observedPosterRoot: Element | null = null

    constructor(container: HTMLElement, initialSettings?: Partial<AddonRuntimeSettings>) {
        this.container = container

        // --- Фоновый div (должен идти первым в DOM, чтобы canvas рендерился поверх) ---
        this.bgDiv = document.createElement('div')
        this.bgDiv.className = 'c2a-bg-div'
        // Инлайн-стили, чтобы div заполнял контейнер независимо от состояния styles.css.
        Object.assign(this.bgDiv.style, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
        } satisfies Partial<CSSStyleDeclaration>)

        // --- WebGL2 canvas ---
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'c2a-canvas-bg'
        // alpha:true → прозрачный очищающий цвет, чтобы фон bgDiv просвечивал;
        // premultipliedAlpha:false → straight alpha — проще математика смешивания.
        const gl = this.canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            depth: false,
            stencil: false,
        })
        if (!gl) {
            const isConnected = container.isConnected
            const rect = container.getBoundingClientRect()
            throw new Error(
                `cannot acquire webgl2 context (connected=${isConnected}, ` +
                    `rect=${rect.width}x${rect.height}, ` +
                    `owner=${container.ownerDocument === document ? 'document' : 'detached'})`,
            )
        }
        this.gl = gl

        if (initialSettings) {
            this.settings = sanitizeSettings(initialSettings)
        }

        if (!this.settings.enabled) {
            this.disabled = true
            log('background disabled by setting')
            return
        }

        // Сначала вставляем bgDiv, сразу за ним — canvas.
        this.container.insertBefore(this.canvas, this.container.firstChild)
        this.container.insertBefore(this.bgDiv, this.canvas.nextSibling)
        this.container.classList.add('canvas-mode')

        this.initGL()
        this.applyCanvasFilter(this.settings.filter)
        this.createFpsElement()
        this.resize()
        this.startAnimation()

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.resize())
            this.resizeObserver.observe(this.container)
        } else {
            window.addEventListener('resize', this.onWindowResize)
        }

        const initialDominant = dominantBgFromPalette(FALLBACK_PALETTE, this.settings.bgLightness)
        this.applyPalette(FALLBACK_PALETTE, initialDominant)

        this.applyPaletteFromSource()

        log('background attached to', container)
    }

    // -------------------------------------------------------------------------
    // Инициализация WebGL2
    // -------------------------------------------------------------------------

    private initGL(): void {
        const gl = this.gl

        const vert = this.compileShader(gl.VERTEX_SHADER, VERT_SRC)
        const frag = this.compileShader(gl.FRAGMENT_SHADER, FRAG_SRC)

        const program = gl.createProgram()
        if (!program) throw new Error('gl.createProgram() returned null')
        gl.attachShader(program, vert)
        gl.attachShader(program, frag)
        gl.linkProgram(program)

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program)
            gl.deleteProgram(program)
            throw new Error(`Shader link failed: ${info}`)
        }

        // Шейдеры уже вкомпилированы в программу; держать их отдельно не нужно.
        gl.deleteShader(vert)
        gl.deleteShader(frag)

        this.program = program

        // --- Геометрия единичного квадрата (triangle-strip quad, 4 вершины) ---
        //   (-1,-1)  (1,-1)
        //   (-1, 1)  (1, 1)
        const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])

        const buf = gl.createBuffer()
        if (!buf) throw new Error('gl.createBuffer() returned null')
        this.positionBuffer = buf

        const vao = gl.createVertexArray()
        if (!vao) throw new Error('gl.createVertexArray() returned null')
        this.vao = vao

        gl.bindVertexArray(vao)
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

        const aUnitPos = gl.getAttribLocation(program, 'a_unitPos')
        gl.enableVertexAttribArray(aUnitPos)
        gl.vertexAttribPointer(aUnitPos, 2, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)

        // --- Кэшируем локации юниформов ---
        const loc = (name: string): WebGLUniformLocation => {
            const l = gl.getUniformLocation(program, name)
            if (!l) log(`initGL: юниформ "${name}" не найден — возможно, шейдер его оптимизировал`)
            return l!
        }
        this.uResolution = loc('u_resolution')
        this.uRotation = loc('u_rotation')
        this.uBlobCenter = loc('u_blobCenter')
        this.uBlobRadius = loc('u_blobRadius')
        this.uColor = loc('u_color')
        this.uPrevColor = loc('u_prevColor')
        this.uBlendT = loc('u_blendT')
        this.uTime = loc('u_time')
        this.uAspect = loc('u_aspect')
        this.uWarp = loc('u_warp')
        this.uFlow = loc('u_flow')
        this.uSaturation = loc('u_saturation')
        this.uHighlight = loc('u_highlight')

        // Один раз задаём дефолтные значения «шейдерных» юниформов.
        // u_time/u_aspect обновляются каждый кадр; остальные — на лету из applySettings(),
        // но начальные значения нужны на первом кадре до applySettings().
        gl.useProgram(program)
        gl.uniform1f(this.uTime, 0)
        gl.uniform1f(this.uAspect, 1)
        gl.uniform1f(this.uWarp, BLOB_WARP_DEFAULT)
        gl.uniform1f(this.uFlow, BLOB_FLOW_DEFAULT)
        gl.uniform1f(this.uSaturation, BLOB_SATURATION_DEFAULT)
        gl.uniform1f(this.uHighlight, BLOB_HIGHLIGHT_DEFAULT)
        gl.useProgram(null)
    }

    private compileShader(type: number, src: string): WebGLShader {
        const gl = this.gl
        const shader = gl.createShader(type)
        if (!shader) throw new Error('gl.createShader() returned null')
        gl.shaderSource(shader, src)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader)
            gl.deleteShader(shader)
            throw new Error(`Shader compile failed (${type === gl.VERTEX_SHADER ? 'vert' : 'frag'}): ${info}`)
        }
        return shader
    }

    // -------------------------------------------------------------------------
    // Жизненный цикл
    // -------------------------------------------------------------------------

    destroy(): void {
        cancelAnimationFrame(this.rafId)

        if (this.coverDebounceTimer !== null) {
            window.clearTimeout(this.coverDebounceTimer)
            this.coverDebounceTimer = null
            log('cover debounce timer stopped')
        }
        this.jsonPoller?.stop()
        this.resizeObserver?.disconnect()
        this.coverObserver?.disconnect()
        window.removeEventListener('resize', this.onWindowResize)
        this.container.classList.remove('canvas-mode')

        // Освобождаем WebGL-ресурсы (одного удаления canvas недостаточно, чтобы освободить память GPU).
        if (!this.disabled) {
            const gl = this.gl
            gl.deleteProgram(this.program)
            gl.deleteVertexArray(this.vao)
            gl.deleteBuffer(this.positionBuffer)
            // Явно теряем контекст — гарантирует очистку со стороны GPU.
            gl.getExtension('WEBGL_lose_context')?.loseContext()
        }

        this.bgDiv.remove()
        this.canvas.remove()

        if (this.fpsElement) {
            this.fpsElement.remove()
            this.fpsElement = null
            log('fps element removed')
        }

        this.fpsFrames = 0
        this.fpsLastSampleTime = 0
    }

    isContainerAlive(): boolean {
        return this.container.isConnected && document.contains(this.canvas)
    }

    requestPaletteRefresh(): void {
        this.applyPaletteFromSource()
    }

    // Запускает нужный режим получения палитры в зависимости от settings.paletteSource.
    // Вызывается из конструктора и из applySettings при смене источника.
    //   - cover:      подгрузить обложку + запустить observer src.
    //   - derivedColors: запустить JSON-поллер, observer обложки не нужен.
    //   - mixed:      запустить поллер + подгрузить обложку + observer (нужен для coverTopPalette).
    private applyPaletteFromSource(force: boolean = false): void {
        const source = String(this.settings.paletteSource)
        log(`applyPaletteFromSource: текущий источник палитры = "${source}" (force=${force})`)

        // requestPaletteRefresh() вызывается на КАЖДОЕ релевантное изменение DOM
        // (не только на смену трека — modal watcher реагирует на любые мутации
        // модалки/обложки), и при смене трека таких вызовов обычно 2-3 подряд.
        // Если источник палитры не менялся и это не принудительный пересчёт
        // (смена настройки paletteSource) — поллер и dedupe-состояние уже
        // корректны, полный сброс не нужен. Раньше он выполнялся безусловно,
        // из-за чего lastJsonTrackId/lastAppliedTrackId сбрасывались на каждый
        // такой вызов, и один и тот же трек применялся заново несколько раз —
        // отсюда резкий «скачок» цвета вместо одного плавного перехода.
        if (!force && this.activePaletteSource === source) {
            log(`applyPaletteFromSource: источник "${source}" не менялся — пропускаем сброс поллера/observer'а`)
            if (source === PALETTE_SOURCE_COVER || source === PALETTE_SOURCE_MIXED) {
                // Обложка привязана к конкретному DOM-узлу poster-content, который
                // мог быть пересоздан (например, модалка переоткрылась) — на этот
                // случай освежаем привязку. observeCover() идемпотентен: если узел
                // не менялся, он не пересоздаёт MutationObserver.
                const current = this.findCover()
                if (current) this.applyCover(current, false)
                this.observeCover()
            }
            return
        }
        this.activePaletteSource = source

        // По умолчанию отключаем поллер — он будет включён только для не-cover режимов.
        this.jsonPoller?.stop()
        this.jsonPoller = null
        this.lastJsonTrackId = null
        this.lastAppliedTrackId = null
        this.lastPaletteUpdateTime = 0
        // Отключаем предыдущий observer обложки (если был из другого режима) и
        // инвалидируем debounce/in-flight загрузку обложки, чтобы устаревший
        // результат не перезаписал палитру нового режима после переключения.
        this.coverObserver?.disconnect()
        this.coverObserver = null
        this.observedPosterRoot = null
        if (this.coverDebounceTimer !== null) {
            window.clearTimeout(this.coverDebounceTimer)
            this.coverDebounceTimer = null
        }
        this.pendingCoverSrc = null
        this.coverRequestId += 1

        // derivedColors — единственный режим, где обложка не участвует в палитре вовсе,
        // поэтому applyCover/loadCover должны полностью игнорироваться (guard в applyCover).
        this.usingJsonPalette = source === PALETTE_SOURCE_DERIVED
        if (source === PALETTE_SOURCE_DERIVED) {
            this.startJsonPoller()
            log('applyPaletteFromSource: режим "derivedColors" — observer обложки не активен')
            return
        }

        if (source === PALETTE_SOURCE_MIXED) {
            this.startJsonPoller()
            // mixed-режим нуждается в coverTopPalette — обложка подгружается параллельно.
            const initial = this.findCover()
            if (initial) this.applyCover(initial, force)
            this.observeCover()
            log('applyPaletteFromSource: режим "mixed" — поллер + observer обложки активны')
            return
        }

        // source === PALETTE_SOURCE_COVER (или дефолт)
        const initial = this.findCover()
        if (initial) this.applyCover(initial, force)
        this.observeCover()
        log('applyPaletteFromSource: режим "cover" — observer обложки активен')
    }

    // Создаёт и стартует TrackJsonPoller с колбэком applyTrackUpdate.
    private startJsonPoller(): void {
        if (this.jsonPoller) {
            log('startJsonPoller: поллер уже существует, повторный запуск игнорирован')
            return
        }
        this.jsonPoller = new TrackJsonPoller(
            JSON_POLLER_URL,
            JSON_POLLER_INTERVAL_MS,
            update => this.applyTrackUpdate(update),
            err => log('TrackJsonPoller.onError:', err),
        )
        this.jsonPoller.start()
    }

    // Колбэк поллера: обновление трека → применяем derived-палитру.
    // В mixed-режиме — HSL-блендинг с топовыми цветами обложки.
    private applyTrackUpdate(update: TrackUpdate): void {
        const source = String(this.settings.paletteSource)
        if (source !== PALETTE_SOURCE_DERIVED && source !== PALETTE_SOURCE_MIXED) {
            log('applyTrackUpdate: источник палитры не derived/mixed, обновление игнорируется')
            return
        }
        if (update.id === this.lastJsonTrackId) {
            log(`applyTrackUpdate: track.id="${update.id}" не изменился, пропуск`)
            return
        }
        this.lastJsonTrackId = update.id
        log(`applyTrackUpdate: новый track.id="${update.id}", применяем палитру (source=${source})`)
        const palette =
            source === PALETTE_SOURCE_MIXED ? mixDerivedWithCover(update.colors, this.coverTopPalette) : expandDerivedPalette(update.colors)
        const dominant = dominantBgFromPalette(palette, this.settings.bgLightness)
        this.basePalette = palette
        this.applyPalette(palette, dominant, update.id)
    }

    // -------------------------------------------------------------------------
    // Resize
    // -------------------------------------------------------------------------

    private onWindowResize = (): void => {
        this.resize()
    }

    private resize(): void {
        const gl = this.gl
        const dpr = window.devicePixelRatio || 1
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        // Размер в физических пикселях
        const physW = Math.round(width * dpr)
        const physH = Math.round(height * dpr)

        this.canvas.width = physW
        this.canvas.height = physH
        this.canvas.style.width = width + 'px'
        this.canvas.style.height = height + 'px'

        // bgDiv всегда зеркалит размеры canvas
        this.bgDiv.style.width = width + 'px'
        this.bgDiv.style.height = height + 'px'

        // Viewport WebGL в физических пикселях; шейдер оперирует CSS-пикселями
        // (u_resolution задаётся в CSS-пикселях), так что DPR прозрачен для логики блобов.
        gl.viewport(0, 0, physW, physH)

        // Обновляем CSS-фильтр, потому что радиус blur'а блобов разный
        // для мобильного и десктопного viewport'а.
        this.applyCanvasFilter(this.settings.filter)
    }

    // -------------------------------------------------------------------------
    // Цикл анимации
    // -------------------------------------------------------------------------

    private startAnimation(): void {
        const loop = (time: number): void => {
            const dt = this.lastTime === 0 ? 16 : time - this.lastTime
            this.lastTime = time
            this.lastDt = dt
            this.updateBlobs(dt)
            this.draw(time)
            this.tickFps(time)
            this.rafId = requestAnimationFrame(loop)
        }
        this.rafId = requestAnimationFrame(loop)
    }

    // -------------------------------------------------------------------------
    // FPS-оверлей
    // -------------------------------------------------------------------------

    private createFpsElement(): void {
        const el = document.createElement('div')
        el.className = 'c2a-fps'
        el.textContent = '— FPS'
        el.style.display = this.settings.showFps ? 'block' : 'none'
        this.container.appendChild(el)
        this.fpsElement = el
        this.fpsFrames = 0
        this.fpsLastSampleTime = 0
    }

    private tickFps(time: number): void {
        if (!this.fpsElement) return
        this.fpsFrames += 1
        if (this.fpsLastSampleTime === 0) {
            this.fpsLastSampleTime = time
            return
        }
        const elapsed = time - this.fpsLastSampleTime
        if (elapsed < FPS_UPDATE_INTERVAL_MS) return
        const fps = (this.fpsFrames * 1000) / elapsed
        this.fpsElement.textContent = `${Math.round(fps)} FPS`
        this.fpsFrames = 0
        this.fpsLastSampleTime = time
    }

    // -------------------------------------------------------------------------
    // Управление блобами
    // -------------------------------------------------------------------------

    private createBlobs(colors: string[]): void {
        this.blobs = []
        const isMobile = window.innerWidth < MOBILE_BREAKPOINT_PX
        const minCount = this.settings.blobCountMin
        const maxCount = minCount * 2
        const count = isMobile ? minCount : Math.max(minCount, Math.min(maxCount, Math.floor(window.innerWidth / BLOB_COUNT_DIVISOR_PX)))

        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        const radiusRange = BLOB_RADIUS_MAX - BLOB_RADIUS_MIN
        const orbitRange = BLOB_ORBIT_MAX - BLOB_ORBIT_MIN
        const speedScale = this.settings.blobSpeed
        const driftMin = BLOB_SPEED_DRIFT_MIN * speedScale
        const driftMax = BLOB_SPEED_DRIFT_MAX * speedScale
        const pulseMin = BLOB_SPEED_PULSE_MIN * speedScale
        const pulseMax = BLOB_SPEED_PULSE_MAX * speedScale
        const driftRange = driftMax - driftMin
        const pulseRange = pulseMax - pulseMin

        for (let i = 0; i < count; i++) {
            const color = colors[i % colors.length]
            this.blobs.push({
                color,
                targetColor: color,
                baseX: Math.random() * width,
                baseY: Math.random() * height,
                radius: BLOB_RADIUS_MIN + Math.random() * radiusRange,
                currentRadius: BLOB_RADIUS_INITIAL,
                orbitX: BLOB_ORBIT_MIN + Math.random() * orbitRange,
                orbitY: BLOB_ORBIT_MIN + Math.random() * orbitRange,
                phaseX: Math.random() * Math.PI * 2,
                phaseY: Math.random() * Math.PI * 2,
                speedX: driftMin + Math.random() * driftRange,
                speedY: driftMin + Math.random() * driftRange,
                pulsePhase: Math.random() * Math.PI * 2,
                pulseSpeed: pulseMin + Math.random() * pulseRange,
                colorMix: 1,
                colorOffset: (i / count) * PALETTE_WAVE_SPREAD,
            })
        }
        log(`created ${this.blobs.length} blobs from palette (speedScale=${speedScale})`, colors)
    }

    private updatePalette(colors: string[], trackId?: string | null): void {
        if (trackId && trackId === this.lastAppliedTrackId) {
            log(`updatePalette: пропуск повторного вызова для trackId="${trackId}" (палитра уже применена)`)
            return
        }
        const now = Date.now()
        if (now - this.lastPaletteUpdateTime < 100) {
            log(`updatePalette: пропуск обновления (прошло ${now - this.lastPaletteUpdateTime}мс < 1000мс)`)
            return
        }
        if (this.blobs.length === 0 || colors.length === 0) return
        // Подбираем для каждого блоба ближайший новый цвет по евклидову расстоянию в RGB
        // (тот же алгоритм, что в исходной 2D-версии).
        const initialTargets = this.blobs.map((_, i) => colors[i % colors.length])
        const initialRgb = initialTargets.map(hex => hexToRgb(hex))
        const newRgb = colors.map(hex => hexToRgb(hex))
        const used = new Array<boolean>(newRgb.length).fill(false)

        this.blobs.forEach((blob, i) => {
            let bestIdx = -1
            let bestDist = Number.POSITIVE_INFINITY

            for (let j = 0; j < newRgb.length; j++) {
                if (used[j]) continue
                const dr = newRgb[j].r - initialRgb[i].r
                const dg = newRgb[j].g - initialRgb[i].g
                const db = newRgb[j].b - initialRgb[i].b
                const dist = dr * dr + dg * dg + db * db
                if (dist < bestDist) {
                    bestDist = dist
                    bestIdx = j
                }
            }

            if (bestIdx === -1) {
                bestIdx = i % newRgb.length
            }
            used[bestIdx] = true

            const newTargetColor = colors[bestIdx]

            // Если переход уже шёл — фиксируем его перед запуском нового,
            // чтобы не хранить «предыдущий предыдущего» цвет.
            if (blob.colorMix < 1) {
                blob.color = blob.targetColor
                blob.colorMix = 1
                if (newTargetColor === blob.color) {
                    blob.targetColor = newTargetColor
                    return
                }
            } else if (newTargetColor === blob.targetColor) {
                return // уже целимся в нужный цвет, делать нечего
            }

            if (newTargetColor === blob.color) {
                blob.targetColor = newTargetColor
                return // цвет уже совпадает, переход не нужен
            }

            // Запускаем новый переход: blob.color — «от», newTargetColor — «к».
            // Объекты текстур не нужны — фрагментный шейдер lerp'ит между двумя цветами.
            blob.targetColor = newTargetColor
            blob.colorMix = 0
        })
        if (trackId) {
            this.lastAppliedTrackId = trackId
        }
        this.lastPaletteUpdateTime = Date.now()
        log('palette updated', colors)
    }

    // -------------------------------------------------------------------------
    // Цветовая математика (без изменений относительно 2D-версии)
    // -------------------------------------------------------------------------

    private get effectiveFadeMs(): number {
        const fade = this.settings.paletteFadeMs
        if (fade <= 0) return 0.001
        return fade / Math.max(0.01, this.settings.paletteBlendSpeed)
    }

    private shuffle<T>(arr: T[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = arr[i]
            arr[i] = arr[j]
            arr[j] = tmp
        }
    }

    // -------------------------------------------------------------------------
    // Извлечение цветов (без изменений — всё ещё использует 2D-canvas для чтения пикселей)
    // -------------------------------------------------------------------------

    private extractColors(img: HTMLImageElement): string[] {
        const c = document.createElement('canvas')
        const x = c.getContext('2d')
        if (!x) {
            log('extractColors: 2d context unavailable, using fallback palette')
            return FALLBACK_PALETTE
        }
        try {
            const W = img.naturalWidth || COVER_DEFAULT_SIZE_PX
            const H = img.naturalHeight || COVER_DEFAULT_SIZE_PX
            c.width = W
            c.height = H
            x.drawImage(img, 0, 0, W, H)
            const data = x.getImageData(0, 0, W, H).data
            const totalPixels = W * H
            const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / COVER_SAMPLE_TARGET_COUNT)))

            const cells: { r: number; g: number; b: number; weight: number }[] = []
            for (let py = 0; py < H; py += step) {
                for (let px = 0; px < W; px += step) {
                    const idx = (py * W + px) * 4
                    cells.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2], weight: step * step })
                }
            }

            if (cells.length === 0) return FALLBACK_PALETTE

            this.shuffle(cells)

            const MERGE_DIST_SQ = CLUSTER_MERGE_RGB_DIST * CLUSTER_MERGE_RGB_DIST
            type Cluster = { r: number; g: number; b: number; weight: number }
            const clusters: Cluster[] = []

            for (const cell of cells) {
                let bestIdx = -1
                let bestDist = Number.POSITIVE_INFINITY
                for (let i = 0; i < clusters.length; i++) {
                    const dr = clusters[i].r - cell.r
                    const dg = clusters[i].g - cell.g
                    const db = clusters[i].b - cell.b
                    const dist = dr * dr + dg * dg + db * db
                    if (dist < MERGE_DIST_SQ && dist < bestDist) {
                        bestDist = dist
                        bestIdx = i
                    }
                }
                if (bestIdx === -1) {
                    clusters.push({ r: cell.r, g: cell.g, b: cell.b, weight: cell.weight })
                } else {
                    const cl = clusters[bestIdx]
                    const total = cl.weight + cell.weight
                    cl.r = (cl.r * cl.weight + cell.r * cell.weight) / total
                    cl.g = (cl.g * cl.weight + cell.g * cell.weight) / total
                    cl.b = (cl.b * cl.weight + cell.b * cell.weight) / total
                    cl.weight = total
                }
            }

            clusters.sort((a, b) => b.weight - a.weight)

            const colors = clusters.slice(0, EXTRACTED_PALETTE_SIZE).map(cl => rgbToHex(Math.round(cl.r), Math.round(cl.g), Math.round(cl.b)))
            log('extracted colors from cover', colors)
            return colors
        } catch (err) {
            log('extractColors: failed to read pixels (likely cross-origin), using fallback palette', err)
            return FALLBACK_PALETTE
        }
    }

    // -------------------------------------------------------------------------
    // Применение палитры
    // -------------------------------------------------------------------------

    private applyPalette(colors: string[], dominant?: string, trackId?: string | null): void {
        const wasEmpty = this.blobs.length === 0
        if (wasEmpty) {
            this.createBlobs(colors)
            if (trackId) this.lastAppliedTrackId = trackId
        } else {
            this.updatePalette(colors, trackId)
        }

        if (dominant) {
            if (wasEmpty) {
                this.backgroundColor = dominant
                this.targetBackgroundColor = dominant
                this.backgroundMix = 1
            } else if (dominant !== this.targetBackgroundColor) {
                this.backgroundColor = this.targetBackgroundColor
                this.targetBackgroundColor = dominant
                this.backgroundMix = 0
            }
        }
    }

    // -------------------------------------------------------------------------
    // Загрузка обложки
    // -------------------------------------------------------------------------

    private applyCover(img: HTMLImageElement, force: boolean = false): void {
        const src = this.pickCoverUrl(img)
        if (force === false) {
            if (this.usingJsonPalette) {
                log('applyCover: источник палитры = "derivedColors", изменение обложки игнорируется')
                return
            }
            if (!src) {
                log('applyCover: cover image has no src, skipping')
                return
            }
            if (src === this.pendingCoverSrc) {
                log(`applyCover: src=${src} уже в очереди на дебаунс, повтор игнорируется`)
                return
            }
            if (src === this.lastAppliedSrc) {
                log(`applyCover: src=${src} совпадает с уже применённым, пропуск`)
                return
            }
        }
        log(`applyCover: получен новый запрос (src=${src}, force=${force}), запускаем дебаунс на ${COVER_DEBOUNCE_MS}мс`)

        this.pendingCoverSrc = src
        if (this.coverDebounceTimer !== null) window.clearTimeout(this.coverDebounceTimer)
        this.coverDebounceTimer = window.setTimeout(() => {
            this.coverDebounceTimer = null
            const pending = this.pendingCoverSrc
            this.pendingCoverSrc = null
            if (!pending) return
            log(`applyCover: дебаунс завершён, загружаем обложку src=${pending}`)
            this.loadCover(pending)
        }, COVER_DEBOUNCE_MS)
    }

    private loadCover(src: string): void {
        const requestId = ++this.coverRequestId
        log(`loadCover: начало загрузки изображения (requestId=${requestId}) src=${src}`)
        const corsImage = new Image()
        corsImage.crossOrigin = 'anonymous'
        corsImage.referrerPolicy = 'no-referrer'
        corsImage.onload = () => {
            if (requestId !== this.coverRequestId) {
                log(`loadCover.onload: requestId=${requestId} устарел (текущий=${this.coverRequestId}), результат игнорируется`)
                return
            }
            log(`loadCover.onload: изображение загружено успешно, извлекаем палитру (src=${src})`)
            const base = this.extractColors(corsImage)
            this.basePalette = base
            this.coverTopPalette = base.slice(0, 2)
            const dominant = dominantBgFromPalette(base, this.settings.bgLightness)
            this.applyPalette(base, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.onerror = () => {
            if (requestId !== this.coverRequestId) {
                log(`loadCover.onerror: requestId=${requestId} устарел (текущий=${this.coverRequestId}), ошибка игнорируется`)
                return
            }
            log(`applyCover: CORS load failed for ${src}, using fallback palette`)
            this.basePalette = [...FALLBACK_PALETTE]
            this.coverTopPalette = FALLBACK_PALETTE.slice(0, 2)
            const dominant = dominantBgFromPalette(FALLBACK_PALETTE, this.settings.bgLightness)
            this.applyPalette(FALLBACK_PALETTE, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.src = src
    }

    private findCover(): HTMLImageElement | null {
        const modal = this.container.matches(MODAL_SELECTOR) ? this.container : this.container.querySelector(MODAL_SELECTOR)
        if (!modal) {
            log('findCover: модальное окно плеера не найдено в DOM')
            return null
        }
        const poster = modal.querySelector(POSTER_CONTENT_SELECTOR)
        if (!poster) {
            log('findCover: контейнер обложки (poster content) не найден внутри модального окна')
            return null
        }
        const img = poster.querySelector(COVER_SELECTOR)
        if (!(img instanceof HTMLImageElement)) {
            log('findCover: элемент обложки не найден или не является <img>')
            return null
        }
        return img
    }

    private pickCoverUrl(img: HTMLImageElement): string {
        const srcset = img.srcset || img.getAttribute('srcset') || ''
        if (srcset) {
            const candidates = srcset
                .split(',')
                .map(p => p.trim())
                .filter(Boolean)
                .map(p => {
                    const [url, descriptor] = p.split(/\s+/, 2)
                    return { url, descriptor: descriptor ?? '' }
                })
                .filter(c => c.url)
            log(`pickCoverUrl: найден srcset с ${candidates.length} кандидатами`)

            const byPixels = candidates
                .map(c => {
                    const m = /(\d+)w/.exec(c.descriptor)
                    return { url: c.url, pixels: m ? Number(m[1]) : 0 }
                })
                .filter(c => c.pixels > 0)
                .sort((a, b) => b.pixels - a.pixels)
            if (byPixels.length > 0) {
                log(`pickCoverUrl: выбран вариант по ширине (${byPixels[0].pixels}w): ${byPixels[0].url}`)
                return byPixels[0].url
            }

            const byDensity = candidates
                .map(c => {
                    const m = /^([\d.]+)x$/.exec(c.descriptor)
                    return { url: c.url, density: m ? Number(m[1]) : 1 }
                })
                .sort((a, b) => b.density - a.density)
            if (byDensity.length > 0 && byDensity[0].density > 1) {
                log(`pickCoverUrl: выбран вариант по плотности (${byDensity[0].density}x): ${byDensity[0].url}`)
                return byDensity[0].url
            }

            log(`pickCoverUrl: ни ширина, ни плотность не определились, берём последний кандидат из srcset`)
            return candidates[candidates.length - 1].url
        }
        const fallback = img.currentSrc || img.src || ''
        log(`pickCoverUrl: srcset отсутствует, используем currentSrc/src="${fallback}"`)
        return fallback
    }

    // -------------------------------------------------------------------------
    // Настройки
    // -------------------------------------------------------------------------

    applySettings(settings: Partial<AddonRuntimeSettings>): void {
        log('applySettings: получены новые настройки от PulseSync', settings)
        const next = sanitizeSettings(settings)
        const prev = this.settings

        if (this.fpsElement && next.showFps !== prev.showFps) {
            this.fpsElement.style.display = next.showFps ? 'block' : 'none'
            log(`applySettings: fps counter ${next.showFps ? 'shown' : 'hidden'}`)
        }

        if (next.filter !== prev.filter) {
            this.applyCanvasFilter(next.filter)
            log(`applySettings: filter changed → ${next.filter}`)
        }

        if (this.disabled && next.enabled) {
            log('applySettings: addon re-enabled; reopen player to apply')
            return
        }

        if (!next.enabled && !this.disabled) {
            this.disabled = true
            log('applySettings: addon disabled by user')
            return
        }

        const bgChanged = next.bgLightness !== prev.bgLightness
        if (bgChanged && this.basePalette.length > 0) {
            // Пересчитываем доминирующий цвет от той же палитры — пользователь меняет
            // только интенсивность приглушения, оттенок должен сохраниться.
            const currentHex = this.targetBackgroundColor
            const currentPalette = this.basePalette
            const recomputed = dominantBgFromPalette(currentPalette, next.bgLightness)
            this.backgroundColor = currentHex
            this.targetBackgroundColor = recomputed
            this.backgroundMix = 0
            log(`applySettings: bgLightness changed → ${next.bgLightness} (new bg=${recomputed})`)
        }

        const blobCountChanged = next.blobCountMin !== prev.blobCountMin
        const blobSpeedChanged = next.blobSpeed !== prev.blobSpeed
        const paletteSourceChanged = next.paletteSource !== prev.paletteSource

        // Шейдерные эффекты (warp/flow/saturation/highlight) обновляются «на лету»
        // через uniform1f — никакой recompile шейдера и recreateBlobs() не нужен.
        if (this.program && !this.disabled) {
            const gl = this.gl
            gl.useProgram(this.program)
            if (next.warp !== prev.warp) {
                gl.uniform1f(this.uWarp, next.warp)
                log(`applySettings: warp → ${next.warp}`)
            }
            if (next.flow !== prev.flow) {
                gl.uniform1f(this.uFlow, next.flow)
                log(`applySettings: flow → ${next.flow}`)
            }
            if (next.saturation !== prev.saturation) {
                gl.uniform1f(this.uSaturation, next.saturation)
                log(`applySettings: saturation → ${next.saturation}`)
            }
            if (next.highlight !== prev.highlight) {
                gl.uniform1f(this.uHighlight, next.highlight)
                log(`applySettings: highlight → ${next.highlight}`)
            }
            gl.useProgram(null)
        }

        this.settings = next

        if ((blobCountChanged || blobSpeedChanged) && this.blobs.length > 0) {
            this.recreateBlobs()
            log(`applySettings: blobs recreated (countMin=${next.blobCountMin}, speed=${next.blobSpeed})`)
        }

        // Смена источника палитры — переключаем режим: останавливаем поллер/observer
        // (где не нужно) и запускаем заново под новый режим. Палитра подгружается
        // сразу же, без ожидания следующего события.
        if (paletteSourceChanged && !this.disabled) {
            log(`applySettings: paletteSource changed: "${prev.paletteSource}" → "${next.paletteSource}", переключаем режим`)
            this.applyPaletteFromSource(true)
        }
    }

    // Объединяет внутренний blur для смягчения блобов и опциональный CSS-фильтр,
    // заданный пользователем, в одно значение `filter` на элементе canvas.
    //
    // Заменяет исходный подход с ctx.filter:
    //   - Канвас имеет ПРОЗРАЧНЫЙ фон (WebGL очищается в α=0).
    //   - Цвет фона хранится в bgDiv позади canvas и не подвержен blur'у.
    //   - CSS-blur на canvas визуально смягчает только пиксели блобов.
    private applyCanvasFilter(userFilter: string): void {
        const userPart = userFilter && userFilter !== 'none' ? ` ${userFilter}` : ''
        this.canvas.style.setProperty('filter', userPart, 'important')
        this.canvas.style.setProperty('opacity', '1', 'important')
        log(`applyCanvasFilter: итоговый CSS-фильтр канваса = "${this.canvas.style.filter || '(пусто)'}"`)
    }

    // Пересоздаёт блобы с новыми настройками числа/скорости, сохраняя текущую палитру.
    private recreateBlobs(): void {
        const palette = this.basePalette.length > 0 ? this.basePalette : FALLBACK_PALETTE
        log(`recreateBlobs: пересоздаём блобы, используем ${this.basePalette.length > 0 ? 'сохранённую basePalette' : 'FALLBACK_PALETTE'}`)
        this.createBlobs(palette)
        // Все блобы стартуют в стабильном состоянии (без незавершённых переходов).
        for (const blob of this.blobs) {
            blob.colorMix = 1
            blob.color = blob.targetColor
        }
    }

    // -------------------------------------------------------------------------
    // Обновление состояния за кадр
    // -------------------------------------------------------------------------
    private updateBlobs(dt: number): void {
        this.animationTime += dt
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight
        const fadeMs = this.effectiveFadeMs

        for (const blob of this.blobs) {
            blob.baseX = Math.min(Math.max(blob.baseX, 0), width)
            blob.baseY = Math.min(Math.max(blob.baseY, 0), height)

            blob.currentRadius = blob.radius + Math.sin(this.animationTime * blob.pulseSpeed + blob.pulsePhase) * BLOB_PULSE_AMPLITUDE

            if (blob.color !== blob.targetColor) {
                blob.colorMix = Math.min(1, blob.colorMix + dt / fadeMs)
                if (blob.colorMix >= 1) {
                    debug(`updateBlobs: переход цвета блоба завершён (${blob.color} → ${blob.targetColor})`)
                    blob.color = blob.targetColor
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // WebGL2-рендер
    // -------------------------------------------------------------------------
    private draw(time: number): void {
        const gl = this.gl
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        // --- Цвет фона (рисуется на bgDiv, не на WebGL-канвасе) ---
        if (this.backgroundColor !== this.targetBackgroundColor) {
            this.backgroundMix = Math.min(1, this.backgroundMix + this.lastDt / this.effectiveFadeMs)
            const rawT = this.backgroundMix * this.backgroundMix * (3 - 2 * this.backgroundMix) // smoothstep
            this.backgroundColor = blendHex(this.backgroundColor, this.targetBackgroundColor, rawT)
            if (this.backgroundMix >= 1) this.backgroundColor = this.targetBackgroundColor
        }
        this.bgDiv.style.backgroundColor = this.backgroundColor
        // --- Очищаем WebGL-канвас в полностью прозрачный ---
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        // --- Смешивание: source-over (соответствует исходному ctx.globalCompositeOperation) ---
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

        gl.useProgram(this.program)
        gl.bindVertexArray(this.vao)

        // Глобальные юниформы
        gl.uniform2f(this.uResolution, width, height)
        // u_time — секунды от старта анимации, используется для анимации FBM в шейдере.
        gl.uniform1f(this.uTime, this.animationTime / 1000)
        // u_aspect — отношение сторон, чтобы круглые блобы оставались круглыми
        // на широких экранах (без этого радиальная маска вытягивается в эллипс).
        gl.uniform1f(this.uAspect, height > 0 ? width / height : 1)

        // Матрица поворота (column-major для uniformMatrix2fv):
        //   [ cos  -sin ]     col-major → [cos, sin, -sin, cos]
        //   [ sin   cos ]
        const angle = time * CANVAS_ROTATION_RAD_PER_MS
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        gl.uniformMatrix2fv(this.uRotation, false, [cos, sin, -sin, cos])

        const t = this.animationTime

        for (const blob of this.blobs) {
            const x = blob.baseX + Math.sin(t * blob.speedX + blob.phaseX) * blob.orbitX
            const y = blob.baseY + Math.cos(t * blob.speedY + blob.phaseY) * blob.orbitY
            const r = blob.currentRadius

            gl.uniform2f(this.uBlobCenter, x, y)
            gl.uniform1f(this.uBlobRadius, r)

            // Смешивание цвета — повторяет исходный подход с двумя текстурами и globalAlpha:
            // u_prevColor = старый цвет (blob.color, начало перехода)
            // u_color     = новый цвет (blob.targetColor, конец перехода)
            // u_blendT    = фактор смешивания до smoothstep (0 = старый, 1 = новый)
            let blendT: number
            if (blob.color !== blob.targetColor) {
                const rawT = Math.max(0, Math.min(1, blob.colorMix - blob.colorOffset))
                blendT = rawT * rawT * (3 - 2 * rawT) // smoothstep
            } else {
                blendT = 1.0
            }

            const [pr, pg, pb] = hexToRgbFloat(blob.color)
            const [cr, cg, cb] = hexToRgbFloat(blob.targetColor)
            gl.uniform3f(this.uPrevColor, pr, pg, pb)
            gl.uniform3f(this.uColor, cr, cg, cb)
            gl.uniform1f(this.uBlendT, blendT)

            // Рисуем один quad (TRIANGLE_STRIP, 4 вершины)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        }

        gl.bindVertexArray(null)
        gl.useProgram(null)
    }

    // -------------------------------------------------------------------------
    // MutationObserver на обложку
    // -------------------------------------------------------------------------

    private observeCover(): void {
        if (typeof MutationObserver !== 'undefined') {
            const modal = this.container.matches(MODAL_SELECTOR) ? this.container : this.container.querySelector(MODAL_SELECTOR)
            if (!modal) {
                log('observeCover: modal not found, skipping observer (will retry via reconcileBackground)')
            } else {
                const root = modal.querySelector(POSTER_CONTENT_SELECTOR)
                if (!root) {
                    log('observeCover: poster content not found in modal, skipping observer')
                } else if (root === this.observedPosterRoot && this.coverObserver) {
                    log('observeCover: poster-content узел не изменился, observer уже активен — пропуск')
                } else {
                    this.coverObserver?.disconnect()
                    this.coverObserver = new MutationObserver(records => {
                        log(`coverObserver: получено ${records.length} записей мутаций`)
                        for (const record of records) {
                            if (record.type !== 'attributes' || record.attributeName !== 'src') continue
                            const target = record.target
                            if (target instanceof HTMLImageElement && target.matches(COVER_SELECTOR)) {
                                log('cover image src changed', target.src)
                                this.applyCover(target)
                            }
                        }
                    })
                    this.coverObserver.observe(root, {
                        subtree: true,
                        attributes: true,
                        attributeFilter: ['src', 'srcset'],
                        childList: true,
                    })
                    this.observedPosterRoot = root
                    log('cover observer started')
                }
            }
        } else {
            log('observeCover: MutationObserver unavailable')
        }
    }
}
// ---------------------------------------------------------------------------
// Bootstrap (точка входа)
// ---------------------------------------------------------------------------

let backgroundInstance: CanvasBackground | null = null
let retryTimer: number | null = null
let retriesLeft = MAX_RETRIES

function clearRetry(): void {
    if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
        log('clearRetry: таймер повторной попытки отменён')
    }
}

function ensureBackground(): void {
    if (backgroundInstance) return
    const container = document.querySelector(MODAL_SELECTOR) as HTMLElement | null
    if (!container) {
        if (retriesLeft <= 0) {
            log(`ensureBackground: modal not found after ${MAX_RETRIES} retries, giving up`)
            return
        }
        retriesLeft -= 1
        log(`ensureBackground: modal not found, retry in ${RETRY_DELAY_MS}ms (left: ${retriesLeft})`)
        clearRetry()
        retryTimer = window.setTimeout(() => {
            retryTimer = null
            ensureBackground()
        }, RETRY_DELAY_MS)
        return
    }
    try {
        const runtime = readRuntimeSettings()
        log(`ensureBackground: initial settings ${describeRuntimeSettings(runtime)}`)
        backgroundInstance = new CanvasBackground(container, runtime)
        clearRetry()
        retriesLeft = MAX_RETRIES
    } catch (err) {
        error('failed to start background', err)
    }
}

function reconcileBackground(): void {
    log('reconcileBackground: проверка состояния текущего фона')
    if (backgroundInstance && !backgroundInstance.isContainerAlive()) {
        log('reconcileBackground: container detached, recreating')
        backgroundInstance.destroy()
        backgroundInstance = null
    }
    if (!backgroundInstance) {
        log('reconcileBackground: экземпляр фона отсутствует, вызываем ensureBackground()')
        ensureBackground()
        return
    }
    log('reconcileBackground: экземпляр фона жив, запрашиваем обновление палитры')
    backgroundInstance.requestPaletteRefresh()
}

function thisOrDescendantMatches(node: Node, selector: string): boolean {
    if (!(node instanceof Element)) return false
    if (node.matches(selector)) return true
    return node.querySelector(selector) !== null
}

function anyAddedNodeMatches(nodes: NodeList, selector: string): boolean {
    for (const node of Array.from(nodes)) {
        if (node instanceof Element && node.matches(selector)) return true
    }
    return false
}

function watchModal(): void {
    const settingsStore = getAddonSettings(addonConfig.name)
    settingsStore.onChange(nextSettings => {
        const runtime = buildRuntimeSettingsFromStore(nextSettings)
        log(`settings changed: ${describeRuntimeSettings(runtime)}`)
        backgroundInstance?.applySettings(runtime)
    })

    ensureBackground()

    const observer = new MutationObserver(records => {
        debug(`modal watcher: получено ${records.length} записей childList-мутаций из document.body`)
        for (const record of records) {
            if (record.type !== 'childList') continue
            const interesting =
                thisOrDescendantMatches(record.target, MODAL_SELECTOR) ||
                thisOrDescendantMatches(record.target, COVER_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, MODAL_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, COVER_SELECTOR)
            if (interesting) {
                debug('modal watcher: обнаружено релевантное изменение DOM (модалка/обложка), вызываем reconcileBackground()')
                if (retryTimer === null) reconcileBackground()
                return
            }
        }
    })

    const observeRoot = (): void => {
        const target = document.body ?? document.documentElement
        if (target) {
            observer.observe(target, { childList: true, subtree: true })
            log('modal watcher started')
        }
    }

    if (document.body) {
        observeRoot()
    } else {
        document.addEventListener('DOMContentLoaded', observeRoot, { once: true })
    }
}

log('addon loaded')

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchModal, { once: true })
} else {
    watchModal()
}
