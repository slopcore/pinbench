import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { csp } from './build/csp'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload cannot be an ES module, and this package is
        // `type: module` — so it is emitted as CommonJS with a .cjs extension.
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    // Pin the dev server. Without `strictPort`, a stale server from a previous
    // run makes electron-vite quietly fall back to 5174 while the Electron
    // window still points at 5173, so HMR looks broken; fail loudly instead.
    // `scripts/preflight.mjs` reaps that stale server before we get here.
    server: { port: 5173, strictPort: true },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react(), csp()]
  }
})
