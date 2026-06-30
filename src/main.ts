import './styles.css'

import addonConfig from '../addon.config.mjs'
import { getAddonSettings, readBooleanSetting, readNumberSetting, readStringSetting } from './pulsesync'
import {
    BG_LIGHTNESS,
    BG_LIGHTNESS_DARK_FLOOR,
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

// Фрагментный шейдер:
// Воспроизводит радиальный градиент исходной canvas-текстуры прямо в шейдере,
// поэтому offscreen-текстуры на HTMLCanvasElement вообще не нужны.
// Переход цвета (prev → текущий) делается смешиванием двух цветовых юниформов
// вместо двух вызовов drawImage с комплементарными globalAlpha.
const FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_localPos;

uniform vec3  u_color;      // целевой (новый) цвет в линейном RGB [0-1]
uniform vec3  u_prevColor;  // предыдущий цвет в линейном RGB [0-1]
uniform float u_blendT;     // 0 = prevColor, 1 = color  (до smoothstep)

// Альфа-точки, соответствующие исходному градиенту canvas (0 → ядро, 0.5 → середина, 1 → край)
uniform float u_alphaCore;
uniform float u_alphaMid;
uniform float u_alphaEdge;

out vec4 outColor;

void main() {
    float dist = length(v_localPos);   // 0 в центре, 1 на краю
    if (dist >= 1.0) discard;

    // Кусочно-линейный спад — безветочное двухсегментное смешивание:
    //   dist 0   → alphaCore
    //   dist 0.5 → alphaMid
    //   dist 1   → alphaEdge
    float t1 = clamp(dist * 2.0, 0.0, 1.0);        // 0→1 при dist 0→0.5
    float t2 = clamp(dist * 2.0 - 1.0, 0.0, 1.0);  // 0→1 при dist 0.5→1.0
    float alpha = mix(mix(u_alphaCore, u_alphaMid, t1), u_alphaEdge, t2);

    vec3 finalColor = mix(u_prevColor, u_color, u_blendT);

    outColor = vec4(finalColor, alpha);
}
`

// ---------------------------------------------------------------------------
// Логирование
// ---------------------------------------------------------------------------

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
            if (arg.message) console.error(`${LOG_PREFIX}   message:`, arg.message)
            if (arg.stack) console.error(`${LOG_PREFIX}   stack:`, arg.stack)
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
type AddonRuntimeSettings = {
    enabled: boolean
    showFps: boolean
    filter: string
    paletteFadeMs: number
    blobCountMin: number
    blobSpeed: number
    bgLightness: number
    paletteBlendSpeed: number
}

// ---------------------------------------------------------------------------
// Хелперы настроек (без изменений)
// ---------------------------------------------------------------------------

const SETTING_KEY_ENABLED = 'enabled'
const SETTING_KEY_SHOW_FPS = 'showFps'
const SETTING_KEY_FILTER = 'filter'
const SETTING_KEY_PALETTE_FADE_MS = 'paletteFadeMs'
const SETTING_KEY_PALETTE_BLEND_SPEED = 'paletteBlendSpeed'
const SETTING_KEY_BLOB_COUNT_MIN = 'blobCountMin'
const SETTING_KEY_BLOB_SPEED = 'blobSpeed'
const SETTING_KEY_BG_LIGHTNESS = 'bgLightness'

const DEFAULT_RUNTIME_SETTINGS: AddonRuntimeSettings = {
    enabled: true,
    showFps: false,
    filter: '',
    paletteFadeMs: PALETTE_FADE_MS,
    blobCountMin: BLOB_COUNT_MIN,
    blobSpeed: 1,
    bgLightness: BG_LIGHTNESS,
    paletteBlendSpeed: 1,
}

function sanitizeFilter(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value || value.toLowerCase() === 'none') return 'none'
    const FUNCTIONS = ['blur', 'saturate', 'contrast', 'brightness', 'hue-rotate', 'invert', 'grayscale', 'sepia', 'drop-shadow']
    const allowed = new RegExp(`^([a-z-]+\\([^()]*\\)\\s*)+$`, 'i')
    if (!allowed.test(value)) return DEFAULT_RUNTIME_SETTINGS.filter
    for (const fn of FUNCTIONS) {
        if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(value)) return value
    }
    return DEFAULT_RUNTIME_SETTINGS.filter
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
}

function sanitizeSettings(raw: Partial<AddonRuntimeSettings>): AddonRuntimeSettings {
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_RUNTIME_SETTINGS.enabled,
        showFps: typeof raw.showFps === 'boolean' ? raw.showFps : DEFAULT_RUNTIME_SETTINGS.showFps,
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
    }
}

function readRuntimeSettings(): Partial<AddonRuntimeSettings> {
    const settingsStore = getAddonSettings(addonConfig.name)
    const settings = settingsStore.getCurrent()
    return {
        enabled: readBooleanSetting(settings, SETTING_KEY_ENABLED, DEFAULT_RUNTIME_SETTINGS.enabled),
        showFps: readBooleanSetting(settings, SETTING_KEY_SHOW_FPS, DEFAULT_RUNTIME_SETTINGS.showFps),
        filter: readStringSetting(settings, SETTING_KEY_FILTER, DEFAULT_RUNTIME_SETTINGS.filter),
        paletteFadeMs: readNumberSetting(settings, SETTING_KEY_PALETTE_FADE_MS, DEFAULT_RUNTIME_SETTINGS.paletteFadeMs),
        paletteBlendSpeed: readNumberSetting(settings, SETTING_KEY_PALETTE_BLEND_SPEED, DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed),
        blobCountMin: readNumberSetting(settings, SETTING_KEY_BLOB_COUNT_MIN, DEFAULT_RUNTIME_SETTINGS.blobCountMin),
        blobSpeed: readNumberSetting(settings, SETTING_KEY_BLOB_SPEED, DEFAULT_RUNTIME_SETTINGS.blobSpeed),
        bgLightness: readNumberSetting(settings, SETTING_KEY_BG_LIGHTNESS, DEFAULT_RUNTIME_SETTINGS.bgLightness),
    }
}

// ---------------------------------------------------------------------------
// Маленькие утилиты WebGL2
// ---------------------------------------------------------------------------

// Преобразует 2-символьную hex-строку альфы (например, 'cc', '80', '00') в float [0, 1].
function hexAlphaToFloat(hexAlpha: string): number {
    const val = parseInt(hexAlpha.slice(0, 2), 16)
    return Number.isNaN(val) ? 1.0 : val / 255
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

    // Локации юниформов (кэшируются после линковки программы)
    private uResolution!: WebGLUniformLocation
    private uRotation!: WebGLUniformLocation
    private uBlobCenter!: WebGLUniformLocation
    private uBlobRadius!: WebGLUniformLocation
    private uColor!: WebGLUniformLocation
    private uPrevColor!: WebGLUniformLocation
    private uBlendT!: WebGLUniformLocation

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

        const initialDominant = this.dominantBgFromPalette(FALLBACK_PALETTE, this.settings.bgLightness)
        this.applyPalette(FALLBACK_PALETTE, initialDominant)

        const initial = this.findCover()
        if (initial) this.applyCover(initial)
        this.observeCover()

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
            if (!l) warn(`initGL: юниформ "${name}" не найден — возможно, шейдер его оптимизировал`)
            return l!
        }
        this.uResolution = loc('u_resolution')
        this.uRotation = loc('u_rotation')
        this.uBlobCenter = loc('u_blobCenter')
        this.uBlobRadius = loc('u_blobRadius')
        this.uColor = loc('u_color')
        this.uPrevColor = loc('u_prevColor')
        this.uBlendT = loc('u_blendT')

        // Один раз задаём константные юниформы альфа-точек (в runtime они не меняются).
        gl.useProgram(program)
        gl.uniform1f(loc('u_alphaCore'), hexAlphaToFloat(BLOB_TEXTURE_ALPHA_CORE))
        gl.uniform1f(loc('u_alphaMid'), hexAlphaToFloat(BLOB_TEXTURE_ALPHA_MID))
        gl.uniform1f(loc('u_alphaEdge'), hexAlphaToFloat(BLOB_TEXTURE_ALPHA_EDGE))
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
        const current = this.findCover()
        if (current) this.applyCover(current)
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

    private updatePalette(colors: string[]): void {
        if (this.blobs.length === 0 || colors.length === 0) return

        // Подбираем для каждого блоба ближайший новый цвет по евклидову расстоянию в RGB
        // (тот же алгоритм, что в исходной 2D-версии).
        const initialTargets = this.blobs.map((_, i) => colors[i % colors.length])
        const initialRgb = initialTargets.map(hex => this.hexToRgb(hex))
        const newRgb = colors.map(hex => this.hexToRgb(hex))
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

        log('palette updated', colors)
    }

    // -------------------------------------------------------------------------
    // Цветовая математика (без изменений относительно 2D-версии)
    // -------------------------------------------------------------------------

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

    // Нормализует hex-цвет к тройке float [0, 1] для WebGL-юниформов.
    private hexToRgbFloat(hex: string): [number, number, number] {
        const { r, g, b } = this.hexToRgb(hex)
        return [r / 255, g / 255, b / 255]
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

    private get effectiveFadeMs(): number {
        const fade = this.settings.paletteFadeMs
        if (fade <= 0) return 0.001
        return fade / Math.max(0.01, this.settings.paletteBlendSpeed)
    }

    private rgbToHex(r: number, g: number, b: number): string {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    }

    private rgbToHsl(hex: string): { h: number; s: number; l: number } {
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
        return { h, s, l }
    }

    // HSL → (r, g, b) в [0, 255]. h в градусах [0, 360), s/l в [0, 1].
    private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
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

    // Умножает L на factor, сохраняя H и S. Результат L ограничен [0, 1].
    // Используется для приглушения bgDiv от доминирующего цвета обложки.
    private scaleLightness(hex: string, factor: number): string {
        const { h, s, l } = this.rgbToHsl(hex)
        const l2 = Math.max(0, Math.min(1, l * factor))
        const { r, g, b } = this.hslToRgb(h, s, l2)
        return this.rgbToHex(r, g, b)
    }

    private shuffle<T>(arr: T[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = arr[i]
            arr[i] = arr[j]
            arr[j] = tmp
        }
    }

    // Вычисляет цвет bgDiv по топовому кластеру палитры обложки:
    // сохраняет H и S, а L линейно интерполируется от BG_LIGHTNESS_DARK_FLOOR
    // (для L=0 в обложке) к bgLightness (для L=1). При bgLightness=1 фон
    // совпадает с доминантой; при bgLightness=0.9 — почти совпадает;
    // floor не даёт провалиться в чёрный для очень тёмных обложек.
    private dominantBgFromPalette(palette: string[], bgLightness: number): string {
        const dominant = palette.length > 0 ? palette[0] : FALLBACK_PALETTE[0]
        const { h, s, l } = this.rgbToHsl(dominant)
        const l2 = BG_LIGHTNESS_DARK_FLOOR + (bgLightness - BG_LIGHTNESS_DARK_FLOOR) * l
        const { r, g, b } = this.hslToRgb(h, s, Math.max(0, Math.min(1, l2)))
        return this.rgbToHex(r, g, b)
    }

    // -------------------------------------------------------------------------
    // Извлечение цветов (без изменений — всё ещё использует 2D-canvas для чтения пикселей)
    // -------------------------------------------------------------------------

    private extractColors(img: HTMLImageElement): string[] {
        const c = document.createElement('canvas')
        const x = c.getContext('2d')
        if (!x) {
            warn('extractColors: 2d context unavailable, using fallback palette')
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

            const colors = clusters.slice(0, EXTRACTED_PALETTE_SIZE).map(cl => this.rgbToHex(Math.round(cl.r), Math.round(cl.g), Math.round(cl.b)))
            log('extracted colors from cover', colors)
            return colors
        } catch (err) {
            warn('extractColors: failed to read pixels (likely cross-origin), using fallback palette', err)
            return FALLBACK_PALETTE
        }
    }

    // -------------------------------------------------------------------------
    // Применение палитры
    // -------------------------------------------------------------------------

    private applyPalette(colors: string[], dominant?: string): void {
        const wasEmpty = this.blobs.length === 0
        if (wasEmpty) {
            this.createBlobs(colors)
        } else {
            this.updatePalette(colors)
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

    private applyCover(img: HTMLImageElement): void {
        const src = this.pickCoverUrl(img)
        if (!src) {
            warn('applyCover: cover image has no src, skipping')
            return
        }
        if (src === this.pendingCoverSrc || src === this.lastAppliedSrc) return

        this.pendingCoverSrc = src
        if (this.coverDebounceTimer !== null) window.clearTimeout(this.coverDebounceTimer)
        this.coverDebounceTimer = window.setTimeout(() => {
            this.coverDebounceTimer = null
            const pending = this.pendingCoverSrc
            this.pendingCoverSrc = null
            if (!pending) return
            this.loadCover(pending)
        }, COVER_DEBOUNCE_MS)
    }

    private loadCover(src: string): void {
        const requestId = ++this.coverRequestId
        const corsImage = new Image()
        corsImage.crossOrigin = 'anonymous'
        corsImage.referrerPolicy = 'no-referrer'
        corsImage.onload = () => {
            if (requestId !== this.coverRequestId) return
            const base = this.extractColors(corsImage)
            this.basePalette = base
            const dominant = this.dominantBgFromPalette(base, this.settings.bgLightness)
            this.applyPalette(base, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.onerror = () => {
            if (requestId !== this.coverRequestId) return
            warn(`applyCover: CORS load failed for ${src}, using fallback palette`)
            this.basePalette = [...FALLBACK_PALETTE]
            const dominant = this.dominantBgFromPalette(FALLBACK_PALETTE, this.settings.bgLightness)
            this.applyPalette(FALLBACK_PALETTE, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.src = src
    }

    private findCover(): HTMLImageElement | null {
        const modal = this.container.matches(MODAL_SELECTOR) ? this.container : this.container.querySelector(MODAL_SELECTOR)
        if (!modal) return null
        const poster = modal.querySelector(POSTER_CONTENT_SELECTOR)
        if (!poster) return null
        const img = poster.querySelector(COVER_SELECTOR)
        return img instanceof HTMLImageElement ? img : null
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

            const byPixels = candidates
                .map(c => {
                    const m = /(\d+)w/.exec(c.descriptor)
                    return { url: c.url, pixels: m ? Number(m[1]) : 0 }
                })
                .filter(c => c.pixels > 0)
                .sort((a, b) => b.pixels - a.pixels)
            if (byPixels.length > 0) return byPixels[0].url

            const byDensity = candidates
                .map(c => {
                    const m = /^([\d.]+)x$/.exec(c.descriptor)
                    return { url: c.url, density: m ? Number(m[1]) : 1 }
                })
                .sort((a, b) => b.density - a.density)
            if (byDensity.length > 0 && byDensity[0].density > 1) return byDensity[0].url

            return candidates[candidates.length - 1].url
        }
        return img.currentSrc || img.src || ''
    }

    // -------------------------------------------------------------------------
    // Настройки
    // -------------------------------------------------------------------------

    applySettings(settings: Partial<AddonRuntimeSettings>): void {
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
            const recomputed = this.dominantBgFromPalette(currentPalette, next.bgLightness)
            this.backgroundColor = currentHex
            this.targetBackgroundColor = recomputed
            this.backgroundMix = 0
            log(`applySettings: bgLightness changed → ${next.bgLightness} (new bg=${recomputed})`)
        }

        const blobCountChanged = next.blobCountMin !== prev.blobCountMin
        const blobSpeedChanged = next.blobSpeed !== prev.blobSpeed

        this.settings = next

        if ((blobCountChanged || blobSpeedChanged) && this.blobs.length > 0) {
            this.recreateBlobs()
            log(`applySettings: blobs recreated (countMin=${next.blobCountMin}, speed=${next.blobSpeed})`)
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
        this.canvas.style.filter = userPart
    }

    // Пересоздаёт блобы с новыми настройками числа/скорости, сохраняя текущую палитру.
    private recreateBlobs(): void {
        const palette = this.basePalette.length > 0 ? this.basePalette : FALLBACK_PALETTE
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
            this.backgroundColor = this.blendHex(this.backgroundColor, this.targetBackgroundColor, rawT)
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

            const [pr, pg, pb] = this.hexToRgbFloat(blob.color)
            const [cr, cg, cb] = this.hexToRgbFloat(blob.targetColor)
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
                warn('observeCover: modal not found, skipping observer (will retry via reconcileBackground)')
            } else {
                const root = modal.querySelector(POSTER_CONTENT_SELECTOR)
                if (!root) {
                    warn('observeCover: poster content not found in modal, skipping observer')
                } else {
                    this.coverObserver = new MutationObserver(records => {
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
                    log('cover observer started')
                }
            }
        } else {
            warn('observeCover: MutationObserver unavailable')
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
    }
}

function ensureBackground(): void {
    if (backgroundInstance) return
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
    if (backgroundInstance && !backgroundInstance.isContainerAlive()) {
        log('reconcileBackground: container detached, recreating')
        backgroundInstance.destroy()
        backgroundInstance = null
    }
    if (!backgroundInstance) {
        ensureBackground()
        return
    }
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
        const runtime = {
            enabled: readBooleanSetting(nextSettings, SETTING_KEY_ENABLED, DEFAULT_RUNTIME_SETTINGS.enabled),
            showFps: readBooleanSetting(nextSettings, SETTING_KEY_SHOW_FPS, DEFAULT_RUNTIME_SETTINGS.showFps),
            filter: readStringSetting(nextSettings, SETTING_KEY_FILTER, DEFAULT_RUNTIME_SETTINGS.filter),
            paletteFadeMs: readNumberSetting(nextSettings, SETTING_KEY_PALETTE_FADE_MS, DEFAULT_RUNTIME_SETTINGS.paletteFadeMs),
            paletteBlendSpeed: readNumberSetting(nextSettings, SETTING_KEY_PALETTE_BLEND_SPEED, DEFAULT_RUNTIME_SETTINGS.paletteBlendSpeed),
            blobCountMin: readNumberSetting(nextSettings, SETTING_KEY_BLOB_COUNT_MIN, DEFAULT_RUNTIME_SETTINGS.blobCountMin),
            blobSpeed: readNumberSetting(nextSettings, SETTING_KEY_BLOB_SPEED, DEFAULT_RUNTIME_SETTINGS.blobSpeed),
            bgLightness: readNumberSetting(nextSettings, SETTING_KEY_BG_LIGHTNESS, DEFAULT_RUNTIME_SETTINGS.bgLightness),
        }
        log(
            `settings changed: enabled=${runtime.enabled}, showFps=${runtime.showFps}, ` +
                `filter=${runtime.filter}, ` +
                `paletteFadeMs=${runtime.paletteFadeMs}, paletteBlendSpeed=${runtime.paletteBlendSpeed}, ` +
                `blobCountMin=${runtime.blobCountMin}, blobSpeed=${runtime.blobSpeed}, bgLightness=${runtime.bgLightness}`,
        )
        backgroundInstance?.applySettings(runtime)
    })

    ensureBackground()

    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type !== 'childList') continue
            const interesting =
                thisOrDescendantMatches(record.target, MODAL_SELECTOR) ||
                thisOrDescendantMatches(record.target, COVER_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, MODAL_SELECTOR) ||
                anyAddedNodeMatches(record.addedNodes, COVER_SELECTOR)
            if (interesting) {
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
