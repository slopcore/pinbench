import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
      // Main-process modules import Electron at load time; tests get a stub and
      // pass real collaborators (paths, windows) in explicitly.
      electron: resolve('test/electron-stub.ts')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'build/**/*.test.ts', 'test/**/*.test.{ts,tsx}']
  }
})
