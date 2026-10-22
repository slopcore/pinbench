import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SessionBar } from './SessionBar'

const base = {
  recentFolders: ['/home/me/MeshCore', '/home/me/other-fw'],
  activeFolder: '/home/me/MeshCore' as string | null,
  onPickRecent: vi.fn(),
  onBrowse: vi.fn(),
  availableBoards: ['heltec-wireless-paper-v1.1', 'thinknode-m9-v1.0'],
  boardId: 'heltec-wireless-paper-v1.1',
  boardName: 'Heltec Wireless Paper v1.1',
  onSelectBoard: vi.fn(),
  envs: ['Ebyte_EoRa_S3_Repeater', 'Heltec_Wireless_Paper_repeater', 'Heltec_Paper_room_server'],
  env: 'Heltec_Wireless_Paper_repeater' as string | null,
  onSelectEnv: vi.fn(),
  firmwareHint: { env: 'Heltec_Wireless_Paper_repeater', envMatch: 'paper' },
  showAllEnvs: false,
  onToggleAllEnvs: vi.fn()
}

/** Open the env combobox and return its currently visible option labels. */
async function envOptions(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  const trigger = screen.getByLabelText('Build environment')
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger)
  const list = screen.getByRole('listbox', { name: 'Build environment' })
  return within(list)
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '')
}

describe('SessionBar', () => {
  it('lists recent folders by basename plus a Browse… entry', () => {
    render(<SessionBar {...base} />)
    const fw = screen.getByLabelText('Firmware source folder')
    const opts = [...fw.querySelectorAll('option')].map((o) => o.textContent)
    expect(opts).toContain('MeshCore')
    expect(opts).toContain('other-fw')
    expect(opts).toContain('Browse…')
  })

  it('calls onBrowse when Browse… is chosen, onPickRecent for a folder', async () => {
    const onBrowse = vi.fn()
    const onPickRecent = vi.fn()
    const user = userEvent.setup()
    render(<SessionBar {...base} onBrowse={onBrowse} onPickRecent={onPickRecent} />)
    const fw = screen.getByLabelText('Firmware source folder')
    await user.selectOptions(fw, '__browse__')
    expect(onBrowse).toHaveBeenCalled()
    await user.selectOptions(fw, '/home/me/other-fw')
    expect(onPickRecent).toHaveBeenCalledWith('/home/me/other-fw')
  })

  it('narrows the env list to profile-compatible envs by default', async () => {
    const user = userEvent.setup()
    render(<SessionBar {...base} />)
    expect(await envOptions(user)).toEqual([
      'Heltec_Wireless_Paper_repeater',
      'Heltec_Paper_room_server'
    ])
  })

  it('shows every env once "All" is toggled', async () => {
    const user = userEvent.setup()
    render(<SessionBar {...base} showAllEnvs />)
    expect(await envOptions(user)).toEqual(base.envs)
  })

  it('toggles the env filter', async () => {
    const onToggleAllEnvs = vi.fn()
    const user = userEvent.setup()
    render(<SessionBar {...base} onToggleAllEnvs={onToggleAllEnvs} />)
    await user.selectOptions(screen.getByLabelText('Env filter'), 'all')
    expect(onToggleAllEnvs).toHaveBeenCalled()
  })

  it('filters the dropdown list from the box at the top of it', async () => {
    const user = userEvent.setup()
    render(<SessionBar {...base} showAllEnvs />)
    await user.click(screen.getByLabelText('Build environment'))
    await user.type(screen.getByLabelText('Filter environments'), 'room')
    const list = screen.getByRole('listbox', { name: 'Build environment' })
    expect(
      within(list)
        .queryAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Heltec_Paper_room_server'])
  })

  it('picks an env from the filtered list', async () => {
    const onSelectEnv = vi.fn()
    const user = userEvent.setup()
    render(<SessionBar {...base} showAllEnvs onSelectEnv={onSelectEnv} />)
    await user.click(screen.getByLabelText('Build environment'))
    await user.type(screen.getByLabelText('Filter environments'), 'room')
    await user.click(screen.getByRole('option', { name: 'Heltec_Paper_room_server' }))
    expect(onSelectEnv).toHaveBeenCalledWith('Heltec_Paper_room_server')
  })

  it('disables the env picker when no folder is open', () => {
    render(<SessionBar {...base} activeFolder={null} envs={[]} env={null} />)
    expect(screen.getByLabelText('Build environment')).toBeDisabled()
  })
})
