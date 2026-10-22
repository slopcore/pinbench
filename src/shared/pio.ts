/**
 * Pure helpers around PlatformIO: parsing `pio project config --json-output`,
 * and generating the PinBench-owned override config that forces an emulator
 * build to DIO without ever touching the user's `platformio.ini`.
 *
 * QEMU's `m25p80` flash model implements no QPI commands, so a stock QIO build
 * boot-loops with an assert in `esp_vfs_console_register()` that points nowhere
 * near the cause (M0 lost an hour to this). Editing the user's file to fix it
 * would be the M11 round-tripping mistake arriving eight milestones early, so
 * the override is a separate file passed with `pio run -c`.
 */

export interface ProjectConfig {
  /** Environment names, `env:` prefix stripped, in file order. */
  envs: string[]
  /** Per-environment options, with `[env]` defaults already merged in. */
  options: Record<string, Record<string, string>>
}

type RawEntry = [string, unknown]
type RawSection = [string, RawEntry[]]

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n')
  return String(value)
}

/**
 * `pio project config --json-output` emits
 * `[[sectionName, [[key, value], ...]], ...]`, where a value may be a string,
 * a number, or an array (multi-line options like `build_flags`).
 */
export function parseProjectConfig(json: unknown): ProjectConfig {
  if (!Array.isArray(json)) {
    throw new Error('Unexpected `pio project config` output: not an array')
  }

  const sections = json as RawSection[]
  const defaults: Record<string, string> = {}
  const perEnv: Record<string, Record<string, string>> = {}
  const envs: string[] = []

  for (const [name, entries] of sections) {
    const bag: Record<string, string> = {}
    for (const [key, value] of entries ?? []) bag[key] = stringifyValue(value)

    if (name === 'env') {
      Object.assign(defaults, bag)
    } else if (name.startsWith('env:')) {
      const env = name.slice('env:'.length)
      envs.push(env)
      perEnv[env] = bag
    }
  }

  const options: Record<string, Record<string, string>> = {}
  for (const env of envs) {
    options[env] = { ...defaults, ...perEnv[env] }
  }

  return { envs, options }
}

/** Names only, from a raw `platformio.ini` — used before `pio` is available. */
export function parseEnvNamesFromIni(ini: string): string[] {
  const names: string[] = []
  const re = /^\s*\[env:([^\]]+)\]\s*$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(ini)) !== null) names.push(match[1]!.trim())
  return names
}

/**
 * The `extra_configs` patterns from a `[platformio]` section, in file order.
 * PlatformIO takes a newline- or comma-separated list; a value may sit on the
 * key's line or on indented continuation lines. Inline `;`/`#` comments and
 * blank entries are dropped. Patterns are returned verbatim (still relative,
 * globs unexpanded) — {@link collectEnvNames} resolves them.
 */
export function parseExtraConfigs(ini: string): string[] {
  const lines = ini.split(/\r?\n/)
  let value: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^\s*extra_configs\s*[=:]\s*(.*)$/.exec(line)
    if (!m) continue
    const parts = [m[1]!]
    // Indented (or blank) lines that follow are continuations of the value.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!
      if (/^\s*\[/.test(next)) break // next section
      if (/^\S/.test(next) && next.trim() !== '') break // next key
      parts.push(next)
    }
    value = parts.join('\n')
    break
  }
  if (value === null) return []
  return value
    .split(/[\n,]/)
    .map((entry) => entry.replace(/[;#].*$/, '').trim())
    .filter((entry) => entry.length > 0)
}

/** Reads a project file by its path relative to the PlatformIO project root. */
export type IniReader = (relativePath: string) => string | null
/** Expands a `*` / `**` glob (rooted at the project) to matching relative paths. */
export type IniGlob = (pattern: string) => string[]

/**
 * Every `[env:*]` name reachable from a PlatformIO project's `platformio.ini`,
 * following `extra_configs` (PlatformIO globs these; MeshCore-style repos keep
 * each board's build envs in `variants/<name>/platformio.ini`). Pure — the
 * caller injects the reader and globber, so it is unit-testable with no `pio`
 * and no real filesystem. Names are de-duplicated, in discovery order:
 * `platformio.ini` first, then each included file.
 */
export function collectEnvNames(read: IniReader, glob: IniGlob): string[] {
  const envs = new Set<string>()
  const visited = new Set<string>()
  const normalise = (p: string): string => p.replace(/^\.\//, '').replace(/\/{2,}/g, '/')

  const visit = (relativePath: string): void => {
    const key = normalise(relativePath)
    if (visited.has(key)) return
    visited.add(key)
    const text = read(key)
    if (text === null) return
    for (const name of parseEnvNamesFromIni(text)) envs.add(name)
    for (const pattern of parseExtraConfigs(text)) {
      const isGlob = /[*?[\]]/.test(pattern)
      const matches = isGlob ? [...glob(pattern)].sort() : [pattern]
      for (const match of matches) visit(match)
    }
  }

  visit('platformio.ini')
  return [...envs]
}

export interface OverrideConfigInput {
  /** Absolute path to the user's real `platformio.ini`. */
  userConfigPath: string
  /** Environments to pin — every env PinBench might build. */
  envs: string[]
  /**
   * Board's PSRAM is octal (ESP32-S3-R8 etc.). `memory_type` is
   * `<flash>_<psram>`, so the DIO override must keep the PSRAM half right:
   * `dio_opi` for octal, `dio_qspi` for quad. Getting this wrong builds a
   * quad-PSRAM sdkconfig for an octal part — PSRAM init fails and the guest
   * hangs before first serial, which reads exactly like a boot regression.
   */
  psramOctal?: boolean | undefined
}

/**
 * The `-c` config: it pulls the user's file in via `extra_configs` and then
 * pins the flash mode per environment, where it beats an `[env]` default and a
 * per-env value alike (PinBench's section is the one `pio run -c` reads first).
 *
 * Only *single-value* options work this way. A multi-value option such as
 * `build_flags` set in a section this file did not originate is silently
 * dropped, not merged — so the emulated-network `-D` goes in via
 * `PLATFORMIO_BUILD_FLAGS` in `build.ts`, not here.
 */
export function overrideConfigIni({
  userConfigPath,
  envs,
  psramOctal
}: OverrideConfigInput): string {
  const memoryType = psramOctal ? 'dio_opi' : 'dio_qspi'
  const lines = [
    '; Generated by PinBench for emulator builds — do not edit.',
    `; Forces DIO flash mode; delegates everything else to:`,
    `;   ${userConfigPath}`,
    '',
    '[platformio]',
    `extra_configs = ${userConfigPath}`,
    ''
  ]
  for (const env of envs) {
    lines.push(
      `[env:${env}]`,
      'board_build.flash_mode = dio',
      `board_build.arduino.memory_type = ${memoryType}`,
      ''
    )
  }
  return lines.join('\n')
}

/**
 * The `-c` config for a **USB flash** build: it pins nothing about flash mode —
 * the board's real QIO/OPI is what a real chip wants — but redirects `build_dir`
 * so the board-native artifacts never share `.pio/build/<env>` with the
 * DIO-forced emulator ones. Without this the two builds overwrite each other and
 * a subsequent Build & flash can merge QIO binaries into the QEMU image, which
 * boot-loops in `m25p80` exactly as the emulator override's comment describes.
 */
export function usbBuildOverrideIni({
  userConfigPath,
  buildDir
}: {
  userConfigPath: string
  /** Absolute; PlatformIO writes each env into `<buildDir>/<env>`. */
  buildDir: string
}): string {
  return [
    '; Generated by PinBench for USB-flash builds — do not edit.',
    '; Board-native build (no flash-mode override), kept out of .pio/build.',
    `;   ${userConfigPath}`,
    '',
    '[platformio]',
    `extra_configs = ${userConfigPath}`,
    `build_dir = ${buildDir}`,
    ''
  ].join('\n')
}

/**
 * The PlatformIO core dir to build `platform` with. pioarduino's platform (the
 * only way to get Arduino-ESP32 3.x — and so the ESP32-C6 — under PlatformIO
 * Core 6.1) does not install its framework, esptool and RISC-V toolchain
 * *alongside* the official `espressif32` platform's: its installer replaces
 * the shared `framework-arduinoespressif32` / `tool-esptoolpy` /
 * `toolchain-riscv32-esp` packages in place, which silently breaks every S3
 * project on the next build. So a pioarduino env builds in a sibling core dir
 * (`~/.platformio-pioarduino`) and the default one is never touched.
 */
export function coreDirForPlatform(platform: string | undefined, defaultCoreDir: string): string {
  if (!platform || !/pioarduino/i.test(platform)) return defaultCoreDir
  return `${defaultCoreDir.replace(/[/\\]+$/, '')}-pioarduino`
}
