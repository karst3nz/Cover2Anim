import './styles.css'

const MODAL_SELECTOR = 'div[data-test-id="FULLSCREEN_PLAYER_MODAL"]'
const COVER_SELECTOR = 'img[data-test-id="ENTITY_COVER_IMAGE"]'

const FALLBACK_PALETTE = ['#ff3366', '#ff8800', '#ffcc00', '#00ccff', '#4466ff', '#aa00ff']

const PALETTE_FADE_MS = 1000

// Целевая лёгкость (HSL L) для фонового цвета: 0 = чёрный, 1 = белый.
// 0.18 — тёмный, но с различимым оттенком обложки, UI поверх остаётся читаемым.
const BG_LIGHTNESS = 0.18

const RETRY_DELAY_MS = 1500
const MAX_RETRIES = 100
const PALETTE_POLL_MS = 100000
const COVER_DEBOUNCE_MS = 100000

const LOG_PREFIX = '[Cover2Anim]'

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

class CanvasBackground {
    private readonly container: HTMLElement
    private readonly canvas: HTMLCanvasElement
    private readonly ctx: CanvasRenderingContext2D

    private blobs: Blob[] = []
    private animationTime = 0
    private lastTime = 0
    private lastDt = 16
    private rafId = 0
    private resizeObserver: ResizeObserver | null = null
    private coverObserver: MutationObserver | null = null
    private palettePollTimer: number | null = null

    private settings: { enabled: boolean } = { enabled: true }
    private basePalette: string[] = []
    private disabled = false

    private backgroundColor: string = '#050505'
    private targetBackgroundColor: string = '#050505'
    private backgroundMix: number = 1

    private coverRequestId = 0
    private lastAppliedSrc: string | null = null
    private coverDebounceTimer: number | null = null
    private pendingCoverSrc: string | null = null
    private recentPalettes: string[][] = []
    private static readonly RECENT_PALETTES_MAX = 3

    constructor(container: HTMLElement) {
        this.container = container
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'betterplayer-canvas-bg'
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

        if (!this.settings.enabled) {
            this.disabled = true
            log('background disabled by setting')
            return
        }

        this.container.insertBefore(this.canvas, this.container.firstChild)
        this.container.classList.add('canvas-mode')

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
        const initialDominant = this.darken(FALLBACK_PALETTE[0], BG_LIGHTNESS)
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
        if (this.palettePollTimer !== null) {
            window.clearInterval(this.palettePollTimer)
            this.palettePollTimer = null
            log('palette poll timer stopped')
        }
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
    }

    isContainerAlive(): boolean {
        return this.container.isConnected && document.contains(this.canvas)
    }

    requestPaletteRefresh(): void {
        this.pollCover()
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
            this.rafId = requestAnimationFrame(loop)
        }
        this.rafId = requestAnimationFrame(loop)
    }

    private createBlobTexture(color: string, size = 512): HTMLCanvasElement {
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const x = c.getContext('2d')
        if (!x) {
            return c
        }

        const gradient = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
        gradient.addColorStop(0, color + 'ff')
        gradient.addColorStop(0.5, color + '99')
        gradient.addColorStop(1, color + '00')

        x.fillStyle = gradient
        x.fillRect(0, 0, size, size)
        return c
    }

    private createBlobs(colors: string[]): void {
        this.blobs = []
        const count = Math.max(6, window.innerWidth < 768 ? 6 : Math.min(18, Math.floor(window.innerWidth / 180)))
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        for (let i = 0; i < count; i++) {
            const color = colors[i % colors.length]
            this.blobs.push({
                color,
                targetColor: color,
                texture: this.createBlobTexture(color),
                baseX: Math.random() * width,
                baseY: Math.random() * height,
                radius: 250 + Math.random() * 250,
                currentRadius: 300,
                orbitX: 150 + Math.random() * 500,
                orbitY: 150 + Math.random() * 500,
                phaseX: Math.random() * Math.PI * 2,
                phaseY: Math.random() * Math.PI * 2,
                speedX: 0.0001 + Math.random() * 0.0003,
                speedY: 0.0001 + Math.random() * 0.0003,
                pulsePhase: Math.random() * Math.PI * 2,
                pulseSpeed: 0.0003 + Math.random() * 0.0004,
                colorMix: 1,
                colorOffset: (i / count) * 0.8,
            })
        }
        log(`created ${this.blobs.length} blobs from palette`, colors)
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
            blob.targetColor = colors[bestIdx]
            blob.colorMix = 0
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

    private updateBlobs(dt: number): void {
        this.animationTime += dt
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        for (const blob of this.blobs) {
            blob.baseX = Math.min(Math.max(blob.baseX, 0), width)
            blob.baseY = Math.min(Math.max(blob.baseY, 0), height)

            blob.currentRadius = blob.radius + Math.sin(this.animationTime * blob.pulseSpeed + blob.pulsePhase) * 80

            if (blob.color !== blob.targetColor) {
                // colorMix накапливает «прошедшее время» бленда в долях от PALETTE_FADE_MS.
                // colorOffset разносит старт бленда по blob'ам, чтобы переход шёл волной.
                blob.colorMix = Math.min(1, blob.colorMix + dt / PALETTE_FADE_MS)
                const rawT = Math.max(0, Math.min(1, blob.colorMix - blob.colorOffset))
                // smoothstep: плавный старт и плавный финал, без линейного «разгона»
                const t = rawT * rawT * (3 - 2 * rawT)
                if (t > 0) {
                    const currentColor = this.blendHex(blob.color, blob.targetColor, t)
                    blob.texture = this.createBlobTexture(currentColor)
                }
                if (blob.colorMix >= 1) {
                    blob.color = blob.targetColor
                }
            }
        }
    }

    private draw(time: number): void {
        const width = this.container.clientWidth || window.innerWidth
        const height = this.container.clientHeight || window.innerHeight

        // Закрашиваем canvas фоном, плавно переходящим из старого доминирующего
        // цвета в новый за PALETTE_FADE_MS — синхронно с блендом blob'ов.
        if (this.backgroundColor !== this.targetBackgroundColor) {
            this.backgroundMix = Math.min(1, this.backgroundMix + this.lastDt / PALETTE_FADE_MS)
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
        this.ctx.rotate(time * 0.00001)
        this.ctx.translate(-width / 2, -height / 2)

        this.ctx.globalCompositeOperation = 'lighter'
        this.ctx.filter = window.innerWidth < 768 ? 'blur(70px)' : 'blur(100px)'

        const t = this.animationTime
        for (const blob of this.blobs) {
            const x = blob.baseX + Math.sin(t * blob.speedX + blob.phaseX) * blob.orbitX
            const y = blob.baseY + Math.cos(t * blob.speedY + blob.phaseY) * blob.orbitY
            const r = blob.currentRadius
            this.ctx.drawImage(blob.texture, x - r, y - r, r * 2, r * 2)
        }

        this.ctx.restore()
        this.ctx.filter = 'none'
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
            const W = img.naturalWidth || 800
            const H = img.naturalHeight || 800
            c.width = W
            c.height = H
            x.drawImage(img, 0, 0, W, H)
            const data = x.getImageData(0, 0, W, H).data
            const totalPixels = W * H
            const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / 4000)))
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
            const W = img.naturalWidth || 800
            const H = img.naturalHeight || 800
            c.width = W
            c.height = H
            x.drawImage(img, 0, 0, W, H)
            const data = x.getImageData(0, 0, W, H).data

            // Шаг между сэмплами — максимум ~4000 точек по всей картинке.
            const totalPixels = W * H
            const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / 4000)))

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
            const MERGE_DIST_SQ = 70 * 70
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

            const colors = clusters.slice(0, 6).map(cl => this.rgbToHex(Math.round(cl.r), Math.round(cl.g), Math.round(cl.b)))

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
            this.recentPalettes = [[...base]]
            // Доминирующий цвет для фона — средневзвешенный по всей картинке.
            // Топ-1 кластер может быть случайным акцентом в углу (иконка лейбла и т.п.),
            // а средний цвет корректно отражает обложку в целом (белый/чёрный/бежевый → серый).
            const rawDominant = this.averageColor(corsImage)
            const dominant = this.darken(rawDominant, BG_LIGHTNESS)
            this.applyPalette(base, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.onerror = () => {
            if (requestId !== this.coverRequestId) {
                return
            }
            warn(`applyCover: CORS load failed for ${src}, using fallback palette`)
            this.basePalette = [...FALLBACK_PALETTE]
            const dominant = this.darken(FALLBACK_PALETTE[0], BG_LIGHTNESS)
            this.applyPalette(FALLBACK_PALETTE, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.src = src
    }

    private findCover(): HTMLImageElement | null {
        const scope = this.container.matches(MODAL_SELECTOR) ? this.container : (this.container.querySelector(MODAL_SELECTOR) ?? document)
        const img = scope.querySelector(COVER_SELECTOR)
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

    applySettings(settings: { enabled: boolean }): void {
        this.settings = { enabled: settings.enabled }

        if (this.disabled && this.settings.enabled) {
            // Если аддон был выключен, и пользователь включил его — ничего не делаем.
            // Полная переинициализация потребует перезагрузки модалки.
            log('applySettings: addon re-enabled; reopen player to apply')
            return
        }

        if (!this.settings.enabled && !this.disabled) {
            this.disabled = true
            log('applySettings: addon disabled by user')
            return
        }
    }

    private observeCover(): void {
        if (typeof MutationObserver !== 'undefined') {
            const root = this.container.querySelector(MODAL_SELECTOR) ?? document.body
            if (!root) {
                warn('observeCover: no root element to observe')
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
        } else {
            warn('observeCover: MutationObserver unavailable, relying on polling only')
        }

        // Подстраховка: каждые PALETTE_POLL_MS проверяем обложку, даже если
        // MutationObserver пропустил смену (например, React-ремоунт без мутации src).
        this.palettePollTimer = window.setInterval(() => this.pollCover(), PALETTE_POLL_MS)
        log(`palette poll timer started (every ${PALETTE_POLL_MS}ms)`)
    }

    private pollCover(): void {
        const img = this.findCover()
        if (!img) {
            log('pollCover: no cover image found')
            return
        }
        const src = this.pickCoverUrl(img)
        if (!src) {
            log('pollCover: cover image has no src')
            return
        }
        // Проверяем только то, что картинка уже загружена в DOM — иначе пиксели ещё не доступны
        if (!img.complete || img.naturalWidth === 0) {
            log('pollCover: cover not yet loaded')
            return
        }

        const requestId = ++this.coverRequestId
        const corsImage = new Image()
        corsImage.crossOrigin = 'anonymous'
        corsImage.referrerPolicy = 'no-referrer'
        corsImage.onload = () => {
            if (requestId !== this.coverRequestId) {
                return
            }
            const base = this.extractColors(corsImage)
            // Сравниваем не только с текущей палитрой, но и с последними N —
            // из-за shuffle() кластеризация может чередовать два стабильных
            // состояния, и нужно глушить оба.
            for (const recent of this.recentPalettes) {
                if (this.palettesEqual(base, recent)) {
                    log(`pollCover: palette unchanged (matches recent, ${base.length} colors)`)
                    return
                }
            }
            if (this.palettesEqual(base, this.basePalette)) {
                log(`pollCover: palette unchanged (${base.length} colors)`)
                return
            }
            log(`pollCover: palette differs, reapplying`, base)
            this.basePalette = base
            this.recentPalettes.unshift([...base])
            if (this.recentPalettes.length > CanvasBackground.RECENT_PALETTES_MAX) {
                this.recentPalettes.pop()
            }
            const rawDominant = this.averageColor(corsImage)
            const dominant = this.darken(rawDominant, BG_LIGHTNESS)
            this.applyPalette(base, dominant)
            this.lastAppliedSrc = src
        }
        corsImage.onerror = () => {
            if (requestId !== this.coverRequestId) {
                return
            }
            log(`pollCover: CORS load failed for ${src}`)
        }
        corsImage.src = src
    }

    private palettesEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) {
            return false
        }
        // Сортируем оба массива — кластеризация после shuffle() даёт
        // недетерминированный порядок цветов, и без сортировки одинаковые
        // палитры выглядят разными.
        const sortedA = [...a].sort()
        const sortedB = [...b].sort()
        // Допуск d² < 1500 (≈28 на канал) учитывает джиттер JPEG/антиалиасинг:
        // тёмные оттенки могут различаться на 20-30 единиц в каждом канале между
        // соседними сэмплами из-за шума, и это нормально.
        const THRESHOLD_SQ = 1500
        for (let i = 0; i < sortedA.length; i++) {
            const ca = this.hexToRgb(sortedA[i])
            const cb = this.hexToRgb(sortedB[i])
            const dr = ca.r - cb.r
            const dg = ca.g - cb.g
            const db = ca.b - cb.b
            if (dr * dr + dg * dg + db * db > THRESHOLD_SQ) {
                return false
            }
        }
        return true
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
        backgroundInstance = new CanvasBackground(container)
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

function watchModal(): void {
    ensureBackground()

    const observer = new MutationObserver(() => {
        if (retryTimer === null) {
            reconcileBackground()
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
