import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '@shared/workspace'
import type { WorkspaceState } from '@shared/workspace'
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
  // before a test starts clicking.
  await screen.findByText(/GPIO assigned/)
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
    expect(screen.getByText('9 parts · 12 nets · 31 GPIO assigned')).toBeInTheDocument()
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
