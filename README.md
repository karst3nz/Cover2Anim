# PulseSync Addon Template

Шаблон `script`-аддона для PulseSync.

Точка входа: `src/main.ts`.
`addon/` копируется в итоговую папку как есть.
Автор аддона редактирует схему настроек в `addon/handleEvents.json`.
PulseSync хранит пользовательские значения отдельно в `pulsesync.settings.json` рядом с установленным аддоном и не должен публиковать этот файл.

Сборка кладёт в папку аддона:

- `metadata.json`
- `script.js`
- `script.css`
- `handleEvents.json`
- `README.md`
- `Assets/*`

Во время работы PulseSync может дополнительно создать:

- `pulsesync.settings.json`

## Команды

```bash
yarn
yarn dev
yarn build
yarn sync
yarn build:sync
```

- `yarn dev` пишет сразу в папку аддонов PulseSync и следит и за `src/`, и за `addon/`, и за `addon.config.mjs`
- `yarn build` собирает в `dist/<directoryName>` (берётся из `addon.config.mjs`)
- `yarn sync` копирует `dist`-сборку в папку аддонов
- `yarn build:sync` делает `build` и `sync`

Обычно достаточно `yarn dev`, если нужно сразу проверять аддон в клиенте.
`yarn dev` собирает без минификации, `yarn build` собирает с минификацией.
Если во время `yarn dev` меняется `directoryName` в `addon.config.mjs`, dev-процесс нужно перезапустить.

## Папка аддонов

- Windows: `%APPDATA%/PulseSync/addons`
- macOS: `~/Library/Application Support/PulseSync/addons`
- Linux: `$XDG_CONFIG_HOME/PulseSync/addons` или `~/.config/PulseSync/addons`
- override: `PULSESYNC_ADDONS_DIR`

## Структура проекта

```text
src/
  main.ts              точка входа
  pulsesync.ts         хелперы для PulseSync API
  styles.css           стили аддона
  globals.d.ts         типы PulseSync API
  styles.d.ts          типы для CSS-модулей
  template/
    constants.ts
    dom.ts
    render.ts
    mount.ts
addon/
  handleEvents.json    схема настроек аддона
  README.md            описание в финальной папке аддона
  Assets/
scripts/
  dev-build.mjs        watch-сборка в папку аддонов
  sync-addon.mjs       копирование `dist`-сборки
  pulsesync-paths.mjs  резолв пути до папки PulseSync
addon.config.mjs
vite.config.ts
```

## Настройки аддона

- `addon/handleEvents.json` описывает поля, их типы и значения по умолчанию
- обычный экран `Settings` в PulseSync меняет только пользовательские значения
- `edit mode` в PulseSync меняет саму схему `handleEvents.json`
- `pulsesync.settings.json` создаётся приложением автоматически рядом с установленным аддоном и не должен попадать в git или в архив публикации

Коротко:

- `handleEvents.json` — часть исходников аддона
- `pulsesync.settings.json` — служебный файл PulseSync
