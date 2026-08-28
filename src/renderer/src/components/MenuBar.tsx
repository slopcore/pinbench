import { useCallback, useEffect, useRef, useState } from 'react'
import { MENUS, formatAccelerator } from '@shared/commands'
import type { CommandId, MenuSpec } from '@shared/commands'
import './menubar.css'

interface MenuBarProps {
  platform: NodeJS.Platform
  onCommand: (command: CommandId) => void
  isChecked: (command: CommandId) => boolean
}

/**
 * The in-window menu bar: click to open, hover to switch between menus while
 * one is open, click outside or press Escape to dismiss.
 */
export function MenuBar({ platform, onCommand, isChecked }: MenuBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpenMenu(null), [])

  useEffect(() => {
    if (!openMenu) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    // Capture, so the dismissal wins over anything the click lands on.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu, close])

  const run = (command: CommandId): void => {
    close()
    onCommand(command)
  }

  return (
    <div className="menubar" ref={barRef} role="menubar" aria-label="Application">
      {MENUS.map((menu: MenuSpec) => {
        const open = openMenu === menu.id
        return (
          <div className="menubar__menu" key={menu.id}>
            <button
              type="button"
              className="menubar__title"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              data-open={open || undefined}
              onClick={() => setOpenMenu(open ? null : menu.id)}
              onPointerEnter={() => {
                if (openMenu !== null) setOpenMenu(menu.id)
              }}
            >
              {menu.label}
            </button>
            {open && (
              <div className="menu" role="menu" aria-label={menu.label}>
                {menu.entries.map((entry, index) => {
                  if (entry.type === 'separator') {
                    return <div className="menu__separator" key={`sep-${index}`} role="separator" />
                  }
                  const checked = entry.checkable === true ? isChecked(entry.command) : undefined
                  return (
                    <button
                      type="button"
                      key={entry.command}
                      className="menu__item"
                      role={entry.checkable === true ? 'menuitemcheckbox' : 'menuitem'}
                      disabled={!entry.enabled}
                      {...(checked === undefined ? {} : { 'aria-checked': checked })}
                      onClick={() => run(entry.command)}
                    >
                      <span className="menu__check" aria-hidden="true">
                        {checked === true ? '✓' : ''}
                      </span>
                      <span className="menu__label">{entry.label}</span>
                      {entry.accelerator !== undefined && (
                        <span className="menu__accelerator">
                          {formatAccelerator(entry.accelerator, platform)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
