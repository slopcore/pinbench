import { Menu, app, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { MENUS } from '../shared/commands'
import type { CommandId } from '../shared/commands'
import { IpcChannel } from '../shared/ipc'

const DOCS_URL = 'https://github.com/meatpaste/pinbench#readme'
const ISSUES_URL = 'https://github.com/meatpaste/pinbench/issues'

/**
 * Commands the main process answers itself. Everything else is forwarded to the
 * renderer, which owns the workspace state.
 */
const MAIN_HANDLED: Partial<Record<CommandId, () => void>> = {
  'help.documentation': () => void shell.openExternal(DOCS_URL),
  'help.reportIssue': () => void shell.openExternal(ISSUES_URL)
}

/**
 * Build the native menu from the shared spec, so the accelerators work wherever
 * focus is and the in-window menu bar cannot drift from them.
 */
export function buildApplicationMenu(getWindow: () => BrowserWindow | null): Menu {
  const send = (command: CommandId): void => {
    const handled = MAIN_HANDLED[command]
    if (handled) {
      handled()
      return
    }
    getWindow()?.webContents.send(IpcChannel.menuCommand, command)
  }

  const template: MenuItemConstructorOptions[] = MENUS.map((menu) => ({
    label: menu.label,
    submenu: menu.entries.map((entry): MenuItemConstructorOptions => {
      if (entry.type === 'separator') return { type: 'separator' }
      return {
        label: entry.label,
        enabled: entry.enabled,
        ...(entry.accelerator === undefined ? {} : { accelerator: entry.accelerator }),
        click: () => send(entry.command)
      }
    })
  }))

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  return Menu.buildFromTemplate(template)
}
