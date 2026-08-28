import { useEffect } from 'react'
import type { CommandId } from '@shared/commands'

/**
 * Route commands from the native menu into the renderer. The in-window menu bar
 * calls the same handler directly, so a command behaves identically whether it
 * came from a click, an accelerator, or the platform menu.
 */
export function useMenuCommands(run: (command: CommandId) => void): void {
  useEffect(() => window.pinbench.onMenuCommand(run), [run])
}
