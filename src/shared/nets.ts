/**
 * Net presentation helpers shared by the canvas (net polylines + labels) and
 * the Inspector's Nets section, so a net's colour and bus-kind classification
 * come from one place rather than a copy in each component.
 */

import type { BoardDefinition, BusKind } from './board'
import type { BusFilterKind } from './workspace'

/** The CSS custom property a net of the given bus kind is drawn in. */
export function netColour(busId: string | undefined, buses: BoardDefinition['buses']): string {
  const bus = buses.find((candidate) => candidate.id === busId)
  switch (bus?.kind) {
    case 'spi':
      return 'var(--accent-500)'
    case 'i2c':
      return 'var(--accent-2-500)'
    case 'uart':
      return 'var(--status-warn)'
    default:
      return 'var(--neutral-600)'
  }
}

/**
 * Which toolbar filter chip a net belongs to. A net with no bus — a loose GPIO
 * hookup — classifies as `gpio`; `onewire` buses have no chip and stay visible.
 */
export function netFilterKind(
  busId: string | undefined,
  buses: BoardDefinition['buses']
): BusFilterKind | null {
  const kind: BusKind | undefined = buses.find((candidate) => candidate.id === busId)?.kind
  if (kind === 'spi' || kind === 'i2c' || kind === 'uart') return kind
  if (busId === undefined) return 'gpio'
  return null
}
