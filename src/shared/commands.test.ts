import { describe, expect, it } from 'vitest'
import { COMMANDS, MENUS, allMenuItems, formatAccelerator } from './commands'

describe('menu spec', () => {
  it('gives every menu item a command from the command table', () => {
    const known = new Set<string>(COMMANDS)
    for (const item of allMenuItems()) expect(known.has(item.command)).toBe(true)
  })

  it('uses each command exactly once', () => {
    const seen = allMenuItems().map((item) => item.command)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('binds each accelerator to exactly one command', () => {
    const accelerators = allMenuItems()
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => accelerator !== undefined)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('carries the panel toggles the milestone names', () => {
    const view = MENUS.find((menu) => menu.id === 'view')
    const byCommand = new Map(
      view?.entries
        .filter((entry) => entry.type === 'item')
        .map((entry) => [entry.command, entry] as const)
    )
    expect(byCommand.get('view.toggleLibrary')?.accelerator).toBe('CmdOrCtrl+1')
    expect(byCommand.get('view.toggleInspector')?.accelerator).toBe('CmdOrCtrl+2')
    expect(byCommand.get('view.toggleSource')?.accelerator).toBe('CmdOrCtrl+3')
    for (const command of [
      'view.toggleLibrary',
      'view.toggleInspector',
      'view.toggleSource'
    ] as const) {
      expect(byCommand.get(command)?.enabled).toBe(true)
    }
  })

  it('leaves commands whose milestone has not landed disabled', () => {
    const disabled = allMenuItems().filter((item) => !item.enabled)
    expect(disabled.map((item) => item.command)).toContain('build.buildAndFlash')
    expect(disabled.map((item) => item.command)).toContain('file.openFirmware')
  })
})

describe('formatAccelerator', () => {
  it('renders macOS glyphs', () => {
    expect(formatAccelerator('CmdOrCtrl+1', 'darwin')).toBe('⌘1')
    expect(formatAccelerator('CmdOrCtrl+Shift+F', 'darwin')).toBe('⌘⇧F')
  })

  it('spells the modifiers out elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+1', 'win32')).toBe('Ctrl+1')
    expect(formatAccelerator('CmdOrCtrl+Shift+F', 'linux')).toBe('Ctrl+Shift+F')
  })
})
