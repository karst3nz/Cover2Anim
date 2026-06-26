import { BADGE_ID } from './constants'

export function ensureBadge(): HTMLDivElement | null {
    if (!document.body) {
        return null
    }

    const existing = document.getElementById(BADGE_ID)
    if (existing instanceof HTMLDivElement) {
        return existing
    }

    const badge = document.createElement('div')
    badge.id = BADGE_ID
    document.body.appendChild(badge)
    return badge
}
