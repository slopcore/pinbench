import { useEffect, useMemo, useRef, useState } from 'react'
import './env-picker.css'

interface EnvPickerProps {
  /** Options to choose from (already narrowed by the compat filter). */
  options: string[]
  value: string | null
  onChange: (env: string) => void
  disabled?: boolean
  /** Trigger text when nothing is selected. */
  placeholder?: string
  /** Accessible name for the trigger and listbox. */
  label?: string
}

/**
 * A select-shaped combobox: click the trigger to drop a popup whose first row is
 * a text box that filters the options below it. Arrow keys move the highlight,
 * Enter picks it, Escape or an outside click dismisses.
 */
export function EnvPicker({
  options,
  value,
  onChange,
  disabled = false,
  placeholder = '— env —',
  label = 'Build environment'
}: EnvPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  }, [options, query])

  // Highlight, clamped to whatever the filtered list currently holds.
  const activeIndex = Math.min(Math.max(active, 0), Math.max(filtered.length - 1, 0))

  // Move focus into the filter box on open; dismiss on an outside click.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const openPopup = (): void => {
    setQuery('')
    const idx = value ? options.indexOf(value) : -1
    setActive(idx < 0 ? 0 : idx)
    setOpen(true)
  }

  const choose = (env: string): void => {
    onChange(env)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(Math.min(activeIndex + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = filtered[activeIndex]
      if (pick) choose(pick)
    }
  }

  return (
    <div className="envpicker" ref={rootRef}>
      <button
        type="button"
        className="sessionbar__select sessionbar__select--mono envpicker__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ?? undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPopup())}
      >
        {value ?? placeholder}
      </button>
      {open && (
        <div className="envpicker__pop">
          <input
            ref={inputRef}
            type="search"
            className="envpicker__search"
            placeholder="filter…"
            aria-label="Filter environments"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul className="envpicker__list" role="listbox" aria-label={label}>
            {filtered.length === 0 && <li className="envpicker__empty">no match</li>}
            {filtered.map((name, i) => (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={name === value}
                  className="envpicker__option"
                  data-active={i === activeIndex || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
