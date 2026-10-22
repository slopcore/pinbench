import { BrowserWindow } from 'electron'
import { join } from 'node:path'

/** Long enough to register the slop, short enough not to be in the way. */
const MIN_VISIBLE_MS = 1200
const FADE_MS = 300

export interface Splash {
  /**
   * Show `main` and fade the splash out over it — once the splash has been up
   * for {@link MIN_VISIBLE_MS}. Safe to call more than once.
   */
  handOff(main: BrowserWindow): void
}

/**
 * The slopcore launch splash: a small frameless window with the slop bucket on
 * bricktoucher's `#07030f`, shown while the main window loads. `dir` holds
 * `splash.html` + `slopcore.png` (`resources/splash`, packed into the app).
 */
export function showSplash(dir: string): Splash {
  const shownAt = Date.now()
  const splash = new BrowserWindow({
    width: 440,
    height: 340,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#07030f',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  splash.once('ready-to-show', () => splash.show())
  void splash.loadFile(join(dir, 'splash.html'))

  let handedOff = false
  return {
    handOff(main) {
      if (handedOff) return
      handedOff = true
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt))
      setTimeout(() => {
        if (!main.isDestroyed()) main.show()
        if (splash.isDestroyed()) return
        // Fade with window opacity rather than page script: the splash page's
        // CSP allows no script, and this needs no IPC.
        const started = Date.now()
        const tick = setInterval(() => {
          if (splash.isDestroyed()) return clearInterval(tick)
          const t = Math.min(1, (Date.now() - started) / FADE_MS)
          splash.setOpacity(1 - t)
          if (t >= 1) {
            clearInterval(tick)
            splash.destroy()
          }
        }, 16)
      }, wait)
    }
  }
}
