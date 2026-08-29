/**
 * The command table and the menu structure built from it.
 *
 * One list, two consumers: the main process turns it into a native `Menu` so
 * the accelerators work wherever focus is, and the renderer draws the in-window
 * menu bar from the same entries. They cannot drift.
 *
 * Commands whose milestone has not landed are present and disabled. A menu that
 * quietly omits half the design is harder to read against the design than one
 * that greys out what does not work yet.
 */

export const COMMANDS = [
  'file.newProject',
  'file.openProject',
  'file.openFirmware',
  'file.save',
  'file.saveAs',
  'file.exportHeader',
  'file.closeProject',
  'edit.undo',
  'edit.redo',
  'edit.duplicate',
  'edit.delete',
  'edit.autoArrange',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.selectAll',
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
  'build.start',
  'build.stop',
  'build.reset',
  'build.clean',
  'help.documentation',
  'help.shortcuts',
  'help.reportIssue',
  'help.about'
] as const

export type CommandId = (typeof COMMANDS)[number]

export interface MenuItemSpec {
  type: 'item'
  command: CommandId
  label: string
  /** Electron accelerator syntax; `CmdOrCtrl` renders as ⌘ on macOS. */
  accelerator?: string
  /** False until the milestone that implements it lands. */
  enabled: boolean
  /** Item draws a checkmark, and reads its state from the workspace. */
  checkable?: boolean
}

export interface MenuSeparatorSpec {
  type: 'separator'
}

export type MenuEntrySpec = MenuItemSpec | MenuSeparatorSpec

export interface MenuSpec {
  id: string
  label: string
  entries: MenuEntrySpec[]
}

const item = (
  command: CommandId,
  label: string,
  options: { accelerator?: string; enabled?: boolean; checkable?: boolean } = {}
): MenuItemSpec => ({
  type: 'item',
  command,
  label,
  enabled: options.enabled ?? true,
  ...(options.accelerator === undefined ? {} : { accelerator: options.accelerator }),
  ...(options.checkable === undefined ? {} : { checkable: options.checkable })
})

const separator: MenuSeparatorSpec = { type: 'separator' }

export const MENUS: MenuSpec[] = [
  {
    id: 'file',
    label: 'File',
    entries: [
      // Everything that touches a project or a firmware image belongs to M2/M3.
      item('file.newProject', 'New project…', { accelerator: 'CmdOrCtrl+N', enabled: false }),
      // "Open project…" opens a `.pinbench` file from M5; the firmware checkout
      // is attached from Build & flash.
      item('file.openProject', 'Open project…', { accelerator: 'CmdOrCtrl+O', enabled: true }),
      item('file.openFirmware', 'Open firmware image…', {
        accelerator: 'CmdOrCtrl+Shift+O',
        enabled: true
      }),
      separator,
      item('file.save', 'Save', { accelerator: 'CmdOrCtrl+S', enabled: true }),
      item('file.saveAs', 'Save as…', { accelerator: 'CmdOrCtrl+Shift+S', enabled: true }),
      separator,
      // Writes the pin-map C header (shared/codegen.ts) — the same output
      // Build & flash produces, on demand and to a path the user picks.
      item('file.exportHeader', 'Export pin header…', {
        accelerator: 'CmdOrCtrl+Shift+E',
        enabled: true
      }),
      separator,
      item('file.closeProject', 'Close project', { accelerator: 'CmdOrCtrl+W', enabled: false })
    ]
  },
  {
    id: 'edit',
    label: 'Edit',
    entries: [
      // Canvas editing (M11.3): undo/redo over BoardEdit history, plus the
      // design's part operations. Cut/Copy/Paste/Select-all stay inert.
      item('edit.undo', 'Undo', { accelerator: 'CmdOrCtrl+Z', enabled: true }),
      item('edit.redo', 'Redo', { accelerator: 'CmdOrCtrl+Shift+Z', enabled: true }),
      separator,
      item('edit.duplicate', 'Duplicate part', { accelerator: 'CmdOrCtrl+D', enabled: true }),
      item('edit.delete', 'Delete part', { accelerator: 'Delete', enabled: true }),
      item('edit.autoArrange', 'Auto-arrange by bus', { enabled: true }),
      separator,
      item('edit.cut', 'Cut', { accelerator: 'CmdOrCtrl+X', enabled: false }),
      item('edit.copy', 'Copy', { accelerator: 'CmdOrCtrl+C', enabled: false }),
      item('edit.paste', 'Paste', { accelerator: 'CmdOrCtrl+V', enabled: false }),
      item('edit.selectAll', 'Select all', { accelerator: 'CmdOrCtrl+A', enabled: false })
    ]
  },
  {
    id: 'view',
    label: 'View',
    entries: [
      item('view.toggleLibrary', 'Library panel', {
        accelerator: 'CmdOrCtrl+1',
        checkable: true
      }),
      item('view.toggleInspector', 'Inspector panel', {
        accelerator: 'CmdOrCtrl+2',
        checkable: true
      }),
      item('view.toggleSource', 'Source', { accelerator: 'CmdOrCtrl+3', checkable: true }),
      separator,
      item('view.serialMonitor', 'Serial monitor', { accelerator: 'CmdOrCtrl+4', checkable: true }),
      item('view.diagnostics', 'Diagnostics', { accelerator: 'CmdOrCtrl+5', checkable: true }),
      separator,
      item('view.zoomIn', 'Zoom in', { accelerator: 'CmdOrCtrl+Plus' }),
      item('view.zoomOut', 'Zoom out', { accelerator: 'CmdOrCtrl+-' }),
      item('view.zoomReset', 'Actual size', { accelerator: 'CmdOrCtrl+0' }),
      item('view.fit', 'Fit to window', { accelerator: 'CmdOrCtrl+Shift+F' }),
      separator,
      item('view.gridDot', 'Dot grid', { checkable: true }),
      item('view.gridLine', 'Line grid', { checkable: true }),
      item('view.gridNone', 'No grid', { checkable: true }),
      item('view.snapToGrid', 'Snap to grid', { accelerator: 'CmdOrCtrl+G', checkable: true }),
      separator,
      // No menu accelerator: a bare single-key Electron accelerator fires even
      // while a text field has focus. The renderer binds `L` itself and bails
      // when the event target is an input.
      item('view.busLabels', 'Bus labels  (L)', { checkable: true })
    ]
  },
  {
    id: 'build',
    label: 'Build',
    entries: [
      // Build & flash and PlatformIO land in M3; the pin-map rule engine
      // behind ⌘B lands in M11.1.
      item('build.buildAndFlash', 'Build & flash', {
        accelerator: 'CmdOrCtrl+Shift+B',
        enabled: true
      }),
      // The one path that writes real hardware — build board-native, then
      // esptool over USB. See docs/adr/0003-usb-flashing.md.
      item('build.flashUsb', 'Flash over USB…', {
        accelerator: 'CmdOrCtrl+Shift+U',
        enabled: true
      }),
      item('build.verifyPinMap', 'Verify pin map', { accelerator: 'CmdOrCtrl+B', enabled: true }),
      item('build.clean', 'Clean build cache', { enabled: true }),
      separator,
      item('build.start', 'Start', { accelerator: 'CmdOrCtrl+R', enabled: true }),
      item('build.stop', 'Stop', { accelerator: 'CmdOrCtrl+.', enabled: true }),
      item('build.reset', 'Reset', { accelerator: 'CmdOrCtrl+Shift+R', enabled: true })
    ]
  },
  {
    id: 'help',
    label: 'Help',
    entries: [
      item('help.documentation', 'Documentation'),
      item('help.shortcuts', 'Keyboard shortcuts'),
      item('help.reportIssue', 'Report an issue'),
      separator,
      item('help.about', 'About PinBench')
    ]
  }
]

/** Render an Electron accelerator the way the design draws it. */
export function formatAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin'
  return accelerator
    .split('+')
    .map((key) => {
      switch (key) {
        case 'CmdOrCtrl':
        case 'Cmd':
          return mac ? '⌘' : 'Ctrl'
        case 'Shift':
          return mac ? '⇧' : 'Shift'
        case 'Alt':
          return mac ? '⌥' : 'Alt'
        case 'Ctrl':
          return mac ? '⌃' : 'Ctrl'
        case 'Plus':
          return '+'
        case 'Delete':
          return mac ? '⌫' : 'Del'
        default:
          return key
      }
    })
    .join(mac ? '' : '+')
}

export function menuItems(spec: MenuSpec): MenuItemSpec[] {
  return spec.entries.filter((entry): entry is MenuItemSpec => entry.type === 'item')
}

export function allMenuItems(): MenuItemSpec[] {
  return MENUS.flatMap(menuItems)
}
