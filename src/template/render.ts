import { ensureBadge } from './dom'

type RenderBadgeOptions = {
    addonId: string
    visible: boolean
    accentColor: string
}

export function renderBadge(options: RenderBadgeOptions): void {
    const badge = ensureBadge()
    if (!badge) {
        requestAnimationFrame(() => renderBadge(options))
        return
    }

    document.documentElement.style.setProperty('--ps-template-accent', options.accentColor)

    badge.hidden = !options.visible
    badge.replaceChildren(createLine(options.addonId, options.accentColor))
}

function createLine(addonId: string, accentColor: string): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ps-template-line'

    const name = document.createElement('span')
    name.className = 'ps-template-name'
    name.textContent = addonId

    const separator = document.createElement('span')
    separator.className = 'ps-template-separator'
    separator.textContent = '/'

    const color = document.createElement('span')
    color.className = 'ps-template-color'
    color.textContent = accentColor.toUpperCase()

    line.append(name, separator, color)
    return line
}
