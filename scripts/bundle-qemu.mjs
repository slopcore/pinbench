#!/usr/bin/env node
/**
 * Stage PinBench's patched QEMU for packaging (macOS).
 *
 * The fork in `.qemu/build` links against Homebrew (`/opt/homebrew/...`), which
 * a user's Mac will not have. This copies the two system emulators into
 * `release/qemu/bin`, walks their non-system dylib graph with `otool -L`, copies
 * every dylib into `release/qemu/lib`, and rewrites the load commands to
 * `@executable_path/../lib/…` (binaries) and `@loader_path/…` (dylibs). The ESP
 * ROM images go to `release/qemu/share` — the emulator passes `-L` to them.
 * Licence texts for QEMU and every bundled library go to `release/qemu/licenses`,
 * indexed by `release/qemu/NOTICES.md`.
 *
 * Everything is ad-hoc re-signed, because `install_name_tool` invalidates the
 * original signature and arm64 refuses to run unsigned code. electron-builder
 * then signs them again with the real identity when it signs the app.
 *
 * Usage: node scripts/bundle-qemu.mjs   (run after `bash scripts/setup-emulator.sh`)
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const qemuBuild = join(root, '.qemu', 'build')
const romDir = join(root, '.qemu', 'pc-bios')
const out = join(root, 'release', 'qemu')

const BINARIES = ['qemu-system-xtensa', 'qemu-system-riscv32']
const ROMS = [
  'esp32-v3-rom.bin',
  'esp32-v3-rom-app.bin',
  'esp32s3_rev0_rom.bin',
  'esp32c3-rom.bin',
  'esp32c6-rom.bin'
]

if (process.platform !== 'darwin') {
  console.error('bundle-qemu: macOS only')
  process.exit(1)
}

// stderr ignored: install_name_tool warns once per edit that the signature is
// now invalid, and codesign announces every replacement — both are expected.
const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** Non-system dylib dependencies of a Mach-O file, as written in its load commands. */
function deps(file) {
  return run('otool', ['-L', file])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (')[0])
    .filter(
      (p) => p && !p.startsWith('/usr/lib/') && !p.startsWith('/System/') && !p.startsWith('@')
    )
}

rmSync(out, { recursive: true, force: true })
for (const dir of ['bin', 'lib', 'share']) mkdirSync(join(out, dir), { recursive: true })

// name → original path, for every dylib reachable from the binaries.
const dylibs = new Map()
const queue = []

for (const name of BINARIES) {
  const src = join(qemuBuild, name)
  if (!existsSync(src)) {
    console.error(`bundle-qemu: missing ${src} — run scripts/setup-emulator.sh first`)
    process.exit(1)
  }
  const dst = join(out, 'bin', name)
  copyFileSync(src, dst)
  chmodSync(dst, 0o755)
  queue.push(dst)
}

const rewritten = new Set()
while (queue.length > 0) {
  const file = queue.shift()
  if (rewritten.has(file)) continue
  rewritten.add(file)
  const isBinary = file.startsWith(join(out, 'bin'))
  for (const dep of deps(file)) {
    const name = basename(dep)
    if (!dylibs.has(name)) {
      const real = realpathSync(dep)
      const dst = join(out, 'lib', name)
      copyFileSync(real, dst)
      chmodSync(dst, 0o644)
      dylibs.set(name, real)
      queue.push(dst)
    }
    const ref = isBinary ? `@executable_path/../lib/${name}` : `@loader_path/${name}`
    run('install_name_tool', ['-change', dep, ref, file])
  }
  if (!isBinary) run('install_name_tool', ['-id', `@rpath/${basename(file)}`, file])
}

for (const rom of ROMS) {
  const src = join(romDir, rom)
  if (existsSync(src)) copyFileSync(src, join(out, 'share', rom))
  else console.warn(`bundle-qemu: ROM ${rom} not found — that machine will not boot`)
}

// Licences: QEMU's own, then each dylib's Homebrew formula (Cellar/<formula>/<ver>/).
// Matches COPYING*, LICENSE*, NOTICE*, and SPDX-named texts like glib's LGPL-2.1-or-later.txt.
const LICENSE_FILE = /^(copying|licen[cs]e|notice|authors|(a|l)?gpl-[\d.]+.*\.txt$)/i
const copyLicenses = (fromDir, name) => {
  const dst = join(out, 'licenses', name)
  mkdirSync(dst, { recursive: true })
  for (const file of readdirSync(fromDir)) {
    if (LICENSE_FILE.test(file)) copyFileSync(join(fromDir, file), join(dst, file))
  }
}
copyLicenses(join(root, '.qemu'), 'qemu')

const formulae = new Map() // formula → version
for (const real of dylibs.values()) {
  const m = /\/Cellar\/([^/]+)\/([^/]+)\//.exec(real)
  if (m) formulae.set(m[1], m[2])
}
const info = JSON.parse(run('brew', ['info', '--json=v2', ...formulae.keys()])).formulae
const licenseOf = new Map(info.map((f) => [f.name, f.license ?? 'see licence files']))
for (const [formula, version] of formulae) {
  copyLicenses(join('/opt/homebrew/Cellar', formula, version), formula)
}

writeFileSync(
  join(out, 'NOTICES.md'),
  [
    '# Third-party software bundled with PinBench',
    '',
    '## QEMU',
    '',
    'GPL-2.0-or-later. `bin/qemu-system-xtensa` and `bin/qemu-system-riscv32` are',
    'built from espressif/qemu at the commit pinned in `scripts/setup-emulator.sh`,',
    "with PinBench's patches (`qemu/`) applied. Corresponding source:",
    'https://github.com/slopcore/pinbench — licence texts in `licenses/qemu/`.',
    '',
    '## Libraries (`lib/`), from Homebrew',
    '',
    '| Library | Version | Licence |',
    '| --- | --- | --- |',
    ...[...formulae]
      .sort()
      .map(([formula, version]) => `| ${formula} | ${version} | ${licenseOf.get(formula)} |`),
    '',
    'Licence texts for each are in `licenses/<library>/`. Source for each version is',
    'available from its upstream project and from Homebrew (https://formulae.brew.sh).',
    ''
  ].join('\n')
)

// Ad-hoc sign (dylibs first, then the binaries that load them).
for (const name of dylibs.keys()) run('codesign', ['-f', '-s', '-', join(out, 'lib', name)])
for (const name of BINARIES) run('codesign', ['-f', '-s', '-', join(out, 'bin', name)])

// Prove nothing still points at Homebrew.
for (const file of [
  ...BINARIES.map((n) => join(out, 'bin', n)),
  ...[...dylibs.keys()].map((n) => join(out, 'lib', n))
]) {
  const leftover = deps(file)
  if (leftover.length > 0) {
    console.error(`bundle-qemu: ${basename(file)} still links ${leftover.join(', ')}`)
    process.exit(1)
  }
}

console.log(
  `bundle-qemu: ${BINARIES.length} binaries, ${dylibs.size} dylibs, ROMs → ${resolve(out)}`
)
