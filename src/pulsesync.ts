import type { AddonSettingValue, AddonSettings, AddonSettingsStore } from '@pulsesync/yamusic-types'
import { log } from 'node:console'

function unwrapSetting<T>(entry: AddonSettingValue<T> | unknown, fallback: T): T {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as AddonSettingValue<T>

        if (typeof record.value !== 'undefined') {
            return record.value
        }

        if (typeof record.default !== 'undefined') {
            return record.default
        }
    }

    return typeof entry !== 'undefined' ? (entry as T) : fallback
}

export function getAddonSettings(addonName: string): AddonSettingsStore {
    return (
        window.pulsesyncApi?.getSettings(addonName) ?? {
            getCurrent: () => ({}),
            onChange: () => () => {},
        }
    )
}

export function readBooleanSetting(settings: AddonSettings, key: string, fallback: boolean): boolean {
    return Boolean(unwrapSetting(settings[key], fallback))
}

export function readStringSetting(settings: AddonSettings, key: string, fallback: string): string {
    return String(unwrapSetting(settings[key], fallback))
}

export function readNumberSetting(settings: AddonSettings, key: string, fallback: number): number {
    const raw = unwrapSetting<unknown>(settings[key], fallback)
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
}

export function readSelectSetting<T extends string>(settings: AddonSettings, key: string, fallback: T, allowedValues: readonly T[]): T {
    const raw = unwrapSetting<unknown>(settings[key], fallback)

    // Случай 1: PulseSync вернул числовой индекс опции
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < allowedValues.length) {
        return allowedValues[raw]
    }

    // Случай 2: PulseSync вернул строковый ключ (старые билды / ручное редактирование)
    if (typeof raw === 'string') {
        return (allowedValues as readonly string[]).includes(raw) ? (raw as T) : fallback
    }

    // Случай 3: строка-число ("0", "1", "2") — пробуем распарсить
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        const idx = Number(raw)
        if (idx >= 0 && idx < allowedValues.length) return allowedValues[idx]
    }

    return fallback
}
