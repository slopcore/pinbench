import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE } from '@shared/workspace'
import type { WorkspaceState } from '@shared/workspace'
import { App } from './App'
import { installBridge, type TestBridge } from '../../../test/setup'

const APP_INFO = { version: '0.1.0', platform: 'darwin' as NodeJS.Platform, isDev: true }
const WINDOW_STATE = { maximised: false, fullScreen: false, focused: true }

async function renderApp(
  initial: WorkspaceState = DEFAULT_WORKSPACE
): Promise<{ bridge: TestBridge; user: ReturnType<typeof userEvent.setup> }> {
  const bridge = installBridge(initial)
  const user = userEvent.setup()
  render(<App appInfo={APP_INFO} windowState={WINDOW_STATE} />)
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

  it('leaves unimplemented commands disabled rather than lying', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('menuitem', { name: 'Build' }))
    expect(screen.getByRole('menuitem', { name: /Build & flash/ })).toBeDisabled()
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
