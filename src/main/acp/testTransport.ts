import type { LineTransport } from './connection'

/**
 * A pair of in-memory {@link LineTransport}s wired to each other — one for the
 * client end, one for a fake agent end. Delivery is async (a microtask) so the
 * two ends interleave the way a real pipe does.
 */
export function transportPair(): { a: LineTransport; b: LineTransport } {
  const dataListeners: { a: ((chunk: string) => void)[]; b: ((chunk: string) => void)[] } = {
    a: [],
    b: []
  }
  const closeListeners: { a: (() => void)[]; b: (() => void)[] } = { a: [], b: [] }
  let open = true

  const make = (self: 'a' | 'b'): LineTransport => {
    const other = self === 'a' ? 'b' : 'a'
    return {
      onData: (listener) => dataListeners[self].push(listener),
      onClose: (listener) => closeListeners[self].push(listener),
      write: (frame) => {
        if (!open) return
        queueMicrotask(() => {
          for (const listener of dataListeners[other]) listener(frame)
        })
      },
      close: () => {
        if (!open) return
        open = false
        queueMicrotask(() => {
          for (const listener of [...closeListeners.a, ...closeListeners.b]) listener()
        })
      }
    }
  }

  return { a: make('a'), b: make('b') }
}
