import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '@shared/workspace'
import type { WorkspaceState } from '@shared/workspace'
import { MENUS } from '@shared/commands'
import { App } from './App'
import { M9_BOARD } from '../../../test/board'
import { installBridge, type TestBridge } from '../../../test/setup'

const APP_INFO = { version: '0.1.0', platform: 'darwin' as NodeJS.Platform, isDev: true }
const WINDOW_STATE = { maximised: false, fullScreen: false, focused: true }

async function renderApp(
  initial: WorkspaceState = DEFAULT_WORKSPACE
): Promise<{ bridge: TestBridge; user: ReturnType<typeof userEvent.setup> }> {
  const bridge = installBridge(initial)
  const user = userEvent.setup()
  render(
    <App
      appInfo={APP_INFO}
      windowState={WINDOW_STATE}
      board={M9_BOARD}
      availableBoards={[M9_BOARD.id]}
      onSelectBoard={() => {}}
      initialProject={null}
    />
  )
  // The status bar is always present; waiting on it lets the restore land
  // before a test starts clicking. (The same totals string also renders in the
  // canvas overlay chip, so match all occurrences.)
  await screen.findAllByText(/GPIO assigned/)
  return { bridge, user }
}

describe('the shell', () => {
  it('draws the three columns and the dock', async () => {
    await renderApp()
    expect(screen.getByRole('complementary', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dock' })).toBeInTheDocument()
    expect(screen.getByRole('application', { name: /diagram/i })).toBeInTheDocument()
  })

  it('offers a board picker when more than one board is on disk', async () => {
    installBridge(DEFAULT_WORKSPACE)
    const user = userEvent.setup()
    const onSelectBoard = vi.fn()
    render(
      <App
        appInfo={APP_INFO}
        windowState={WINDOW_STATE}
        board={M9_BOARD}
        availableBoards={[M9_BOARD.id, 'heltec-wireless-paper-v1.1']}
        onSelectBoard={onSelectBoard}
        initialProject={null}
      />
    )
    const picker = await screen.findByRole('combobox', { name: 'Board' })
    expect(picker).toHaveValue(M9_BOARD.id)
    await user.selectOptions(picker, 'heltec-wireless-paper-v1.1')
    expect(onSelectBoard).toHaveBeenCalledWith('heltec-wireless-paper-v1.1')
  })

  it('shows counts computed from the board definition', async () => {
    await renderApp()
    // Both the status bar and the canvas overlay chip carry the computed totals.
    expect(screen.getAllByText('9 parts · 12 nets · 31 GPIO assigned').length).toBeGreaterThan(0)
  })
})

describe('panel toggles', () => {
  it('hides and restores the Library from the toolbar', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Library' }))
    expect(screen.queryByRole('complementary', { name: 'Library' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Library' }))
    expect(screen.getByRole('complementary', { name: 'Library' })).toBeInTheDocument()
  })

  it('hides the Inspector from the View menu', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'View' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Inspector panel/ }))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument()
  })

  it('closes the dock from its own close button', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Hide dock' }))
    expect(screen.queryByRole('region', { name: 'Dock' })).not.toBeInTheDocument()
  })

  it('collapses the dock to its tab strip from the chevron', async () => {
    const { bridge, user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Collapse dock' }))
    expect(screen.queryByRole('tabpanel', { name: 'Serial monitor' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dock' })).toHaveAttribute('data-collapsed')
    await waitFor(() => expect(bridge.saved.at(-1)?.dockCollapsed).toBe(true))
  })
})

describe('the menu bar', () => {
  it('switches menus on hover once one is open, and not before', async () => {
    const { user } = await renderApp()
    const file = screen.getByRole('menuitem', { name: 'File' })
    const view = screen.getByRole('menuitem', { name: 'View' })

    await user.hover(view)
    expect(screen.queryByRole('menu', { name: 'View' })).not.toBeInTheDocument()

    await user.click(file)
    expect(screen.getByRole('menu', { name: 'File' })).toBeInTheDocument()
    await user.hover(view)
    expect(screen.getByRole('menu', { name: 'View' })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'File' })).not.toBeInTheDocument()
  })

  it('dismisses on a click outside', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByRole('menu', { name: 'File' })).toBeInTheDocument()
    await user.click(screen.getByRole('application', { name: /diagram/i }))
    expect(screen.queryByRole('menu', { name: 'File' })).not.toBeInTheDocument()
  })

  it('dismisses on Escape', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'File' })).not.toBeInTheDocument()
  })

  it('checks the items that reflect workspace state', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.getByRole('menuitemcheckbox', { name: /Library panel/ })).toBeChecked()
    expect(screen.getByRole('menuitemcheckbox', { name: /Dot grid/ })).toBeChecked()
    expect(screen.getByRole('menuitemcheckbox', { name: /No grid/ })).not.toBeChecked()
  })

  it('enables Verify pin map now the M11.1 rule engine has landed', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'Build' }))
    expect(screen.getByRole('menuitem', { name: /Verify pin map/ })).not.toBeDisabled()
  })

  it('Verify pin map runs the rule engine and shows a chip-select row in the dock', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'Build' }))
    await user.click(screen.getByRole('menuitem', { name: /Verify pin map/ }))
    // The shipped M9 is clean, so the SPI0 chip-select `ok` row appears.
    expect(await screen.findByText(/SPI0: 3 chip-selects/)).toBeInTheDocument()
  })
})

describe('menu handlers', () => {
  it('opens the keyboard-shortcuts sheet from Help', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'Help' }))
    await user.click(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' }))
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('opens the About sheet from Help', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'Help' }))
    await user.click(screen.getByRole('menuitem', { name: 'About PinBench' }))
    expect(screen.getByRole('dialog', { name: 'About PinBench' })).toBeInTheDocument()
  })

  it('exports the pin header through the bridge', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    await user.click(screen.getByRole('menuitem', { name: /Export pin header/ }))
    expect(window.pinbench.board.exportPinHeader).toHaveBeenCalled()
  })

  it('toggles bus labels off from the View menu', async () => {
    const { bridge, user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'View' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Bus labels/ }))
    await waitFor(() => expect(bridge.saved.at(-1)?.canvas.busLabels).toBe(false))
  })

  it('toggles bus labels with the L key, but not while a text field has focus', async () => {
    const { bridge, user } = await renderApp()
    await user.keyboard('l')
    await waitFor(() => expect(bridge.saved.at(-1)?.canvas.busLabels).toBe(false))

    const filter = screen.getByRole('searchbox', { name: /Filter parts/ })
    filter.focus()
    await user.keyboard('l')
    // Still false — the keystroke went to the filter box, not the toggle.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(bridge.saved.at(-1)?.canvas.busLabels).toBe(false)
  })

  // Smoke test: click every enabled menu item once and assert nothing throws.
  // The real "no enabled command without a handler" guard is the explicit list
  // in commands.test.ts — a fallthrough throws nothing, so this can't catch it.
  it('clicks every enabled menu item without throwing', async () => {
    const errors: unknown[] = []
    const onError = (event: ErrorEvent): void => void errors.push(event.error)
    window.addEventListener('error', onError)
    try {
      for (const menu of MENUS) {
        const labels = menu.entries
          .filter((entry) => entry.type === 'item' && entry.enabled)
          .map((entry) => (entry as { label: string }).label)
        for (const label of labels) {
          cleanup()
          const { user } = await renderApp()
          await user.click(screen.getByRole('menuitem', { name: menu.label }))
          const openMenu = screen.getByRole('menu', { name: menu.label })
          const button = [
            ...openMenu.querySelectorAll<HTMLButtonElement>('button.menu__item')
          ].find((node) => node.querySelector('.menu__label')?.textContent === label)
          expect(button, `no menu button for "${label}"`).toBeTruthy()
          await user.click(button!)
        }
      }
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toEqual([])
  })
})

describe('tabs', () => {
  it('switches the workspace between Diagram and Source', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('tabpanel', { name: 'Source' })).toBeInTheDocument()
    expect(screen.queryByRole('application', { name: /diagram/i })).not.toBeInTheDocument()
  })

  it('switches the dock between Serial monitor and Diagnostics', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('tab', { name: /Diagnostics/ }))
    expect(screen.getByRole('tabpanel', { name: 'Diagnostics' })).toBeInTheDocument()
    expect(screen.queryByRole('tabpanel', { name: 'Serial monitor' })).not.toBeInTheDocument()
  })
})

describe('selection', () => {
  it('shows the part the Library selected in the Inspector', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(
      within(inspector).getByRole('heading', { name: 'LR1110 mesh radio' })
    ).toBeInTheDocument()
    expect(within(inspector).getByText('GPIO39')).toBeInTheDocument()
  })

  it('shows Identity, Nets and the firmware-hook card for a selected part', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText('Identity')).toBeInTheDocument()
    expect(within(inspector).getByText('Reference')).toBeInTheDocument()
    expect(within(inspector).getByText(/^Nets \(/)).toBeInTheDocument()
    expect(within(inspector).getByText('Lr1110Radio::begin()')).toBeInTheDocument()
  })

  it('deletes the selected part from the Edit menu and undoes it', async () => {
    const { user } = await renderApp()
    const canvas = (): HTMLElement => screen.getByRole('application', { name: /diagram/i })
    await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
    expect(within(canvas()).getByText('LR1110 mesh radio')).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('menuitem', { name: /Delete part/ }))
    expect(within(canvas()).queryByText('LR1110 mesh radio')).not.toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('menuitem', { name: /^Undo/ }))
    expect(within(canvas()).getByText('LR1110 mesh radio')).toBeInTheDocument()
  })

  it('duplicates the selected part from the Edit menu', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /2.4" LCD/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('menuitem', { name: /Duplicate part/ }))
    // The copy carries the "U3'" designator.
    expect(screen.getAllByText("U3'").length).toBeGreaterThan(0)
  })

  it('persists canvas edits into the saved project file', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('menuitem', { name: /Delete part/ }))
    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    const fileMenu = screen.getByRole('menu', { name: 'File' })
    const saveBtn = [...fileMenu.querySelectorAll<HTMLButtonElement>('button.menu__item')].find(
      (b) => b.querySelector('.menu__label')?.textContent === 'Save'
    )!
    await user.click(saveBtn)
    const save = vi.mocked(window.pinbench.projectFile.save)
    const project = save.mock.calls.at(-1)?.[1]
    expect(project?.boardEdits).toEqual([{ kind: 'deletePart', partId: 'u2' }])
  })

  it('selects a part from the Library place affordance', async () => {
    const { user } = await renderApp()
    const library = screen.getByRole('complementary', { name: 'Library' })
    expect(within(library).getByText(/Click a part to inspect it/)).toBeInTheDocument()
    const placeButtons = within(library).getAllByRole('button', { name: 'Place part on canvas' })
    await user.click(placeButtons[0]!)
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText('Identity')).toBeInTheDocument()
  })

  it('records an Inspector config change', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const spreading = within(inspector).getByRole('group', { name: 'Spreading factor' })
    await user.click(within(spreading).getByRole('button', { name: '7' }))
    expect(within(spreading).getByRole('button', { name: '7' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

describe('persistence', () => {
  it('restores the layout it was given', async () => {
    await renderApp({
      ...DEFAULT_WORKSPACE,
      panels: { library: false, inspector: true, dock: true },
      workspaceTab: 'source',
      dockTab: 'diagnostics'
    })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Library' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('tabpanel', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'Diagnostics' })).toBeInTheDocument()
  })

  it('writes a layout change back over the bridge', async () => {
    const { bridge, user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Inspector' }))
    await waitFor(() => expect(bridge.saved.at(-1)?.panels.inspector).toBe(false))
  })
})
