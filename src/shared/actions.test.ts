// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectActions,
  projectRelative,
  renderActionsMarkdown,
  type FirmwareActionInputs
} from './actions'
import { parseBoard } from './board'
import { generatePinHeader, pinDefines } from './codegen'

const M9_BOARD = parseBoard(
  JSON.parse(readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8'))
)

const HEADER_PATH = 'include/thinknode-m9-v1.0_pins.h'

function inputs(over: Partial<FirmwareActionInputs> = {}): FirmwareActionInputs {
  return {
    board: M9_BOARD,
    headerPath: HEADER_PATH,
    headerText: generatePinHeader(M9_BOARD),
    headerReferenced: true,
    emulatedNetReferenced: false,
    buildDiagnostics: [],
    projectDir: '/proj',
    ...over
  }
}

describe('collectActions', () => {
  it('is empty when the header matches the canvas and the build is clean', () => {
    expect(collectActions(inputs())).toEqual([])
  })

  it('ignores the header entirely when no firmware source includes it', () => {
    expect(collectActions(inputs({ headerReferenced: false, headerText: null }))).toEqual([])
    expect(
      collectActions(inputs({ headerReferenced: false, headerText: '#define X 1\n' }))
    ).toEqual([])
  })

  it('asks for the whole header when it is included but missing', () => {
    const [action, ...rest] = collectActions(inputs({ headerText: null }))
    expect(rest).toEqual([])
    expect(action).toMatchObject({
      kind: 'pin-header-missing',
      severity: 'error',
      file: HEADER_PATH
    })
    expect(action!.fix).toContain(generatePinHeader(M9_BOARD))
  })

  it('reports a changed value with expected and actual', () => {
    const first = pinDefines(M9_BOARD)[0]!
    const drifted = generatePinHeader(M9_BOARD).replace(
      new RegExp(`(#define ${first.name}\\s+)\\d+`),
      `$1${first.value + 1}`
    )
    expect(collectActions(inputs({ headerText: drifted }))).toEqual([
      expect.objectContaining({
        id: `pin-header-drift:${first.name}`,
        kind: 'pin-header-drift',
        symbol: first.name,
        expected: String(first.value),
        actual: String(first.value + 1)
      })
    ])
  })

  it('reports a missing define and a stale extra one', () => {
    const first = pinDefines(M9_BOARD)[0]!
    const text = generatePinHeader(M9_BOARD)
      .split('\n')
      .filter((line) => !new RegExp(`^#define ${first.name}\\s`).test(line))
      .concat('#define OLD_THING 7')
      .join('\n')
    const actions = collectActions(inputs({ headerText: text }))
    expect(actions.map((a) => [a.symbol, a.expected, a.actual])).toEqual([
      [first.name, String(first.value), undefined],
      ['OLD_THING', undefined, '7']
    ])
  })

  it('wants the emulated-network hook only for a networked profile without it', () => {
    const networked = { ...M9_BOARD, emulator: { ...M9_BOARD.emulator, network: 'user' as const } }
    expect(collectActions(inputs({ board: networked })).map((a) => a.kind)).toEqual([
      'emulated-net-missing'
    ])
    expect(collectActions(inputs({ board: networked, emulatedNetReferenced: true }))).toEqual([])
    expect(collectActions(inputs())).toEqual([])
  })

  it('turns build errors into project-relative actions, errors first', () => {
    const networked = { ...M9_BOARD, emulator: { ...M9_BOARD.emulator, network: 'user' as const } }
    const actions = collectActions(
      inputs({
        board: networked,
        buildDiagnostics: [
          { id: 'w', severity: 'warn', message: 'unused', file: '/proj/src/a.cpp', line: 3 },
          {
            id: 'e',
            severity: 'error',
            message: "'x' was not declared",
            file: '/proj/src/main.cpp',
            line: 12,
            column: 5
          }
        ]
      })
    )
    expect(actions.map((a) => a.kind)).toEqual(['build-error', 'emulated-net-missing'])
    expect(actions[0]).toMatchObject({ file: 'src/main.cpp', line: 12, column: 5 })
  })
})

describe('collectActions — build errors', () => {
  it('collapses the same error reported by several translation units', () => {
    const row = {
      severity: 'error' as const,
      message: "'X' was not declared",
      file: '/proj/include/a.h',
      line: 4
    }
    const actions = collectActions(
      inputs({
        buildDiagnostics: [
          { id: 'diag-0-4', ...row },
          { id: 'diag-0-4', ...row, column: 2 },
          { id: 'diag-1-4', ...row }
        ]
      })
    )
    expect(actions).toHaveLength(1)
  })
})

describe('projectRelative', () => {
  it('strips the root, leaves outside paths alone, and normalises separators', () => {
    expect(projectRelative('/proj', '/proj/src/a.c')).toBe('src/a.c')
    expect(projectRelative('/proj/', '/proj/src/a.c')).toBe('src/a.c')
    expect(projectRelative('/proj', '/usr/include/x.h')).toBe('/usr/include/x.h')
    expect(projectRelative('C:\\proj', 'C:\\proj\\src\\a.c')).toBe('src/a.c')
  })
})

describe('renderActionsMarkdown', () => {
  it('numbers each action and fences a multi-line fix as C', () => {
    const actions = collectActions(inputs({ headerText: null }))
    const md = renderActionsMarkdown(actions, { boardName: 'ThinkNode M9', env: 'm9' })
    expect(md).toContain('Hardware profile: ThinkNode M9 · env `m9`')
    expect(md).toContain(`## 1. [error] pin-header-missing — \`${HEADER_PATH}\``)
    expect(md).toContain('```c\n/* PinBench-generated pin map')
    expect(md).toContain('firmware_actions')
  })
})
