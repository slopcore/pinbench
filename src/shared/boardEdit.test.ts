// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardDefinition, type PartDefinition } from './board'
import { applyEdit, BoardEditError, BoardHistory } from './boardEdit'
import { generatePinHeader } from './codegen'
import { verifyBoard } from './verify'

function m9(): BoardDefinition {
  return parseBoard(
    JSON.parse(
      readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
    )
  )
}

const stubPart: PartDefinition = {
  id: 'x1',
  designator: 'X1',
  name: 'Extra LED',
  category: 'interface',
  deviceModel: 'pinbench.led',
  summary: '',
  buses: [],
  pins: [{ signal: 'ANODE', pin: 'GPIO2' }],
  config: [],
  layout: { x: 0, y: 0, width: 10, height: 10 }
}

describe('applyEdit', () => {
  it('moveParty updates only the layout and does not mutate the input', () => {
    const before = m9()
    const after = applyEdit(before, { kind: 'moveParty', partId: 'u3', x: 111, y: 222 })
    expect(after.parts.find((p) => p.id === 'u3')!.layout).toMatchObject({ x: 111, y: 222 })
    expect(before.parts.find((p) => p.id === 'u3')!.layout.x).not.toBe(111)
  })

  it('rebindPin moves a signal and feeds through codegen and verify', () => {
    const moved = applyEdit(m9(), { kind: 'rebindPin', partId: 'u3', signal: 'CS', pin: 'GPIO21' })
    expect(generatePinHeader(moved)).toMatch(/#define U3_CS_PIN\s+21/)
    // GPIO21 already carries the keyboard's SCL — verify catches it.
    expect(verifyBoard(moved).some((f) => f.severity === 'warn' && f.ref?.id === 'GPIO21')).toBe(
      true
    )
  })

  it('rebindPin rejects an unknown pin or signal', () => {
    expect(() =>
      applyEdit(m9(), { kind: 'rebindPin', partId: 'u3', signal: 'CS', pin: 'GPIO99' })
    ).toThrow(BoardEditError)
    expect(() =>
      applyEdit(m9(), { kind: 'rebindPin', partId: 'u3', signal: 'NOPE', pin: 'GPIO21' })
    ).toThrow(/no signal/)
  })

  it('addPart / deletePart round-trip; delete also prunes net endpoints', () => {
    const added = applyEdit(m9(), { kind: 'addPart', part: stubPart })
    expect(added.parts).toHaveLength(m9().parts.length + 1)
    expect(() => applyEdit(added, { kind: 'addPart', part: stubPart })).toThrow(/already exists/)

    const removed = applyEdit(m9(), { kind: 'deletePart', partId: 'u3' })
    expect(removed.parts.some((p) => p.id === 'u3')).toBe(false)
    // net-lcd-cs was ["GPIO16", "u3:CS"] → now one node → dropped.
    expect(removed.nets.some((n) => n.id === 'net-lcd-cs')).toBe(false)
    // net-sck keeps its other members.
    expect(removed.nets.find((n) => n.id === 'net-sck')!.nodes).not.toContain('u3:SCK')
  })

  it('deleteNet removes exactly one net', () => {
    const after = applyEdit(m9(), { kind: 'deleteNet', netId: 'net-vdd-periph' })
    expect(after.nets).toHaveLength(m9().nets.length - 1)
    expect(() => applyEdit(after, { kind: 'deleteNet', netId: 'net-vdd-periph' })).toThrow(/no net/)
  })
})

describe('BoardHistory', () => {
  it('apply / undo / redo walk the stack', () => {
    const h = new BoardHistory(m9())
    expect(h.canUndo).toBe(false)

    h.apply({ kind: 'moveParty', partId: 'u3', x: 10, y: 10 })
    h.apply({ kind: 'moveParty', partId: 'u3', x: 20, y: 20 })
    expect(h.present.parts.find((p) => p.id === 'u3')!.layout.x).toBe(20)
    expect(h.canUndo).toBe(true)
    expect(h.canRedo).toBe(false)

    h.undo()
    expect(h.present.parts.find((p) => p.id === 'u3')!.layout.x).toBe(10)
    expect(h.canRedo).toBe(true)

    h.redo()
    expect(h.present.parts.find((p) => p.id === 'u3')!.layout.x).toBe(20)

    // A new edit after undo clears the redo branch.
    h.undo()
    h.apply({ kind: 'moveParty', partId: 'u3', x: 99, y: 99 })
    expect(h.canRedo).toBe(false)
    expect(h.present.parts.find((p) => p.id === 'u3')!.layout.x).toBe(99)
  })

  it('a failed edit leaves the history untouched', () => {
    const h = new BoardHistory(m9())
    h.apply({ kind: 'moveParty', partId: 'u3', x: 1, y: 1 })
    expect(() =>
      h.apply({ kind: 'rebindPin', partId: 'u3', signal: 'CS', pin: 'GPIOZZZ' })
    ).toThrow()
    expect(h.present.parts.find((p) => p.id === 'u3')!.layout.x).toBe(1)
    expect(h.canRedo).toBe(false)
  })

  it('undo / redo past the ends are no-ops', () => {
    const h = new BoardHistory(m9())
    expect(h.undo()).toBe(h.present)
    expect(h.redo()).toBe(h.present)
  })
})
