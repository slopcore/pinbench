/**
 * PinBench's agent-facing control surface (roadmap M16.1) — the catalogue of
 * everything a coding agent may do to the workbench, as pure descriptors.
 *
 * The scope boundary is deliberate and writable-down: this is the
 * {@link PinBenchApi} surface from `shared/ipc.ts` plus the {@link BoardEdit}
 * transforms from `shared/boardEdit.ts`, and nothing else. "Full control"
 * means "everything the app's own UI can drive", not "arbitrary code".
 *
 * One list, three consumers:
 *  - the MCP server's `tools/list` ({@link ./mcp}) — each op becomes a tool;
 *  - the permission gate — {@link classifyRisk} decides what needs a prompt;
 *  - the docs page — `docs/` renders the table from `OPERATIONS`.
 *
 * Descriptors only: the code that performs an operation is bound in the main
 * process (M16.2), which is the sole place QEMU and `pio` can be reached.
 */

import { RpcError } from './jsonrpc'

/**
 * How dangerous an operation is, and therefore whether it needs a permission
 * prompt before the agent may run it:
 *  - `read`  — observes state, no side effects. Auto-approved.
 *  - `write` — mutates the in-memory board document. Reversible via
 *    `board_undo`; auto-approved by the default policy.
 *  - `exec`  — spawns a child process (`pio`, QEMU), touches the filesystem,
 *    or drives the emulated hardware. Always prompts under the default policy.
 */
export type OperationRisk = 'read' | 'write' | 'exec'

export type FieldType = 'string' | 'number' | 'boolean' | 'object'

export interface FieldSpec {
  name: string
  type: FieldType
  required: boolean
  description: string
  /** Allowed string values, when the field is a closed set. */
  enum?: readonly string[]
}

export interface OperationDescriptor {
  /** Tool name the agent calls — snake_case, stable, unique. */
  name: string
  /** Short imperative title for a permission prompt. */
  title: string
  summary: string
  risk: OperationRisk
  params: readonly FieldSpec[]
}

const NO_PARAMS: readonly FieldSpec[] = []

export const OPERATIONS: readonly OperationDescriptor[] = [
  // ── Observe ────────────────────────────────────────────────────────────────
  {
    name: 'app_info',
    title: 'Read app info',
    summary: 'Version, platform and dev-mode flag of the running PinBench.',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'board_get',
    title: 'Read the board',
    summary: 'The current board definition — pins, buses, parts, nets, layout.',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'board_verify',
    title: 'Verify the pin map',
    summary: 'Run the pin-map rule engine and return the findings (⌘B).',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'pinmap_preview',
    title: 'Preview the pin header',
    summary: 'The C pin-map header and build flags codegen would emit — not written.',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'project_tree',
    title: 'List project files',
    summary: 'Immediate children of a directory in the open PlatformIO project.',
    risk: 'read',
    params: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Absolute directory inside the project; omit for the root.'
      }
    ]
  },
  {
    name: 'project_read_file',
    title: 'Read a project file',
    summary: 'Text of a file inside the open PlatformIO project.',
    risk: 'read',
    params: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Absolute path inside the project.'
      }
    ]
  },
  {
    name: 'build_status',
    title: 'Read build status',
    summary: 'Current build phase and last result.',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'emulator_status',
    title: 'Read emulator status',
    summary: 'Whether the emulator is stopped, starting, running or stopping.',
    risk: 'read',
    params: NO_PARAMS
  },
  {
    name: 'serial_read',
    title: 'Read the serial console',
    summary: 'The most recent lines from the emulated board’s UART0.',
    risk: 'read',
    params: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max lines to return, newest last (default 200).'
      }
    ]
  },
  {
    name: 'device_snapshots',
    title: 'Read device state',
    summary: 'Observable state of every active device model (radio, display, …).',
    risk: 'read',
    params: NO_PARAMS
  },

  // ── Edit the board document ────────────────────────────────────────────────
  {
    name: 'board_edit',
    title: 'Edit the board',
    summary:
      'Apply one board edit: moveParty, resizeParty, rebindPin, addPart, deletePart, addNet, deleteNet.',
    risk: 'write',
    params: [
      {
        name: 'edit',
        type: 'object',
        required: true,
        description: 'A BoardEdit object with a `kind` discriminant and its fields.'
      }
    ]
  },
  {
    name: 'board_undo',
    title: 'Undo a board edit',
    summary: 'Step the board-edit history back one entry.',
    risk: 'write',
    params: NO_PARAMS
  },
  {
    name: 'board_redo',
    title: 'Redo a board edit',
    summary: 'Step the board-edit history forward one entry.',
    risk: 'write',
    params: NO_PARAMS
  },

  // ── Act: filesystem, child processes, emulated hardware ────────────────────
  {
    name: 'project_open',
    title: 'Open a PlatformIO project',
    summary: 'Adopt the PlatformIO project rooted at a directory (must hold platformio.ini).',
    risk: 'exec',
    params: [
      {
        name: 'dir',
        type: 'string',
        required: true,
        description: 'Absolute project root directory.'
      }
    ]
  },
  {
    name: 'pinmap_write',
    title: 'Write the pin header',
    summary: 'Generate the pin-map header and write it into the project, round-trip guarded.',
    risk: 'exec',
    params: NO_PARAMS
  },
  {
    name: 'build_start',
    title: 'Build & flash',
    summary: 'Run PlatformIO for an environment and boot the result in the emulator.',
    risk: 'exec',
    params: [
      { name: 'env', type: 'string', required: true, description: 'PlatformIO environment name.' }
    ]
  },
  {
    name: 'build_cancel',
    title: 'Cancel the build',
    summary: 'Stop a running PlatformIO build.',
    risk: 'exec',
    params: NO_PARAMS
  },
  {
    name: 'build_clean',
    title: 'Clean the build cache',
    summary: 'Delete .pio/build and PinBench’s merge cache for the open project.',
    risk: 'exec',
    params: NO_PARAMS
  },
  {
    name: 'emulator_start',
    title: 'Start the emulator',
    summary: 'Boot a firmware image under emulation.',
    risk: 'exec',
    params: [
      {
        name: 'firmwarePath',
        type: 'string',
        required: false,
        description: 'Absolute .bin path; omit to reuse the last-built image.'
      }
    ]
  },
  {
    name: 'emulator_stop',
    title: 'Stop the emulator',
    summary: 'Halt the running emulator.',
    risk: 'exec',
    params: NO_PARAMS
  },
  {
    name: 'emulator_reset',
    title: 'Reset the emulator',
    summary: 'Reboot the running emulator.',
    risk: 'exec',
    params: NO_PARAMS
  },
  {
    name: 'serial_write',
    title: 'Write to the serial console',
    summary: 'Send text to the emulated board’s UART0.',
    risk: 'exec',
    params: [{ name: 'text', type: 'string', required: true, description: 'Bytes to write.' }]
  },
  {
    name: 'device_command',
    title: 'Drive a device model',
    summary: 'Send an IN-panel command to a device model (inject, setParam, signal, …).',
    risk: 'exec',
    params: [
      { name: 'partId', type: 'string', required: true, description: 'Board part id, e.g. `u2`.' },
      {
        name: 'command',
        type: 'string',
        required: true,
        description: 'Command name the model accepts.'
      },
      { name: 'args', type: 'object', required: false, description: 'Command arguments.' }
    ]
  },
  {
    name: 'menu_command',
    title: 'Invoke a menu command',
    summary: 'Fire any command from the application menu table by id.',
    risk: 'exec',
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description: 'A CommandId, e.g. `build.verifyPinMap`.'
      }
    ]
  }
] as const

const BY_NAME: ReadonlyMap<string, OperationDescriptor> = new Map(
  OPERATIONS.map((op) => [op.name, op])
)

export function operation(name: string): OperationDescriptor | undefined {
  return BY_NAME.get(name)
}

export function classifyRisk(name: string): OperationRisk | undefined {
  return BY_NAME.get(name)?.risk
}

export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionPolicy = (op: OperationDescriptor) => PermissionDecision

/**
 * The default gate: observation and reversible board edits go through; anything
 * that spawns a process, writes a file or moves the emulated hardware asks
 * first. A host can pass its own policy (e.g. "ask for everything" while
 * unattended, or "allow all" in a trusted CI run).
 */
export const defaultPermissionPolicy: PermissionPolicy = (op) =>
  op.risk === 'exec' ? 'ask' : 'allow'

/** JSON Schema for an operation's params, for MCP `tools/list`. */
export function inputSchema(op: OperationDescriptor): {
  type: 'object'
  properties: Record<string, { type: string; description: string; enum?: readonly string[] }>
  required?: string[]
  additionalProperties: false
} {
  const properties: Record<
    string,
    { type: string; description: string; enum?: readonly string[] }
  > = {}
  const required: string[] = []
  for (const field of op.params) {
    properties[field.name] = field.enum
      ? { type: field.type, description: field.description, enum: field.enum }
      : { type: field.type, description: field.description }
    if (field.required) required.push(field.name)
  }
  return required.length > 0
    ? { type: 'object', properties, required, additionalProperties: false }
    : { type: 'object', properties, additionalProperties: false }
}

/**
 * Validate and narrow an operation's raw params. Throws
 * {@link RpcError.invalidParams} on a missing required field or a wrong type;
 * unknown keys are dropped rather than rejected, so a newer agent talking to
 * an older PinBench degrades instead of failing.
 */
export function parseParams(op: OperationDescriptor, raw: unknown): Record<string, unknown> {
  const source: Record<string, unknown> =
    raw === undefined || raw === null
      ? {}
      : typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : (() => {
            throw RpcError.invalidParams(`${op.name} expects an object`)
          })()

  const out: Record<string, unknown> = {}
  for (const field of op.params) {
    const value = source[field.name]
    if (value === undefined) {
      if (field.required) throw RpcError.invalidParams(`${op.name} requires "${field.name}"`)
      continue
    }
    if (!matchesType(value, field.type)) {
      throw RpcError.invalidParams(`${op.name}.${field.name} must be a ${field.type}`)
    }
    if (field.enum && !field.enum.includes(value as string)) {
      throw RpcError.invalidParams(
        `${op.name}.${field.name} must be one of ${field.enum.join(', ')}`
      )
    }
    out[field.name] = value
  }
  return out
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
