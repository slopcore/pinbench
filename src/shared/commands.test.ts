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
    expect(disabled.map((item) => item.command)).toContain('edit.cut')
  })

  it('enables Verify pin map — the M11.1 rule engine', () => {
    const enabled = allMenuItems().filter((item) => item.enabled)
    expect(enabled.map((item) => item.command)).toContain('build.verifyPinMap')
  })

  // The real guard against an enabled command with no handler: this list is
  // explicit, so enabling a new command forces you here — and every id below
  // must have a `case` in App.tsx's `runCommand` (or be handled in the main
  // process, like the help.* links). If you add one, wire the handler too.
  it('enables exactly the commands that have a runCommand handler', () => {
    const enabled = allMenuItems()
      .filter((item) => item.enabled)
      .map((item) => item.command)
      .sort()
    expect(enabled).toEqual(
      [
        'file.openProject',
        'file.openFirmware',
        'file.saveProfileAs',
        'file.exportHeader',
        'file.importPinout',
        'edit.undo',
        'edit.redo',
        'edit.duplicate',
        'edit.delete',
        'edit.autoArrange',
        'view.toggleLibrary',
        'view.toggleInspector',
        'view.toggleSource',
        'view.serialMonitor',
        'view.diagnostics',
        'view.zoomIn',
        'view.zoomOut',
        'view.zoomReset',
        'view.fit',
        'view.gridDot',
        'view.gridLine',
        'view.gridNone',
        'view.snapToGrid',
        'view.busLabels',
        'build.buildAndFlash',
        'build.flashUsb',
        'build.verifyPinMap',
        'build.clean',
        'build.start',
        'build.stop',
        'build.reset',
        'help.documentation',
        'help.wiki',
        'help.userGuide',
        'help.shortcuts',
        'help.reportIssue',
        'help.about'
      ].sort()
    )
  })

  it('enables the M2 emulator and M3 build commands', () => {
    const enabled = allMenuItems().filter((item) => item.enabled)
    const commands = enabled.map((item) => item.command)
    expect(commands).toContain('file.openFirmware')
    expect(commands).toContain('build.start')
    expect(commands).toContain('build.stop')
    expect(commands).toContain('build.reset')
    expect(commands).toContain('file.openProject')
    expect(commands).toContain('build.buildAndFlash')
    expect(commands).toContain('build.clean')
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
