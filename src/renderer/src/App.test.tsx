import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

type LaunchOverrides = Partial<Parameters<typeof App>[0]['initialFolder']>

function launchState(overrides: LaunchOverrides = {}): Parameters<typeof App>[0]['initialFolder'] {
  return {
    lastBoardId: null,
    folder: null,
    recentFolders: [],
    env: null,
    partConfig: {},
    boardEdits: [],
    ...overrides
  }
}

async function renderApp(
  initial: WorkspaceState = DEFAULT_WORKSPACE,
  folderOverrides: LaunchOverrides = {}
): Promise<{
  bridge: TestBridge
  user: ReturnType<typeof userEvent.setup>
  rerender: (next: LaunchOverrides) => void
}> {
  const bridge = installBridge(initial)
  const user = userEvent.setup()
  const element = (folder: LaunchOverrides): React.JSX.Element => (
    <App
      appInfo={APP_INFO}
      windowState={WINDOW_STATE}
      board={M9_BOARD}
      availableBoards={[M9_BOARD.id]}
      onSelectBoard={() => {}}
      onProfileSaved={() => {}}
      initialFolder={launchState(folder)}
    />
  )
  const view = render(element(folderOverrides))
  // The status bar is always present; waiting on it lets the restore land
  // before a test starts clicking. (The same totals string also renders in the
  // canvas overlay chip, so match all occurrences.)
  await screen.findAllByText(/GPIO assigned/)
  return { bridge, user, rerender: (next) => view.rerender(element(next)) }
}

describe('the shell', () => {
  it('draws the three columns and the dock', async () => {
    await renderApp()
    expect(screen.getByRole('complementary', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dock' })).toBeInTheDocument()
    expect(screen.getByRole('application', { name: /hardware/i })).toBeInTheDocument()
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
        onProfileSaved={() => {}}
        initialFolder={{
          lastBoardId: null,
          folder: null,
          recentFolders: [],
          env: null,
          partConfig: {},
          boardEdits: []
        }}
      />
    )
    const picker = await screen.findByRole('combobox', { name: 'Hardware profile' })
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
    await user.click(screen.getByRole('application', { name: /hardware/i }))
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

  it('imports a pin header and applies it as a canvas rebind', async () => {
    const { user } = await renderApp()
    vi.mocked(window.pinbench.board.importPinHeader).mockResolvedValueOnce('#define U3_CS_PIN 21\n')
    await user.click(screen.getByRole('button', { name: /2.4" LCD/ }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText('GPIO16')).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'File' }))
    await user.click(screen.getByRole('menuitem', { name: /Import pin header/ }))
    await waitFor(() => expect(within(inspector).getByText('GPIO21')).toBeInTheDocument())
    expect(within(inspector).queryByText('GPIO16')).not.toBeInTheDocument()
  })

  it('syncs the OUT-panel zoom picker with the Inspector scale field', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('button', { name: /2.4" LCD/ }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const output = within(inspector).getByRole('region', { name: 'Output' })

    // Two "3×" buttons: the OUT-panel picker and the Configuration field.
    const threes = within(inspector).getAllByRole('button', { name: '3×' })
    expect(threes).toHaveLength(2)
    const configThree = threes.find((b) => !output.contains(b))!
    const panelThree = threes.find((b) => output.contains(b))!
    expect(configThree).toHaveAttribute('aria-pressed', 'false')

    // Clicking the panel picker must move the Configuration field too.
    await user.click(panelThree)
    expect(configThree).toHaveAttribute('aria-pressed', 'true')
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
    // Re-renders <App> once per enabled menu item; comfortably over the 5s
    // default on a loaded CI box.
  }, 15_000)
})

describe('tabs', () => {
  it('switches the dock between Serial monitor and Compiler output', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('tab', { name: /Compiler output/ }))
    expect(screen.getByRole('tabpanel', { name: 'Compiler output' })).toBeInTheDocument()
    expect(screen.queryByRole('tabpanel', { name: 'Serial monitor' })).not.toBeInTheDocument()
  })

  it('opens a Console output tab, separate from Compiler output', async () => {
    const { user } = await renderApp()
    await user.click(screen.getByRole('tab', { name: /Console output/ }))
    const panel = screen.getByRole('tabpanel', { name: 'Console output' })
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveTextContent(/No build output yet/)
    expect(screen.queryByRole('tabpanel', { name: 'Compiler output' })).not.toBeInTheDocument()
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
    const canvas = (): HTMLElement => screen.getByRole('application', { name: /hardware/i })
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
    // The copy carries a letter-suffixed designator ("U3B").
    expect(screen.getAllByText('U3B').length).toBeGreaterThan(0)
  })

  it('bakes canvas edits into a new hardware profile', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('m9-no-radio')
    try {
      const { user } = await renderApp()
      await user.click(screen.getByRole('button', { name: /LR1110 mesh radio/ }))
      await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
      await user.click(screen.getByRole('menuitem', { name: /Delete part/ }))
      await user.click(screen.getByRole('menuitem', { name: 'File' }))
      const fileMenu = screen.getByRole('menu', { name: 'File' })
      const saveBtn = [...fileMenu.querySelectorAll<HTMLButtonElement>('button.menu__item')].find(
        (b) => b.querySelector('.menu__label')?.textContent === 'Save hardware profile as…'
      )!
      await user.click(saveBtn)
      const saveProfile = vi.mocked(window.pinbench.board.saveProfile)
      const [id, def] = saveProfile.mock.calls.at(-1)!
      expect(id).toBe('m9-no-radio')
      expect(def.parts.some((p) => p.id === 'u2')).toBe(false)
    } finally {
      promptSpy.mockRestore()
    }
  })

  it('adds a generic catalogue part to the canvas from the Library', async () => {
    const { user } = await renderApp()
    const library = screen.getByRole('complementary', { name: 'Library' })
    expect(within(library).getByText('Expansion · generic')).toBeInTheDocument()
    await user.click(within(library).getByRole('button', { name: 'Add LED to the board' }))
    // The new part shows on the canvas and drives the totals up by one.
    const canvas = screen.getByRole('application', { name: /hardware/i })
    expect(within(canvas).getByText('LED')).toBeInTheDocument()
    expect(screen.getAllByText(/10 parts · /).length).toBeGreaterThan(0)
  })

  it('selects a part from the Library place affordance', async () => {
    const { user } = await renderApp()
    const library = screen.getByRole('complementary', { name: 'Library' })
    expect(within(library).getByText(/Click a board part to inspect it/)).toBeInTheDocument()
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
      dockTab: 'compiler'
    })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Library' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('tabpanel', { name: 'Compiler output' })).toBeInTheDocument()
  })

  it('writes a layout change back over the bridge', async () => {
    const { bridge, user } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Inspector' }))
    await waitFor(() => expect(bridge.saved.at(-1)?.panels.inspector).toBe(false))
  })
})

describe('the workspace error toast', () => {
  const emit = (
    bridge: TestBridge,
    status: Parameters<TestBridge['emitBuildState']>[0]
  ): Promise<void> =>
    act(async () => {
      bridge.emitBuildState(status)
    })

  it('surfaces a failed build and opens the compiler output dock when clicked', async () => {
    const { bridge, user } = await renderApp()
    await emit(bridge, { state: 'failed', error: 'undefined reference to `loop`' })

    const toast = await screen.findByRole('alert')
    expect(within(toast).getByText(/undefined reference/)).toBeInTheDocument()

    await user.click(within(toast).getByRole('button', { name: /Open compiler output/ }))
    expect(screen.getByRole('tabpanel', { name: 'Compiler output' })).toBeInTheDocument()
    // Dock is now showing the target tab, so the toast retires itself.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('re-raises once dismissed only after the error row clears', async () => {
    const { bridge, user } = await renderApp()
    await emit(bridge, { state: 'failed', error: 'first failure' })
    await user.click(
      within(await screen.findByRole('alert')).getByRole('button', { name: 'Dismiss' })
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // A rebuild clears the error row, then fails again — the toast comes back
    // even though the message is identical.
    await emit(bridge, { state: 'preparing' })
    await emit(bridge, { state: 'failed', error: 'first failure' })
    expect(await screen.findByRole('alert')).toHaveTextContent('first failure')
  })

  it('routes an emulator crash to the serial log even past a build error', async () => {
    // Dock collapsed so neither the serial nor the compiler-output target is
    // already on screen — the "dock already shows it" suppression stays out.
    const { bridge } = await renderApp({ ...DEFAULT_WORKSPACE, dockCollapsed: true })
    // Build fails first — that error wins the toast and points at compiler output.
    await emit(bridge, { state: 'failed', error: 'link error' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/link error.*Open compiler output/s)

    await act(async () => {
      bridge.emitEmulatorStatus({ state: 'crashed', error: 'qemu exited 1' })
    })
    // Build error still on the board, so it still owns the toast.
    expect(screen.getByRole('alert')).toHaveTextContent(/link error.*Open compiler output/s)

    // Rebuild clears the build row; the crash is now the only error and it
    // routes to serial, not to whatever sits first in the list.
    await emit(bridge, { state: 'preparing' })
    expect(screen.getByRole('alert')).toHaveTextContent(/qemu exited 1.*Open serial/s)
  })
})

describe('the agent dock panel', () => {
  const enabled = {
    enabled: true,
    agentConfigured: true,
    ready: true,
    busy: false,
    autoApprove: false
  }

  it('reveals the closed dock on the Agent tab when an approval is pending', async () => {
    const { bridge } = await renderApp({
      ...DEFAULT_WORKSPACE,
      panels: { ...DEFAULT_WORKSPACE.panels, dock: false }
    })
    await act(async () => {
      bridge.emitAgentState(enabled)
    })
    expect(screen.queryByRole('tabpanel', { name: 'Agent' })).not.toBeInTheDocument()

    await act(async () => {
      bridge.emitAgentPermission({ id: 'p1', kind: 'exec', title: 'Build & flash' })
    })

    const panel = await screen.findByRole('tabpanel', { name: 'Agent' })
    expect(within(panel).getByRole('alertdialog')).toHaveTextContent('Build & flash')
  })
})

describe('canvas layout persistence', () => {
  const FOLDER = { dir: '/repo/MeshCore', name: 'MeshCore', envs: ['env-a'] }

  it('persists a card drag to the open (folder, profile) pair', async () => {
    const { bridge } = await renderApp(DEFAULT_WORKSPACE, { folder: FOLDER, env: 'env-a' })
    const setFolderState = bridge.project.setFolderState as ReturnType<typeof vi.fn>
    setFolderState.mockClear()

    const card = screen
      .getByText('LR1110 mesh radio', { selector: '.canvas__card-name' })
      .closest('.canvas__card') as HTMLElement
    // Separate calls: each flushes effects, so the window drag listeners are
    // attached before the move/up fire.
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 80, clientY: 40 })
    fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 80, clientY: 40 })

    await waitFor(() => expect(setFolderState).toHaveBeenCalled())
    const [dir, boardId, patch] = setFolderState.mock.calls.at(-1)!
    expect(dir).toBe(FOLDER.dir)
    expect(boardId).toBe(M9_BOARD.id)
    expect(patch.boardEdits).toEqual([expect.objectContaining({ kind: 'moveParty', partId: 'u2' })])
    // A layout patch must not carry env / config — those stay the writers' job.
    expect(patch).not.toHaveProperty('env')
    expect(patch).not.toHaveProperty('partConfig')
  })

  it('restores a remembered layout on the next launch', async () => {
    await renderApp(DEFAULT_WORKSPACE, {
      folder: FOLDER,
      env: 'env-a',
      boardEdits: [{ kind: 'moveParty', partId: 'u2', x: 400, y: 440 }]
    })
    const movedCard = screen
      .getByText('LR1110 mesh radio', { selector: '.canvas__card-name' })
      .closest('g.canvas__part') as SVGGElement
    expect(movedCard.getAttribute('transform')).toBe('translate(400 440)')
  })
})
