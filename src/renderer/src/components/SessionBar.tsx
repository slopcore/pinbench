import { matchFirmwareEnvs } from '@shared/board'
import type { FirmwareHint } from '@shared/board'
import { EnvPicker } from './EnvPicker'
import './session-bar.css'

const BROWSE = '__browse__'

interface SessionBarProps {
  /** Recently opened source folders (absolute paths), most recent first. */
  recentFolders: string[]
  /** The open folder's path, or null when none is open. */
  activeFolder: string | null
  /** Adopt a folder from the recents dropdown. */
  onPickRecent: (dir: string) => void
  /** Open the native folder picker. */
  onBrowse: () => void

  availableBoards: string[]
  boardId: string
  boardName: string
  onSelectBoard: (id: string) => void

  /** Every build env the open folder defines. Empty when no folder is open. */
  envs: string[]
  env: string | null
  onSelectEnv: (env: string) => void
  /** Active hardware profile's firmware hint — narrows the env list. */
  firmwareHint?: FirmwareHint
  /** Show every env rather than only the ones compatible with the profile. */
  showAllEnvs: boolean
  onToggleAllEnvs: () => void
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function SessionBar({
  recentFolders,
  activeFolder,
  onPickRecent,
  onBrowse,
  availableBoards,
  boardId,
  boardName,
  onSelectBoard,
  envs,
  env,
  onSelectEnv,
  firmwareHint,
  showAllEnvs,
  onToggleAllEnvs
}: SessionBarProps): React.JSX.Element {
  // Recents, with the open folder guaranteed present and first.
  const folders = activeFolder
    ? [activeFolder, ...recentFolders.filter((p) => p !== activeFolder)]
    : recentFolders

  const compatible = matchFirmwareEnvs(envs, firmwareHint)
  const narrowed = compatible.length < envs.length
  let visibleEnvs = !narrowed || showAllEnvs ? envs : compatible
  // Keep whatever is actually selected visible even if it is out of the filter.
  if (env && !visibleEnvs.includes(env)) visibleEnvs = [env, ...visibleEnvs]

  return (
    <div className="sessionbar" role="group" aria-label="Session">
      <label className="sessionbar__field">
        <span className="sessionbar__label">Firmware</span>
        <select
          className="sessionbar__select sessionbar__select--wide"
          aria-label="Firmware source folder"
          value={activeFolder ?? ''}
          onChange={(e) => {
            const v = e.target.value
            // A controlled <select> whose value prop does not change (Browse…
            // cancelled, or the same folder re-picked) will not re-render back,
            // so restore the displayed option before handing off.
            e.currentTarget.value = activeFolder ?? ''
            if (v === BROWSE) onBrowse()
            else if (v && v !== activeFolder) onPickRecent(v)
          }}
        >
          {!activeFolder && (
            <option value="" disabled>
              — open firmware —
            </option>
          )}
          {folders.map((dir) => (
            <option key={dir} value={dir} title={dir}>
              {basename(dir)}
            </option>
          ))}
          <option disabled>──────────</option>
          <option value={BROWSE}>Browse…</option>
        </select>
      </label>

      <label className="sessionbar__field">
        <span className="sessionbar__label">Hardware</span>
        <select
          className="sessionbar__select"
          aria-label="Hardware profile"
          value={boardId}
          onChange={(e) => onSelectBoard(e.target.value)}
        >
          {availableBoards.map((id) => (
            <option key={id} value={id}>
              {id === boardId ? boardName : id}
            </option>
          ))}
        </select>
      </label>

      <label className="sessionbar__field">
        <span className="sessionbar__label">Env</span>
        {narrowed && (
          <select
            className="sessionbar__select sessionbar__filter"
            aria-label="Env filter"
            value={showAllEnvs ? 'all' : 'compat'}
            title={
              showAllEnvs
                ? `Showing all ${envs.length} envs`
                : `Showing ${compatible.length} ${boardName}-compatible envs`
            }
            onChange={(e) => {
              const wantAll = e.target.value === 'all'
              if (wantAll !== showAllEnvs) onToggleAllEnvs()
            }}
          >
            <option value="compat">{boardName.split(' ')[0]} only</option>
            <option value="all">All ({envs.length})</option>
          </select>
        )}
        <EnvPicker
          options={visibleEnvs}
          value={env}
          onChange={onSelectEnv}
          disabled={envs.length === 0}
          placeholder={envs.length === 0 ? '— no envs —' : '— env —'}
        />
      </label>
    </div>
  )
}
