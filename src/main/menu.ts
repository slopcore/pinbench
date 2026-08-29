import { Menu, app, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { MENUS } from '../shared/commands'
import type { CommandId } from '../shared/commands'
import { IpcChannel } from '../shared/ipc'

const DOCS_URL = 'https://github.com/meatpaste/pinbench#readme'
const ISSUES_URL = 'https://github.com/meatpaste/pinbench/issues'
const WIKI_URL = 'https://github.com/meatpaste/pinbench/wiki'
const USER_GUIDE_URL = 'https://github.com/meatpaste/pinbench/blob/main/docs/status.md'

/**
 * Commands the main process answers itself. Everything else is forwarded to the
 * renderer, which owns the workspace state.
 */
const MAIN_HANDLED: Partial<Record<CommandId, () => void>> = {
  'help.documentation': () => void shell.openExternal(DOCS_URL),
  'help.wiki': () => void shell.openExternal(WIKI_URL),
  'help.userGuide': () => void shell.openExternal(USER_GUIDE_URL),
  'help.reportIssue': () => void shell.openExternal(ISSUES_URL)
}

/**
 * The runtime "auto-approve agent actions" switch, surfaced as a native menu
 * checkbox. Only wired when the app was started `--acp` — it is a main-process
 * toggle, not a renderer command, so it lives outside the shared menu spec.
 */
export interface AgentMenuState {
  autoApprove: boolean
  onToggle(next: boolean): void
}

/**
 * Build the native menu from the shared spec, so the accelerators work wherever
 * focus is and the in-window menu bar cannot drift from them.
 */
export function buildApplicationMenu(
  getWindow: () => BrowserWindow | null,
  agent?: AgentMenuState
): Menu {
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

  if (agent) {
    template.push({
      label: 'Agent',
      submenu: [
        {
          label: 'Auto-approve agent actions',
          type: 'checkbox',
          checked: agent.autoApprove,
          click: (item) => agent.onToggle(item.checked)
        }
      ]
    })
  }

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
