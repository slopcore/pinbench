import type { PinBenchApi } from '../shared/ipc'

declare global {
  interface Window {
    pinbench: PinBenchApi
  }
}

export {}
