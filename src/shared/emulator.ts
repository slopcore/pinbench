export type EmulatorState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface EmulatorStatus {
  state: EmulatorState
  /** Why the emulator entered the crashed state, if it did. */
  error?: string
}

/**
 * Machine and memory options for a launch. M2 hardcoded these; from M3 they
 * come from the board definition's `emulator` target so a second board with
 * different PSRAM is data, not a code change. No `psramSize` means no `-m`,
 * and therefore silently no PSRAM.
 */
export interface EmulatorLaunchOptions {
  machine?: string
  psramSize?: string
  psramOctal?: boolean
  /** Total flash-image size (e.g. `16M`); sizes the merged Build & flash image. */
  flashSize?: string
  /**
   * Guest networking. `'none'` (the default, and the right choice for every
   * LoRa-only build) launches with no NIC — the ESP32-S3's own WiFi is
   * unmodelled, so a stock firmware simply has no network. `'user'` adds the
   * fork's OpenCores Ethernet MAC (`-nic user,model=open_eth`) wired to QEMU's
   * slirp user stack, which NATs the guest onto the host's network — a
   * pass-through for firmware built with `PINBENCH_EMULATED_NET`, which brings
   * an openeth netif up in WiFi's place. See docs/features/emulated-network.md.
   */
  network?: EmulatorNetwork
}

export type EmulatorNetwork = 'none' | 'user'

/** RISC-V ESP32 machines in the fork; everything else is Xtensa. */
const RISCV_MACHINES = new Set(['esp32c3', 'esp32c6'])

/**
 * Which QEMU system binary runs a `-machine`. The S3 is Xtensa
 * (`qemu-system-xtensa`); the C3 / C6 are RISC-V (`qemu-system-riscv32`).
 * `setup-emulator.sh` builds both into `.qemu/build/`.
 */
export function qemuBinaryFor(machine: string | undefined): string {
  return RISCV_MACHINES.has(machine ?? 'esp32s3') ? 'qemu-system-riscv32' : 'qemu-system-xtensa'
}

export const DEFAULT_LAUNCH_OPTIONS: EmulatorLaunchOptions = {
  machine: 'esp32s3',
  psramSize: '8M',
  psramOctal: true
}

/**
 * Wi-Fi API entry points wrapped by the PinBench transparent emulation shim
 * to redirect calls from the unmodelled ESP32 Wi-Fi hardware peripheral to
 * the QEMU OpenCores Ethernet MAC.
 */
export const WIFI_WRAP_SYMBOLS = [
  'esp_wifi_init',
  'esp_wifi_deinit',
  'esp_wifi_set_mode',
  'esp_wifi_get_mode',
  'esp_wifi_set_config',
  'esp_wifi_get_config',
  'esp_wifi_start',
  'esp_wifi_stop',
  'esp_wifi_connect',
  'esp_wifi_disconnect',
  'esp_wifi_scan_start',
  'esp_wifi_scan_stop',
  'esp_wifi_scan_get_ap_num',
  'esp_wifi_scan_get_ap_records',
  'esp_wifi_sta_get_ap_info',
  'esp_wifi_get_mac',
  'esp_wifi_set_mac',
  'esp_wifi_set_ps',
  'esp_wifi_get_ps',
  'esp_wifi_set_storage',
  'esp_wifi_set_bandwidth',
  'esp_wifi_get_bandwidth',
  'esp_wifi_set_channel',
  'esp_wifi_get_channel',
  'esp_wifi_internal_reg_rxcb',
  'esp_wifi_register_if_rxcb',
  'esp_wifi_internal_set_sta_ip',
  'esp_wifi_internal_reg_netstack_buf_cb',
  'esp_wifi_internal_free_rx_buffer',
  'esp_wifi_internal_tx',
  'esp_wifi_create_if_driver',
  'esp_wifi_destroy_if_driver',
  'esp_wifi_is_if_ready_when_started',
  'esp_netif_get_ip_info',
  'esp_netif_get_dns_info',
  'dns_getserver',
  'netif_set_default',
  'esp_netif_set_default_netif',
  '_ZN12WiFiSTAClass6statusEv',
  '_ZN16WiFiGenericClass10hostByNameEPKcR9IPAddress',
  '_ZN10WiFiClient7connectEPKct',
  '_ZN10WiFiClient7connectEPKcti'
] as const

/** Returns the compiler/linker flags needed to inject the Wi-Fi wrap shim. */
export function wifiWrapBuildFlags(): string[] {
  return ['-DPINBENCH_EMULATED_NET=1', ...WIFI_WRAP_SYMBOLS.map((sym) => `-Wl,--wrap=${sym}`)]
}

/** QEMU args for a `network` mode. `'none'` (or undefined) adds nothing. */
export function networkArgs(network: EmulatorNetwork | undefined): string[] {
  return network === 'user' ? ['-nic', 'user,model=open_eth'] : []
}

/**
 * QEMU args that hand SoC UART1 to the device host: a unix-socket chardev
 * (QEMU connects as the client) bound as the second `-serial`, which the
 * fork's machines wire to UART1 (`serial_hd(1)`). Must follow the UART0
 * `-serial mon:stdio`. `null` adds nothing.
 */
export function uart1Args(socketPath: string | null): string[] {
  return socketPath
    ? ['-chardev', `socket,id=pbuart1,path=${socketPath}`, '-serial', 'chardev:pbuart1']
    : []
}

const VALID_TRANSITIONS: Record<EmulatorState, EmulatorState[]> = {
  idle: ['starting'],
  starting: ['running', 'crashed', 'stopping'],
  running: ['stopping', 'crashed'],
  stopping: ['idle', 'crashed'],
  crashed: ['starting', 'idle']
}

export function canTransition(from: EmulatorState, to: EmulatorState): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function transition(from: EmulatorState, to: EmulatorState): EmulatorState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid emulator transition: ${from} → ${to}`)
  }
  return to
}

export const INITIAL_STATUS: EmulatorStatus = { state: 'idle' }
