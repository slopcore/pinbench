#!/usr/bin/env node
/**
 * Fast preflight: checks that the emulator toolchain is available.
 * Warns and continues — never blocks `npm run dev`, since the app
 * already surfaces a missing emulator as a diagnostic.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const QEMU_DIR = join(ROOT, '.qemu')
const QEMU_BIN = join(QEMU_DIR, 'build', 'qemu-system-xtensa')
const ENV_OVERRIDE = process.env.PINBENCH_QEMU

const warn = (msg) => console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`)

// A previous `npm run dev` that didn't exit cleanly (window force-quit, or the
// terminal killed while Electron lived on) leaves its Vite dev server holding
// the renderer port. With `strictPort` the next `npm run dev` would now fail
// outright; without it electron-vite silently moves to the next port while the
// stale Electron window still points at the old one, so edits look dead and
// "just restart dev" doesn't help. Reap the squatter here so dev always starts
// clean. Must match `server.port` in electron.vite.config.ts.
const DEV_PORT = 5173
if (process.platform !== 'win32') {
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${DEV_PORT}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM')
        ok(`freed stale dev server on port ${DEV_PORT} (pid ${pid})`)
      } catch {
        // already gone
      }
    }
  } catch {
    // lsof exits non-zero when nothing is listening — the common, healthy case.
  }
}

let qemu = null

// 1. Check PINBENCH_QEMU env override first
if (ENV_OVERRIDE) {
  if (existsSync(ENV_OVERRIDE)) {
    qemu = ENV_OVERRIDE
  } else {
    warn(`PINBENCH_QEMU points to ${ENV_OVERRIDE} which does not exist`)
  }
}

// 2. Check repo-local .qemu/build/
if (!qemu && existsSync(QEMU_BIN)) {
  qemu = QEMU_BIN
}

// 3. Check PATH
if (!qemu) {
  try {
    const which = execFileSync('which', ['qemu-system-xtensa'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    if (which) qemu = which
  } catch {
    // not on PATH
  }
}

if (!qemu) {
  warn('qemu-system-xtensa not found')
  warn('Run: npm run setup:emulator')
  warn('The app will start but cannot boot firmware without it.')
  process.exit(0)
}

// Verify esp32s3 machine support
try {
  const machines = execFileSync(qemu, ['-machine', 'help'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000
  })
  if (!machines.includes('esp32s3')) {
    warn(`${qemu} does not support -machine esp32s3`)
    warn('You may have a stock QEMU, not the espressif fork.')
    warn('Run: npm run setup:emulator')
    process.exit(0)
  }
} catch (err) {
  warn(`Could not query ${qemu}: ${err.message}`)
  process.exit(0)
}

ok(`QEMU esp32s3: ${qemu}`)

// RISC-V boards (the Waveshare ESP32-C6) run on qemu-system-riscv32. Only a
// warning: S3-only work never needs it.
const QEMU_RV_BIN =
  process.env.PINBENCH_QEMU_RISCV32 || join(QEMU_DIR, 'build', 'qemu-system-riscv32')
try {
  const machines = execFileSync(QEMU_RV_BIN, ['-machine', 'help'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (machines.includes('esp32c6')) ok(`QEMU esp32c6: ${QEMU_RV_BIN}`)
  else warn(`${QEMU_RV_BIN} does not support -machine esp32c6 — run: npm run setup:emulator`)
} catch {
  warn('qemu-system-riscv32 not found — ESP32-C6 boards will not boot. Run: npm run setup:emulator')
}

// The `qemu/` overlay (patch set + apply.sh) is versioned; the built binary in
// `.qemu/` is not. If a fork file has changed since the last `apply.sh` run
// (its `.qemu/.pinbench-applied` marker), the running binary is stale. Only
// meaningful for the repo-local build — a PATH / env QEMU is the user's own.
if (qemu === QEMU_BIN) {
  const OVERLAY = join(ROOT, 'qemu')
  const marker = join(QEMU_DIR, '.pinbench-applied')
  const newestMtime = (dir) => {
    let newest = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const m = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs
      if (m > newest) newest = m
    }
    return newest
  }
  try {
    const appliedAt = existsSync(marker) ? statSync(marker).mtimeMs : 0
    if (newestMtime(OVERLAY) > appliedAt) {
      warn('qemu/ patch set changed since the emulator was last built — binary is stale')
      warn('Run: npm run setup:emulator   (re-applies qemu/apply.sh and rebuilds, incrementally)')
    }
  } catch {
    // Missing overlay or unreadable marker — nothing actionable to say.
  }
}

// Check for PlatformIO (needed for M3 firmware builds). Mirror the app's
// resolution order: PINBENCH_PIO env → repo-local .pio-venv → PATH.
const REPO_PIO = join(
  ROOT,
  '.pio-venv',
  'bin',
  process.platform === 'win32' ? 'platformio.exe' : 'pio'
)
let pio = 'pio'
if (process.env.PINBENCH_PIO && existsSync(process.env.PINBENCH_PIO)) pio = process.env.PINBENCH_PIO
else if (existsSync(REPO_PIO)) pio = REPO_PIO

try {
  const pioVersion = execFileSync(pio, ['--version'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000
  }).trim()
  ok(`PlatformIO: ${pioVersion} (${pio})`)
} catch {
  warn('PlatformIO not found — needed for Build & flash (M3)')
  warn('Install it, or run: python3 -m venv .pio-venv && .pio-venv/bin/pip install platformio')
}
