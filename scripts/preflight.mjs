#!/usr/bin/env node
/**
 * Fast preflight: checks that the emulator toolchain is available.
 * Warns and continues — never blocks `npm run dev`, since the app
 * already surfaces a missing emulator as a diagnostic.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const QEMU_DIR = join(ROOT, '.qemu')
const QEMU_BIN = join(QEMU_DIR, 'build', 'qemu-system-xtensa')
const ENV_OVERRIDE = process.env.PINBENCH_QEMU

const warn = (msg) => console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`)

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

// Check for PlatformIO (needed for firmware builds)
try {
  const pioVersion = execFileSync('pio', ['--version'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000
  }).trim()
  ok(`PlatformIO: ${pioVersion}`)
} catch {
  warn('PlatformIO (pio) not found — needed for firmware builds')
  warn('Install: pip3 install platformio')
}
