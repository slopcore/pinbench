import { useMemo, useState } from 'react'
import { CATEGORY_LABELS, partsByCategory } from '@shared/board'
import type { BoardDefinition, PartCategory } from '@shared/board'
import './panels.css'

interface LibraryPanelProps {
  board: BoardDefinition
  selectedPartId: string | null
  onSelectPart: (partId: string) => void
}

const CATEGORY_ORDER: PartCategory[] = [
  'mcu',
  'radio',
  'display',
  'storage',
  'sensor',
  'input',
  'interface',
  'power'
]

export function LibraryPanel({
  board,
  selectedPartId,
  onSelectPart
}: LibraryPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching =
      needle === ''
        ? board
        : {
            ...board,
            parts: board.parts.filter((part) =>
              `${part.designator} ${part.name} ${part.mpn ?? ''}`.toLowerCase().includes(needle)
            )
          }
    return partsByCategory(matching)
  }, [board, query])

  const matches = [...grouped.values()].reduce((total, parts) => total + parts.length, 0)

  return (
    <aside className="panel panel--library" aria-label="Library">
      <div className="panel__header">
        <h2 className="panel__title">Library</h2>
        <span className="panel__count">{board.parts.length}</span>
      </div>
      <div className="panel__search">
        <input
          type="search"
          className="panel__search-input"
          placeholder="Filter parts"
          aria-label="Filter parts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="panel__body">
        {matches === 0 && <p className="panel__empty">No part matches “{query}”.</p>}
        {CATEGORY_ORDER.map((category) => {
          const parts = grouped.get(category)
          if (!parts || parts.length === 0) return null
          return (
            <section className="library__group" key={category}>
              <h3 className="library__group-title">{CATEGORY_LABELS[category]}</h3>
              <ul className="library__list">
                {parts.map((part) => (
                  <li key={part.id}>
                    <button
                      type="button"
                      className="library__item"
                      data-selected={selectedPartId === part.id || undefined}
                      onClick={() => onSelectPart(part.id)}
                    >
                      <span className="library__designator">{part.designator}</span>
                      <span className="library__name">{part.name}</span>
                      {part.buses[0] !== undefined && (
                        <span className="library__bus">{part.buses[0].toUpperCase()}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </aside>
  )
}
