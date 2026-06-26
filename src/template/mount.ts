import addonConfig from '../../addon.config.mjs'

import { getAddonSettings, readBooleanSetting, readStringSetting } from '@/pulsesync'

import { DEFAULT_ACCENT_COLOR } from './constants'
import { renderBadge } from './render'

export function mountTemplate(): void {
    const settingsStore = getAddonSettings(addonConfig.name)
    let settings = settingsStore.getCurrent()

    const update = () => {
        renderBadge({
            addonId: addonConfig.id,
            visible: readBooleanSetting(settings, 'enabled', true),
            accentColor: readStringSetting(settings, 'accentColor', DEFAULT_ACCENT_COLOR),
        })
    }

    update()

    settingsStore.onChange(nextSettings => {
        settings = nextSettings
        update()
    })
}
