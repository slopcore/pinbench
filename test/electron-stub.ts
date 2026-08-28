import { tmpdir } from 'node:os'

/**
 * Enough of Electron for the main-process modules to be imported under Vitest.
 * Anything a test actually exercises takes its collaborators as arguments —
 * `SessionStore` takes its file path — so this stays a stub, not a simulator.
 */
export const app = {
  getPath: (): string => tmpdir(),
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  name: 'PinBench'
}

export const shell = { openExternal: async (): Promise<void> => undefined }
export const ipcMain = { on: (): void => undefined, handle: (): void => undefined }
export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  })
}
export const Menu = {
  buildFromTemplate: (template: unknown) => template,
  setApplicationMenu: (): void => undefined
}
export const BrowserWindow = class {}
