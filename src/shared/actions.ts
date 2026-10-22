/**
 * Required firmware actions — the feedback channel to the external IDE.
 *
 * PinBench configures and simulates hardware; it never edits firmware source.
 * When the hardware it is simulating needs something from the code (a pin
 * header that matches the canvas, the emulated-network hook, a build that
 * compiles), it says so here. The main process mirrors the list to the
 * `firmware_actions` MCP tool and to `.pinbench/actions.md` in the project, so
 * a coding agent in the IDE can read it, make the change, rebuild, and re-read
 * until the list is empty.
 *
 * Pure, no Electron/DOM (the M4 harness pattern): the main process gathers the
 * file-system facts and passes them in.
 */

import type { BoardDefinition } from './board'
import { generatePinHeader, parsePinHeader, pinDefines } from './codegen'
import type { Diagnostic } from './diagnostics'

export type FirmwareActionKind =
  'pin-header-missing' | 'pin-header-drift' | 'emulated-net-missing' | 'build-error'

export interface FirmwareAction {
  /** Stable across recomputes while the underlying problem is unchanged. */
  id: string
  kind: FirmwareActionKind
  severity: 'error' | 'warn'
  /** One line: what is wrong. */
  message: string
  /** Project-relative path, when the action is about one file. */
  file?: string
  line?: number
  column?: number
  /** The C symbol concerned, e.g. `LR1110_NSS_PIN`. */
  symbol?: string
  expected?: string
  actual?: string
  /** What to do — plain prose or the exact text to put in the file. */
  fix: string
}

export interface FirmwareActionInputs {
  /** The board as the canvas has it, session edits folded in. */
  board: BoardDefinition
  /** Project-relative path of the generated pin header, e.g. `include/<id>_pins.h`. */
  headerPath: string
  /** The header's text on disk, or null when it does not exist. */
  headerText: string | null
  /** True when some firmware source mentions the header's file name. */
  headerReferenced: boolean
  /** True when some firmware source mentions `PINBENCH_EMULATED_NET`. */
  emulatedNetReferenced: boolean
  /** Rows from the last build, with absolute `file` paths. */
  buildDiagnostics: Diagnostic[]
  /** Absolute project root, to make build-diagnostic paths project-relative. */
  projectDir: string
}

/** Project-relative form of `file` when it lives under `root`, else unchanged. */
export function projectRelative(root: string, file: string): string {
  const norm = (p: string): string => p.split('\\').join('/')
  const base = norm(root).replace(/\/+$/, '') + '/'
  const target = norm(file)
  return target.startsWith(base) ? target.slice(base.length) : target
}

function pinHeaderActions(inputs: FirmwareActionInputs): FirmwareAction[] {
  // A header nobody includes is inert; drift in it changes nothing on the
  // device, so it is not worth an agent's turn.
  if (!inputs.headerReferenced) return []
  const file = inputs.headerPath
  if (inputs.headerText === null) {
    return [
      {
        id: `pin-header-missing:${file}`,
        kind: 'pin-header-missing',
        severity: 'error',
        message: `${file} is included by the firmware but does not exist`,
        file,
        fix: `Create ${file} with exactly this content (it is PinBench's canvas pin map):\n\n${generatePinHeader(inputs.board)}`
      }
    ]
  }

  const onDisk = new Map(parsePinHeader(inputs.headerText).map((d) => [d.name, d.value]))
  const expected = pinDefines(inputs.board)
  const expectedNames = new Set(expected.map((d) => d.name))
  const out: FirmwareAction[] = []
  for (const define of expected) {
    const actual = onDisk.get(define.name)
    if (actual === define.value) continue
    out.push({
      id: `pin-header-drift:${define.name}`,
      kind: 'pin-header-drift',
      severity: 'warn',
      message:
        actual === undefined
          ? `${define.name} is missing from ${file} (canvas: ${define.value}, ${define.origin})`
          : `${define.name} is ${actual} in ${file} but ${define.value} on the canvas (${define.origin})`,
      file,
      symbol: define.name,
      expected: String(define.value),
      ...(actual === undefined ? {} : { actual: String(actual) }),
      fix: `In ${file}, set \`#define ${define.name} ${define.value}\`.`
    })
  }
  for (const [name, value] of onDisk) {
    if (expectedNames.has(name)) continue
    out.push({
      id: `pin-header-drift:${name}`,
      kind: 'pin-header-drift',
      severity: 'warn',
      message: `${name} (${value}) is in ${file} but not on the canvas`,
      file,
      symbol: name,
      actual: String(value),
      fix: `Remove \`#define ${name}\` from ${file}, or add the pin to the hardware profile in PinBench.`
    })
  }
  return out
}

function emulatedNetActions(inputs: FirmwareActionInputs): FirmwareAction[] {
  if (inputs.board.emulator.network !== 'user' || inputs.emulatedNetReferenced) return []
  return [
    {
      id: 'emulated-net-missing',
      kind: 'emulated-net-missing',
      severity: 'warn',
      message:
        'This hardware profile gives the emulator a network, but no firmware source handles PINBENCH_EMULATED_NET',
      symbol: 'PINBENCH_EMULATED_NET',
      fix:
        'Under `#ifdef PINBENCH_EMULATED_NET`, bring up the emulated OpenCores Ethernet NIC in place of WiFi: ' +
        'start lwIP (`tcpipInit()` in setup), add the netif with a static slirp address ' +
        '(10.0.2.15/24, gateway 10.0.2.2, DNS 10.0.2.3) and make it the default route. ' +
        'PinBench defines the flag on emulator builds only. See docs/features/emulated-network.md.'
    }
  ]
}

function buildErrorActions(inputs: FirmwareActionInputs): FirmwareAction[] {
  const seen = new Set<string>()
  return inputs.buildDiagnostics
    .filter((row) => row.severity === 'error')
    .map((row) => {
      const file = row.file === undefined ? undefined : projectRelative(inputs.projectDir, row.file)
      const where =
        file === undefined ? '' : `${file}${row.line === undefined ? '' : `:${row.line}`}`
      return {
        id: `build-error:${where}:${row.message}`,
        kind: 'build-error' as const,
        severity: 'error' as const,
        message: row.message,
        ...(file === undefined ? {} : { file }),
        ...(row.line === undefined ? {} : { line: row.line }),
        ...(row.column === undefined ? {} : { column: row.column }),
        fix: where === '' ? 'Fix the build error.' : `Fix the compile error at ${where}.`
      }
    })
    .filter((action) => {
      // A header error repeats once per translation unit, and the build emits
      // diagnostics in batches — one action per distinct error.
      if (seen.has(action.id)) return false
      seen.add(action.id)
      return true
    })
}

/** Every action the firmware currently owes the hardware profile, errors first. */
export function collectActions(inputs: FirmwareActionInputs): FirmwareAction[] {
  const all = [
    ...buildErrorActions(inputs),
    ...pinHeaderActions(inputs),
    ...emulatedNetActions(inputs)
  ]
  return [...all.filter((a) => a.severity === 'error'), ...all.filter((a) => a.severity === 'warn')]
}

/** The `.pinbench/actions.md` body: readable by a human, unambiguous for an agent. */
export function renderActionsMarkdown(
  actions: FirmwareAction[],
  context: { boardName: string; env: string | null }
): string {
  const lines = [
    '# PinBench — required firmware changes',
    '',
    `Hardware profile: ${context.boardName}${context.env ? ` · env \`${context.env}\`` : ''}`,
    '',
    'PinBench simulates the hardware and never edits this project. Each item below is a',
    'change the firmware needs to match it. Make the changes, rebuild in PinBench, and',
    'this file is rewritten (and removed when nothing is left). The same list is served',
    'by the `firmware_actions` MCP tool.',
    ''
  ]
  actions.forEach((action, index) => {
    const where =
      action.file === undefined
        ? ''
        : ` — \`${action.file}${action.line === undefined ? '' : `:${action.line}`}\``
    lines.push(`## ${index + 1}. [${action.severity}] ${action.kind}${where}`, '')
    lines.push(action.message, '')
    if (action.symbol !== undefined) lines.push(`- symbol: \`${action.symbol}\``)
    if (action.expected !== undefined) lines.push(`- expected: \`${action.expected}\``)
    if (action.actual !== undefined) lines.push(`- actual: \`${action.actual}\``)
    if (action.symbol !== undefined || action.expected !== undefined || action.actual !== undefined)
      lines.push('')
    if (action.fix.includes('\n')) {
      const [lead, ...rest] = action.fix.split('\n\n')
      lines.push(`**Fix:** ${lead}`, '', '```c', rest.join('\n\n').trimEnd(), '```', '')
    } else {
      lines.push(`**Fix:** ${action.fix}`, '')
    }
  })
  return lines.join('\n')
}
