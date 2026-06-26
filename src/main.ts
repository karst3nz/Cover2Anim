import './styles.css'

import addonConfig from '../addon.config.mjs'
import { getAddonSettings, readBooleanSetting, readNumberSetting } from './pulsesync'
import {
    BG_LIGHTNESS,
    BG_LIGHTNESS_MAX,
    BG_LIGHTNESS_MIN,
    BLOB_COUNT_DIVISOR_PX,
    BLOB_COUNT_MAX,
    BLOB_COUNT_MIN,
    BLOB_COUNT_MIN_SETTING_MAX,
    BLOB_COUNT_MIN_SETTING_MIN,
    BLOB_ORBIT_MAX,
    BLOB_ORBIT_MIN,
    BLOB_PULSE_AMPLITUDE,
    BLOB_RADIUS_INITIAL,
    BLOB_RADIUS_MAX,
    BLOB_RADIUS_MIN,
    BLOB_SPEED_DRIFT_MAX,
    BLOB_SPEED_DRIFT_MIN,
    BLOB_SPEED_MAX,
    BLOB_SPEED_MIN,
    BLOB_SPEED_PULSE_MAX,
    BLOB_SPEED_PULSE_MIN,
    BLOB_TEXTURE_ALPHA_CORE,
    BLOB_TEXTURE_ALPHA_EDGE,
    BLOB_TEXTURE_ALPHA_MID,
    BLOB_TEXTURE_SIZE_PX,
    BLUR_DESKTOP_PX,
    BLUR_MOBILE_PX,
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
    LOG_PREFIX,
    MAX_RETRIES,
    MODAL_SELECTOR,
    MOBILE_BREAKPOINT_PX,
    PALETTE_BLEND_SPEED_MAX,
    PALETTE_BLEND_SPEED_MIN,
    PALETTE_FADE_MS,
    PALETTE_FADE_MS_MAX,
    PALETTE_FADE_MS_MIN,
    PALETTE_WAVE_SPREAD,
    POSTER_CONTENT_SELECTOR,
    RETRY_DELAY_MS,
    SETTING_KEY_BG_LIGHTNESS,
    SETTING_KEY_BLOB_COUNT_MIN,
    SETTING_KEY_BLOB_SPEED,
    SETTING_KEY_ENABLED,
    SETTING_KEY_PALETTE_BLEND_SPEED,
    SETTING_KEY_PALETTE_FADE_MS,
    SETTING_KEY_SHOW_FPS,
} from './constants'


function log(message: string, ...args: unknown[]): void {
    console.log(`${LOG_PREFIX} ${message}`, ...args)
}

function warn(message: string, ...args: unknown[]): void {
    console.warn(`${LOG_PREFIX} ${message}`, ...args)
}

function error(message: string, ...args: unknown[]): void {
    console.error(`${LOG_PREFIX} ${message}`, ...args)
    for (const arg of args) {
        if (arg instanceof Error) {
            if (arg.message) {
                console.error(`${LOG_PREFIX}   message:`, arg.message)
            }
            if (arg.stack) {
                console.error(`${LOG_PREFIX}   stack:`, arg.stack)
            }
        }
    }
}

type Blob = {
    color: string
    targetColor: string
    texture: HTMLCanvasElement
    previousTexture: HTMLCanvasElement | null
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
    colorMix: number
    colorOffset: number
}

// Все читаемые из PulseSync настройки + runtime-параметры, которые из них выводятся.
// Изменяются на лету через applySettings: поля с пометкой «blob-affecting» требуют
// пересоздания blob'ов (recreateBlobs), остальные применяются мгновенно.
type AddonRuntimeSettings = {
    enabled: boolean
    showFps: boolean
    paletteFadeMs: number
    blobCountMin: number
    blobSpeed: number
    bgLightness: number
    paletteBlendSpeed: number
}

// Дефолты — fallback, если пользователь ещё ничего не менял в UI PulseSync.
// Эти числа должны совпадать со «старыми» жёстко зашитыми константами,
// чтобы при первом запуске аддон вёл себя идентично прежней версии.
const DEFAULT_RUNTIME_SETTINGS: AddonRuntimeSettings = {
    enabled: true,
    showFps: false,
    paletteFadeMs: PALETTE_FADE_MS,
    blobCountMin: BLOB_COUNT_MIN,
    blobSpeed: 1,
    bgLightness: BG_LIGHTNESS,
    paletteBlendSpeed: 1,
}

// Жёсткие диапазоны для sanitize'а значений из PulseSync (UI может прислать что угодно).
function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min
    }
    return Math.min(max, Math.max(min, value))
}

function sanitizeSettings(raw: Partial<AddonRuntimeSettings>): AddonRuntimeSettings {
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_RUNTIME_SETTINGS.enabled,
        showFps: typeof raw.showFps === 'boolean' ? raw.showFps : DEFAULT_RUNTIME_SETTINGS.showFps,
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
    }
}

// Читает все настройки аддона из PulseSync и собирает в `Partial<AddonRuntimeSettings>`.
// sanitizeSettings доведёт значения до безопасных диапазонов позже.
function readRuntimeSettings(): Partial<AddonRuntimeSettings> {
    const settingsStore = getAddonSettings(addonConfig.name)
    const settings = settingsStore.getCurrent()
    return {
        enabled: readBooleanSetting(settings, SETTING_KEY_ENABLED, DEFAULT_RUNTIME_SETTINGS.enabled),
        showFps: readBooleanSetting(settings, SETTING_KEY_SHOW_FPS, DEFAULT_RUNTIME_SETTINGS.showFps),
        paletteFadeMs: readNumberSetting(settings, SETTING_KEY_PALETTE_FADE_MS, DEFAULT_RUNTIME_SETTINGS.paletteFadeMs),
        paletteBlendSpeed: readNumberSetting(settings, SETTING_KEY_PALETTE_BLEND_SPEED, DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed),
        blobCountMin: readNumberSetting(settings, SETTING_KEY_BLOB_COUNT_MIN, DEFAULT_RUNTIME_SETTINGS.blobCountMin),
        blobSpeed: readNumberSetting(settings, SETTING_KEY_BLOB_SPEED, DEFAULT_RUNTIME_SETTINGS.blobSpeed),
        bgLightness: readNumberSetting(settings, SETTING_KEY_BG_LIGHTNESS, DEFAULT_RUNTIME_SETTINGS.bgLightness),
    }
}

class CanvasBackground {
    private readonly container: HTMLElement
    private readonly canvas: HTMLCanvasElement
    private readonly ctx: CanvasRenderingContext2D

    private blobs: Blob[] = []
    private animationTime = 0
    private lastTime = 0
    private lastDt = INITIAL_FRAME_DELTA_MS
    private rafId = 0
    private resizeObserver: ResizeObserver | null = null
    private coverObserver: MutationObserver | null = null

    private settings: AddonRuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS }
    private basePalette: string[] = []
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

    constructor(container: HTMLElement, initialSettings?: Partial<AddonRuntimeSettings>) {
        this.container = container
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'c2a-canvas-bg'
        const ctx = this.canvas.getContext('2d')
        if (!ctx) {
            const isConnected = container.isConnected
            const rect = container.getBoundingClientRect()
            throw new Error(
                `cannot acquire 2d context (connected=${isConnected}, ` +
                    `rect=${rect.width}x${rect.height}, ` +
                    `owner=${container.ownerDocument === document ? 'document' : 'detached'})`,
            )
        }
        this.ctx = ctx

        // Применяем переданные настройки до проверки enabled: если пользователь
        // ранее сохранил showFps=true в pulsesync.settings.json, FPS-счётчик
        // должен появиться сразу, без необходимости тогглать чекбокс.
        if (initialSettings) {
            this.settings = sanitizeSettings(initialSettings)
        }

        if (!this.settings.enabled) {
            this.disabled = true
            log('background disabled by setting')
            return
        }

        this.container.insertBefore(this.canvas, this.container.firstChild)
        this.container.classList.add('canvas-mode')

        this.createFpsElement()
        this.resize()
        this.startAnimation()

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.resize())
            this.resizeObserver.observe(this.container)
        } else {
            window.addEventListener('resize', this.onWindowResize)
        }

        // Сразу создаём blob'ы с дефолтной палитрой, чтобы анимация появилась мгновенно,
        // не дожидаясь загрузки обложки через CORS-Image.
        const initialDominant = this.darken(FALLBACK_PALETTE[0], this.settings.bgLightness)
        this.applyPalette(FALLBACK_PALETTE, initialDominant)

        const initial = this.findCover()
        if (initial) {
            this.applyCover(initial)
        }
        this.observeCover()

        log('background attached to', container)
    }

    destroy(): void {
        cancelAnimationFrame(this.rafId)
        if (this.coverDebounceTimer !== null) {
            window.clearTimeout(this.coverDebounceTimer)
            this.coverDebounceTimer = null
            log('cover debounce timer stopped')
        }
        this.resizeObserver?.disconnect()
        this.coverObserver?.disconnect()
        window.removeEventListener('resize', this.onWindowResize)
        this.container.classList.remove('canvas-mode')
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
        const current = this.findCover()
        if (current) {
            this.applyCover(current)
        }
    }

    private onWindowResize = (): void => {
        this.resize()
    }

    private resize(): void {
        const dpr = window.devicePixelRatio || 1
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        const newCanvasWidth = width * dpr
        const newCanvasHeight = height * dpr

        // Сохраняем текущий кадр (в пикселях старого размера), чтобы сразу после
        // сброса canvas браузером вернуть его на место и не было видно чёрного фрейма.
        let snapshot: ImageData | null = null
        if (this.canvas.width > 0 && this.canvas.height > 0) {
            try {
                snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
            } catch {
                snapshot = null
            }
        }

        this.canvas.width = newCanvasWidth
        this.canvas.height = newCanvasHeight
        this.canvas.style.width = width + 'px'
        this.canvas.style.height = height + 'px'

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        // Растягиваем старый кадр на новый размер — без чёрного мерцания между
        // resize и следующим RAF.
        if (snapshot) {
            try {
                const tmp = document.createElement('canvas')
                tmp.width = snapshot.width
                tmp.height = snapshot.height
                const tx = tmp.getContext('2d')
                if (tx) {
                    tx.putImageData(snapshot, 0, 0)
                    this.ctx.imageSmoothingEnabled = true
                    this.ctx.drawImage(tmp, 0, 0, snapshot.width, snapshot.height, 0, 0, newCanvasWidth, newCanvasHeight)
                }
            } catch {
                // ignore — следующий кадр RAF перерисует корректно
            }
        } else {
            // Если снапшота нет, сразу закрашиваем фон, чтобы первый кадр не был чёрным.
            this.ctx.fillStyle = this.backgroundColor
            this.ctx.fillRect(0, 0, width, height)
        }
    }

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

    private createFpsElement(): void {
        // DOM-узел создаётся один раз. CSS-стили (.c2a-fps) лежат в
        // src/styles.css — здесь только позиционирование и начальная видимость.
        const el = document.createElement('div')
        el.className = 'c2a-fps'
        el.textContent = '— FPS'
        el.style.display = this.settings.showFps ? 'block' : 'none'
        this.container.appendChild(el)
        this.fpsElement = el
        // Сбрасываем счётчик, чтобы первая секунда не считалась от нуля.
        this.fpsFrames = 0
        this.fpsLastSampleTime = 0
    }

    private tickFps(time: number): void {
        if (!this.fpsElement) {
            return
        }
        this.fpsFrames += 1
        if (this.fpsLastSampleTime === 0) {
            // Первый кадр — фиксируем точку отсчёта, sample посчитаем следующим.
            this.fpsLastSampleTime = time
            return
        }
        const elapsed = time - this.fpsLastSampleTime
        if (elapsed < FPS_UPDATE_INTERVAL_MS) {
            return
        }
        const fps = (this.fpsFrames * 1000) / elapsed
        this.fpsElement.textContent = `${Math.round(fps)} FPS`
        this.fpsFrames = 0
        this.fpsLastSampleTime = time
    }

    private createBlobTexture(color: string, size = BLOB_TEXTURE_SIZE_PX): HTMLCanvasElement {
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const x = c.getContext('2d')
        if (!x) {
            return c
        }

        const gradient = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
        // Ядро блоба делаем alpha=0xcc (≈0.8) вместо 0xff (1.0): при слиянии
        // 3-4 блобов под source-over пиковая сумма альф остаётся < 1.0, цвет
        // не клиппится и зона наложения сохраняет палитру обложки.
        gradient.addColorStop(0, color + BLOB_TEXTURE_ALPHA_CORE)
        gradient.addColorStop(0.5, color + BLOB_TEXTURE_ALPHA_MID)
        gradient.addColorStop(1, color + BLOB_TEXTURE_ALPHA_EDGE)

        x.fillStyle = gradient
        x.fillRect(0, 0, size, size)
        return c
    }

    private createBlobs(colors: string[]): void {
        this.blobs = []
        const isMobile = window.innerWidth < MOBILE_BREAKPOINT_PX
        // blobCountMin приходит из настроек PulseSync, BLOB_COUNT_MAX — производное
        // (×2 от MIN), чтобы десктопная плотность blob'ов всегда была в 2× от мобильной.
        const minCount = this.settings.blobCountMin
        const maxCount = minCount * 2
        const count = isMobile
            ? minCount
            : Math.max(minCount, Math.min(maxCount, Math.floor(window.innerWidth / BLOB_COUNT_DIVISOR_PX)))
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        const radiusRange = BLOB_RADIUS_MAX - BLOB_RADIUS_MIN
        const orbitRange = BLOB_ORBIT_MAX - BLOB_ORBIT_MIN
        // blobSpeed из настроек PulseSync — множитель к базовым диапазонам.
        // При 1.0 диапазоны дрейфа/пульсации совпадают со «старыми» константами,
        // при 4 — blob'ы носятся в 4 раза быстрее.
        const speedScale = this.settings.blobSpeed
        const driftMin = BLOB_SPEED_DRIFT_MIN * speedScale
        const driftMax = BLOB_SPEED_DRIFT_MAX * speedScale
        const pulseMin = BLOB_SPEED_PULSE_MIN * speedScale
        const pulseMax = BLOB_SPEED_PULSE_MAX * speedScale
        const driftRange = driftMax - driftMin
        const pulseSpeedRange = pulseMax - pulseMin

        for (let i = 0; i < count; i++) {
            const color = colors[i % colors.length]
            this.blobs.push({
                color,
                targetColor: color,
                texture: this.createBlobTexture(color),
                previousTexture: null,
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
                pulseSpeed: pulseMin + Math.random() * pulseSpeedRange,
                colorMix: 1,
                colorOffset: (i / count) * PALETTE_WAVE_SPREAD,
            })
        }
        log(`created ${this.blobs.length} blobs from palette (speedScale=${speedScale})`, colors)
    }

    private updatePalette(colors: string[]): void {
        if (this.blobs.length === 0 || colors.length === 0) {
            return
        }

        // Растягиваем входную палитру до длины blobs через модуль — это даёт
        // нам стартовый набор targetColor. Затем для каждого blob выбираем
        // ближайший новый цвет по RGB-расстоянию, чтобы плавный бленд не
        // превращался в хаотичное перекрашивание.
        const initialTargets = this.blobs.map((_, i) => colors[i % colors.length])
        const initialRgb = initialTargets.map(hex => this.hexToRgb(hex))
        const newRgb = colors.map(hex => this.hexToRgb(hex))
        const used = new Array<boolean>(newRgb.length).fill(false)

        this.blobs.forEach((blob, i) => {
            let bestIdx = -1
            let bestDist = Number.POSITIVE_INFINITY
            for (let j = 0; j < newRgb.length; j++) {
                if (used[j]) {
                    continue
                }
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
                used[bestIdx] = true
            } else if (!used[bestIdx]) {
                used[bestIdx] = true
            }

            const newTargetColor = colors[bestIdx]
            if (blob.colorMix < 1) {
                blob.previousTexture = blob.texture
                blob.color = blob.targetColor
                blob.colorMix = 1
                if (newTargetColor === blob.color) {
                    blob.targetColor = newTargetColor
                    blob.previousTexture = null
                    return
                }
            } else if (newTargetColor === blob.targetColor) {
                // Цель совпадает и бленд уже дошёл до финала — ничего не делаем.
                return
            }
            if (newTargetColor === blob.color) {
                // Цвет уже отрисовывается финально — синхронизируем targetColor,
                // чистим previousTexture на случай, если он остался от прошлого.
                blob.targetColor = newTargetColor
                blob.previousTexture = null
                return
            }

            // Сохраняем текущую текстуру как «старую» — она будет постепенно
            // угасать в draw() через globalAlpha = 1 - t. Один раз за весь
            // переход, а не на каждом кадре.
            blob.previousTexture = blob.texture
            blob.targetColor = newTargetColor
            blob.colorMix = 0
            // Новая текстура создаётся ровно один раз — до этого бленд
            // опирается на previousTexture и новую текстуру.
            blob.texture = this.createBlobTexture(newTargetColor)
        })
        log('palette updated', colors)
    }

    private lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t
    }

    private hexToRgb(hex: string): { r: number; g: number; b: number } {
        return {
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16),
        }
    }

    private blendHex(a: string, b: string, t: number): string {
        const ca = this.hexToRgb(a)
        const cb = this.hexToRgb(b)
        return (
            '#' +
            [Math.round(this.lerp(ca.r, cb.r, t)), Math.round(this.lerp(ca.g, cb.g, t)), Math.round(this.lerp(ca.b, cb.b, t))]
                .map(v => v.toString(16).padStart(2, '0'))
                .join('')
        )
    }

    // Эффективное время бленда = paletteFadeMs / paletteBlendSpeed.
// paletteFadeMs — полная длительность при скорости 1, paletteBlendSpeed —
// множитель (>1 быстрее, <1 медленнее). При fade=0 бленд мгновенный (dt/0 = Infinity → colorMix сразу 1).
private get effectiveFadeMs(): number {
        const fade = this.settings.paletteFadeMs
        if (fade <= 0) {
            return 0.001
        }
        return fade / Math.max(0.01, this.settings.paletteBlendSpeed)
}

private updateBlobs(dt: number): void {
        this.animationTime += dt
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight
        const fadeMs = this.effectiveFadeMs

        for (const blob of this.blobs) {
            blob.baseX = Math.min(Math.max(blob.baseX, 0), width)
            blob.baseY = Math.min(Math.max(blob.baseY, 0), height)

            blob.currentRadius = blob.radius + Math.sin(this.animationTime * blob.pulseSpeed + blob.pulsePhase) * BLOB_PULSE_AMPLITUDE

            // colorMix накапливает «прошедшее время» бленда в долях от effectiveFadeMs.
            // colorOffset разносит старт бленда по blob'ам, чтобы переход шёл волной.
            // Текстура больше НЕ пересоздаётся на каждом кадре — бленд идёт через
            // наложение previousTexture и texture в draw() с globalAlpha = 1-t / t.
            if (blob.color !== blob.targetColor) {
                blob.colorMix = Math.min(1, blob.colorMix + dt / fadeMs)
                if (blob.colorMix >= 1) {
                    // Бленд завершён — фиксируем целевой цвет, освобождаем previousTexture.
                    blob.color = blob.targetColor
                    blob.previousTexture = null
                }
            }
        }
    }

    private draw(time: number): void {
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        // Закрашиваем canvas фоном, плавно переходящим из старого доминирующего
        // цвета в новый за effectiveFadeMs — синхронно с блендом blob'ов.
        if (this.backgroundColor !== this.targetBackgroundColor) {
            this.backgroundMix = Math.min(1, this.backgroundMix + this.lastDt / this.effectiveFadeMs)
            const rawT = this.backgroundMix * this.backgroundMix * (3 - 2 * this.backgroundMix)
            this.backgroundColor = this.blendHex(this.backgroundColor, this.targetBackgroundColor, rawT)
            if (this.backgroundMix >= 1) {
                this.backgroundColor = this.targetBackgroundColor
            }
        }
        this.ctx.fillStyle = this.backgroundColor
        this.ctx.fillRect(0, 0, width, height)

        this.ctx.save()
        this.ctx.translate(width / 2, height / 2)
        this.ctx.rotate(time * CANVAS_ROTATION_RAD_PER_MS)
        this.ctx.translate(-width / 2, -height / 2)

        // Раньше стоял 'lighter' (аддитивное смешивание): при наложении 3-4
        // блобов RGB быстро упирался в 255 и зона слияния становилась чисто
        // белой. 'source-over' использует alpha-compositing — пиксели смешиваются
        // через альфу, итоговый цвет никогда не белее самого яркого блоба.
        this.ctx.globalCompositeOperation = 'source-over'
        this.ctx.filter = window.innerWidth < MOBILE_BREAKPOINT_PX ? `blur(${BLUR_MOBILE_PX}px)` : `blur(${BLUR_DESKTOP_PX}px)`

        const t = this.animationTime
        for (const blob of this.blobs) {
            const x = blob.baseX + Math.sin(t * blob.speedX + blob.phaseX) * blob.orbitX
            const y = blob.baseY + Math.cos(t * blob.speedY + blob.phaseY) * blob.orbitY
            const r = blob.currentRadius

            // Плавный бленд между previousTexture и texture через globalAlpha.
            // Раньше текстура пересоздавалась на каждом кадре через blendHex +
            // createBlobTexture (до 32 новых offscreen-canvas на кадр в течение
            // секунды), что вызывало рывки и GC-фризы. Теперь две текстуры
            // накладываются с альфой — без аллокаций в горячем пути RAF.
            if (blob.previousTexture) {
                const rawT = Math.max(0, Math.min(1, blob.colorMix - blob.colorOffset))
                // smoothstep: плавный старт и плавный финал, без линейного «разгона»
                const blendT = rawT * rawT * (3 - 2 * rawT)
                if (blendT <= 0) {
                    // Ещё не дошла волна — рисуем только старую текстуру в полную альфу.
                    this.ctx.globalAlpha = 1
                    this.ctx.drawImage(blob.previousTexture, x - r, y - r, r * 2, r * 2)
                } else if (blendT >= 1) {
                    // Волна прошла полностью — рисуем только новую текстуру.
                    this.ctx.globalAlpha = 1
                    this.ctx.drawImage(blob.texture, x - r, y - r, r * 2, r * 2)
                } else {
                    // Переходная фаза: старая угасает, новая разгорается.
                    this.ctx.globalAlpha = 1 - blendT
                    this.ctx.drawImage(blob.previousTexture, x - r, y - r, r * 2, r * 2)
                    this.ctx.globalAlpha = blendT
                    this.ctx.drawImage(blob.texture, x - r, y - r, r * 2, r * 2)
                }
            } else {
                this.ctx.globalAlpha = 1
                this.ctx.drawImage(blob.texture, x - r, y - r, r * 2, r * 2)
            }
        }

        this.ctx.restore()
        this.ctx.filter = 'none'
        this.ctx.globalAlpha = 1
    }

    private rgbToHex(r: number, g: number, b: number): string {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    }

    private darken(hex: string, targetLightness: number): string {
        const { r, g, b } = this.hexToRgb(hex)
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
        // Конвертируем обратно в RGB с фиксированной лёгкостью targetLightness
        const l2 = targetLightness
        const s2 = s
        const c = (1 - Math.abs(2 * l2 - 1)) * s2
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
        const m = l2 - c / 2
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
        return this.rgbToHex(Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255))
    }

    private shuffle<T>(arr: T[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = arr[i]
            arr[i] = arr[j]
            arr[j] = tmp
        }
    }

    private averageColor(img: HTMLImageElement): string {
        const c = document.createElement('canvas')
        const x = c.getContext('2d')
        if (!x) {
            return FALLBACK_PALETTE[0]
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
            let rSum = 0
            let gSum = 0
            let bSum = 0
            let count = 0
            for (let y = 0; y < H; y += step) {
                for (let px = 0; px < W; px += step) {
                    const idx = (y * W + px) * 4
                    rSum += data[idx]
                    gSum += data[idx + 1]
                    bSum += data[idx + 2]
                    count += 1
                }
            }
            if (count === 0) {
                return FALLBACK_PALETTE[0]
            }
            return this.rgbToHex(Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count))
        } catch {
            return FALLBACK_PALETTE[0]
        }
    }

    private extractColors(img: HTMLImageElement): string[] {
        const c = document.createElement('canvas')
        const x = c.getContext('2d')
        if (!x) {
            warn('extractColors: 2d context unavailable, using fallback palette')
            return FALLBACK_PALETTE
        }

        try {
            // Берём полный размер обложки — без downscale. Шаг STEP подбираем так,
            // чтобы общее число сэмплов было в районе ~2000–4000 (быстро и достаточно).
            const W = img.naturalWidth || COVER_DEFAULT_SIZE_PX
            const H = img.naturalHeight || COVER_DEFAULT_SIZE_PX
            c.width = W
            c.height = H
            x.drawImage(img, 0, 0, W, H)
            const data = x.getImageData(0, 0, W, H).data

            // Шаг между сэмплами — максимум ~4000 точек по всей картинке.
            const totalPixels = W * H
            const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / COVER_SAMPLE_TARGET_COUNT)))

            // Каждая ячейка = один сэмпл пикселя, её «вес» — 1 пиксель.
            // Сетка по ВСЕЙ картинке: идём по строкам/столбцам с шагом step,
            // кластеризация ниже сама склеит близкие цвета и усреднит веса.
            const cells: { r: number; g: number; b: number; weight: number }[] = []
            for (let y = 0; y < H; y += step) {
                for (let x = 0; x < W; x += step) {
                    const idx = (y * W + x) * 4
                    cells.push({
                        r: data[idx],
                        g: data[idx + 1],
                        b: data[idx + 2],
                        weight: step * step,
                    })
                }
            }

            if (cells.length === 0) {
                return FALLBACK_PALETTE
            }

            // Перемешиваем сэмплы, чтобы кластеризация не зависела от порядка обхода:
            // первый пиксель не «застолбливает» кластер и не обрастает соседями.
            this.shuffle(cells)

            // Склеиваем близкие цвета (d² в RGB < 4900, ≈70 на канал), суммируя веса.
            // Порог подобран так, чтобы джиттер JPEG/антиалиасинга не плодил
            // ложные кластеры, но разные оттенки (коричневый vs чёрный) не сливались.
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
                    const c = clusters[bestIdx]
                    const total = c.weight + cell.weight
                    c.r = (c.r * c.weight + cell.r * cell.weight) / total
                    c.g = (c.g * c.weight + cell.g * cell.weight) / total
                    c.b = (c.b * c.weight + cell.b * cell.weight) / total
                    c.weight = total
                }
            }

            clusters.sort((a, b) => b.weight - a.weight)

            const colors = clusters.slice(0, EXTRACTED_PALETTE_SIZE).map(cl => this.rgbToHex(Math.round(cl.r), Math.round(cl.g), Math.round(cl.b)))

            log('extracted colors from cover', colors)
            return colors
        } catch (err) {
            warn('extractColors: failed to read pixels (likely cross-origin), using fallback palette', err)
            return FALLBACK_PALETTE
        }
    }

    private applyPalette(colors: string[], dominant?: string): void {
        const wasEmpty = this.blobs.length === 0
        if (wasEmpty) {
            this.createBlobs(colors)
        } else {
            this.updatePalette(colors)
        }

        if (dominant) {
            if (wasEmpty) {
                // При первой инициализации фон сразу = доминирующему, без бленда.
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

    private applyCover(img: HTMLImageElement): void {
        const src = this.pickCoverUrl(img)
        if (!src) {
            warn('applyCover: cover image has no src, skipping')
            return
        }

        // Идемпотентность: coverObserver и reconcileBackground могут звать
        // applyCover почти одновременно с одним и тем же src. Без этой проверки
        // получаем два CORS-запроса и два applyPalette с похожими (но разными
        // из-за JPEG-шума) палитрами — второй бленд ломает плавность первого.
        if (src === this.pendingCoverSrc || src === this.lastAppliedSrc) {
            return
        }

        // Debounce: карусели/превью часто меняют src раз в 50–200 мс.
        // Если бы запускали CORS-загрузку на каждое изменение, получили бы
        // десятки параллельных HTTP-запросов. Ждём COVER_DEBOUNCE_MS «тишины»
        // и грузим только последнюю обложку.
        this.pendingCoverSrc = src
        if (this.coverDebounceTimer !== null) {
            window.clearTimeout(this.coverDebounceTimer)
        }
        this.coverDebounceTimer = window.setTimeout(() => {
            this.coverDebounceTimer = null
            const pending = this.pendingCoverSrc
            this.pendingCoverSrc = null
            if (!pending) {
                return
            }
            this.loadCover(pending)
        }, COVER_DEBOUNCE_MS)
    }

    private loadCover(src: string): void {
        const requestId = ++this.coverRequestId
        const corsImage = new Image()
        corsImage.crossOrigin = 'anonymous'
        corsImage.referrerPolicy = 'no-referrer'
        corsImage.onload = () => {
            if (requestId !== this.coverRequestId) {
                // Более свежий applyCover уже отправлен — отбрасываем устаревший результат.
                return
            }
            const base = this.extractColors(corsImage)
            this.basePalette = base
            // Доминирующий цвет для фона — средневзвешенный по всей картинке.
            // Топ-1 кластер может быть случайным акцентом в углу (иконка лейбла и т.п.),
            // а средний цвет корректно отражает обложку в целом (белый/чёрный/бежевый → серый).
            const rawDominant = this.averageColor(corsImage)
            const dominant = this.darken(rawDominant, this.settings.bgLightness)
            this.applyPalette(base, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.onerror = () => {
            if (requestId !== this.coverRequestId) {
                return
            }
            warn(`applyCover: CORS load failed for ${src}, using fallback palette`)
            this.basePalette = [...FALLBACK_PALETTE]
            const dominant = this.darken(FALLBACK_PALETTE[0], this.settings.bgLightness)
            this.applyPalette(FALLBACK_PALETTE, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.src = src
    }

    private findCover(): HTMLImageElement | null {
        // Строгий scope: ищем обложку ТОЛЬКО внутри блока постера в модалке плеера.
        // Никаких fallback на document/модалку — иначе захватим обложку
        // мини-плеера, превью плейлистов или других треков и перекрасим
        // фон не тем треком.
        const modal = this.container.matches(MODAL_SELECTOR) ? this.container : this.container.querySelector(MODAL_SELECTOR)
        if (!modal) {
            return null
        }
        const poster = modal.querySelector(POSTER_CONTENT_SELECTOR)
        if (!poster) {
            return null
        }
        const img = poster.querySelector(COVER_SELECTOR)
        return img instanceof HTMLImageElement ? img : null
    }

    // Берём самый большой URL из srcset (обычно это 2x версия), иначе src.
    // srcset имеет формат "url 400x400, url 2x" или "url 1x, url 2x".
    private pickCoverUrl(img: HTMLImageElement): string {
        const srcset = img.srcset || img.getAttribute('srcset') || ''
        if (srcset) {
            const candidates = srcset
                .split(',')
                .map(part => part.trim())
                .filter(Boolean)
                .map(part => {
                    const [url, descriptor] = part.split(/\s+/, 2)
                    return { url, descriptor: descriptor ?? '' }
                })
                .filter(c => c.url)

            // 1. Предпочитаем дескриптор с пикселями (например, "800x800")
            const byPixels = candidates
                .map(c => {
                    const match = /(\d+)w/.exec(c.descriptor)
                    const pixels = match ? Number(match[1]) : 0
                    return { url: c.url, pixels }
                })
                .filter(c => c.pixels > 0)
                .sort((a, b) => b.pixels - a.pixels)
            if (byPixels.length > 0) {
                return byPixels[0].url
            }

            // 2. Иначе берём дескриптор с плотностью (например, "2x")
            const byDensity = candidates
                .map(c => {
                    const match = /^([\d.]+)x$/.exec(c.descriptor)
                    const density = match ? Number(match[1]) : 1
                    return { url: c.url, density }
                })
                .sort((a, b) => b.density - a.density)
            if (byDensity.length > 0 && byDensity[0].density > 1) {
                return byDensity[0].url
            }

            // 3. Иначе последний URL в srcset (обычно самый большой)
            return candidates[candidates.length - 1].url
        }
        return img.currentSrc || img.src || ''
    }

    applySettings(settings: Partial<AddonRuntimeSettings>): void {
        const next = sanitizeSettings(settings)
        const prev = this.settings

        // FPS-переключатель применяем ДО общего merge — чтобы UI среагировал,
        // даже если остальные поля не менялись.
        if (this.fpsElement && next.showFps !== prev.showFps) {
            this.fpsElement.style.display = next.showFps ? 'block' : 'none'
            log(`applySettings: fps counter ${next.showFps ? 'shown' : 'hidden'}`)
        }

        // Если аддон был выключен и пользователь включает его — мы не можем
        // «оживить» canvas, потому что constructor уже отработал. Полная
        // переинициализация произойдёт при переоткрытии модалки.
        if (this.disabled && next.enabled) {
            log('applySettings: addon re-enabled; reopen player to apply')
            return
        }

        if (!next.enabled && !this.disabled) {
            this.disabled = true
            log('applySettings: addon disabled by user')
            return
        }

        // bgLightness применяем на лету: пересчитываем targetBackgroundColor
        // через darken, и если бленд в процессе — блендим со старого фона.
        const bgChanged = next.bgLightness !== prev.bgLightness
        if (bgChanged && this.basePalette.length > 0) {
            // Берём текущий отображаемый фон как «rawDominant» и применяем новую яркость.
            // Исходный цвет обложки не сохраняли, но среднее от уже отрисованного фона
            // (this.backgroundColor) близко к нему — для UI-ползунка «яркость» этого
            // достаточно, иначе пришлось бы хранить rawDominant отдельно.
            const currentHue = this.backgroundColor
            this.backgroundColor = this.targetBackgroundColor
            this.targetBackgroundColor = this.darken(currentHue, next.bgLightness)
            this.backgroundMix = 0
            log(`applySettings: bgLightness changed → ${next.bgLightness}`)
        }

        const blobCountChanged = next.blobCountMin !== prev.blobCountMin
        const blobSpeedChanged = next.blobSpeed !== prev.blobSpeed

        this.settings = next

        if ((blobCountChanged || blobSpeedChanged) && this.blobs.length > 0) {
            this.recreateBlobs()
            log(`applySettings: blobs recreated (countMin=${next.blobCountMin}, speed=${next.blobSpeed})`)
        }
    }

    // Пересоздаёт blob'ы с текущей палитрой и обновлёнными blobCount/blobSpeed.
    // Используется при изменении настроек на лету — без сброса backgroundColor
    // и без перезапроса обложки.
    private recreateBlobs(): void {
        const palette = this.basePalette.length > 0 ? this.basePalette : FALLBACK_PALETTE
        this.createBlobs(palette)
        // Если в момент смены шёл бленд — сбрасываем previousTexture у всех blob'ов,
        // иначе draw() попытается интерполировать между текстурой старого цвета и
        // только что созданной текстурой (palette успела примениться).
        for (const blob of this.blobs) {
            blob.previousTexture = null
            blob.colorMix = 1
        }
    }

    private observeCover(): void {
        if (typeof MutationObserver !== 'undefined') {
            // Строгий scope: наблюдаем ТОЛЬКО за блоком постера внутри модалки.
            // Никаких fallback на document/body/модалку — иначе MutationObserver
            // начнёт ловить смены src на чужих обложках (мини-плеер, превью
            // плейлистов) и триггерить applyCover на чужие треки.
            const modal = this.container.matches(MODAL_SELECTOR) ? this.container : this.container.querySelector(MODAL_SELECTOR)
            if (!modal) {
                warn('observeCover: modal not found, skipping observer (will retry via reconcileBackground)')
            } else {
                const root = modal.querySelector(POSTER_CONTENT_SELECTOR)
                if (!root) {
                    warn('observeCover: poster content not found in modal, skipping observer')
                } else {
                    this.coverObserver = new MutationObserver(records => {
                        for (const record of records) {
                            if (record.type !== 'attributes' || record.attributeName !== 'src') {
                                continue
                            }
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
                    log('cover observer started')
                }
            }
        } else {
            warn('observeCover: MutationObserver unavailable')
        }
    }
}

let backgroundInstance: CanvasBackground | null = null
let retryTimer: number | null = null
let retriesLeft = MAX_RETRIES

function clearRetry(): void {
    if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
    }
}

function ensureBackground(): void {
    if (backgroundInstance) {
        return
    }
    const container = document.querySelector(MODAL_SELECTOR) as HTMLElement | null
    if (!container) {
        if (retriesLeft <= 0) {
            warn(`ensureBackground: modal not found after ${MAX_RETRIES} retries, giving up`)
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
        // Читаем текущие настройки аддона и передаём их в конструктор.
        // Если пользователь заранее включил showFps=true в UI PulseSync,
        // FPS-узел должен появиться сразу при открытии модалки — без
        // промежуточного состояния "модалка открыта, FPS скрыт, потом
        // моргнул и появился после первой смены настроек".
        const runtime = readRuntimeSettings()
        log(
            `ensureBackground: initial settings enabled=${runtime.enabled}, showFps=${runtime.showFps}, ` +
                `paletteFadeMs=${runtime.paletteFadeMs}, paletteBlendSpeed=${runtime.paletteBlendSpeed}, ` +
                `blobCountMin=${runtime.blobCountMin}, blobSpeed=${runtime.blobSpeed}, bgLightness=${runtime.bgLightness}`,
        )
        backgroundInstance = new CanvasBackground(container, runtime)
        clearRetry()
        retriesLeft = MAX_RETRIES
    } catch (err) {
        error('failed to start background', err)
    }
}

function reconcileBackground(): void {
    // Если модалка пересоздана в DOM (React/Preact unmount → mount), старый
    // backgroundInstance ссылается на удалённый узел — нужно его уничтожить,
    // чтобы ensureBackground создал новый под актуальную модалку.
    if (backgroundInstance && !backgroundInstance.isContainerAlive()) {
        log('reconcileBackground: container detached, recreating')
        backgroundInstance.destroy()
        backgroundInstance = null
    }

    if (!backgroundInstance) {
        ensureBackground()
        return
    }

    // На случай, когда модалка осталась той же, но внутри неё сменился `<img>` обложки —
    // провоцируем перерасчёт палитры прямо сейчас, не дожидаясь таймера.
    backgroundInstance.requestPaletteRefresh()
}

function thisOrDescendantMatches(node: Node, selector: string): boolean {
    if (!(node instanceof Element)) {
        return false
    }
    if (node.matches(selector)) {
        return true
    }
    return node.querySelector(selector) !== null
}

function anyAddedNodeMatches(nodes: NodeList, selector: string): boolean {
    for (const node of Array.from(nodes)) {
        if (node instanceof Element && node.matches(selector)) {
            return true
        }
    }
    return false
}

function watchModal(): void {
    // Подписка на настройки аддона: при изменении любой настройки в UI PulseSync
    // применяем новые значения к текущему instance (если он создан).
    const settingsStore = getAddonSettings(addonConfig.name)
    settingsStore.onChange(nextSettings => {
        const runtime = {
            enabled: readBooleanSetting(nextSettings, SETTING_KEY_ENABLED, DEFAULT_RUNTIME_SETTINGS.enabled),
            showFps: readBooleanSetting(nextSettings, SETTING_KEY_SHOW_FPS, DEFAULT_RUNTIME_SETTINGS.showFps),
            paletteFadeMs: readNumberSetting(nextSettings, SETTING_KEY_PALETTE_FADE_MS, DEFAULT_RUNTIME_SETTINGS.paletteFadeMs),
            paletteBlendSpeed: readNumberSetting(
                nextSettings,
                SETTING_KEY_PALETTE_BLEND_SPEED,
                DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed,
            ),
            blobCountMin: readNumberSetting(nextSettings, SETTING_KEY_BLOB_COUNT_MIN, DEFAULT_RUNTIME_SETTINGS.blobCountMin),
            blobSpeed: readNumberSetting(nextSettings, SETTING_KEY_BLOB_SPEED, DEFAULT_RUNTIME_SETTINGS.blobSpeed),
            bgLightness: readNumberSetting(nextSettings, SETTING_KEY_BG_LIGHTNESS, DEFAULT_RUNTIME_SETTINGS.bgLightness),
        }
        log(`settings changed: enabled=${runtime.enabled}, showFps=${runtime.showFps}, ` +
            `paletteFadeMs=${runtime.paletteFadeMs}, paletteBlendSpeed=${runtime.paletteBlendSpeed}, ` +
            `blobCountMin=${runtime.blobCountMin}, blobSpeed=${runtime.blobSpeed}, bgLightness=${runtime.bgLightness}`)
        backgroundInstance?.applySettings(runtime)
    })

    ensureBackground()

    // Срабатываем только при реальном появлении/исчезновении модалки или обложки.
    // Любые прочие DOM-мутации плеера (прогресс, тулбары, тексты трека) — игнорируем,
    // иначе reconcileBackground() будет дёргать requestPaletteRefresh() и грузить
    // обложку повторно через CORS на каждый чих.
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type !== 'childList') {
                continue
            }
            const interesting =
                thisOrDescendantMatches(record.target, MODAL_SELECTOR) ||
                thisOrDescendantMatches(record.target, COVER_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, MODAL_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, COVER_SELECTOR)
            if (interesting) {
                if (retryTimer === null) {
                    reconcileBackground()
                }
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
