import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppInfo, WindowState } from '@shared/ipc'
import { App } from './App'
import './styles/base.css'

const INITIAL_WINDOW_STATE: WindowState = { maximised: false, fullScreen: false, focused: true }

/**
 * Everything the shell needs from the main process, resolved before the window
 * paints. There is no fallback: if the bridge is missing, the app is broken and
 * should say so rather than render a plausible-looking lie.
 */
function Root(): React.JSX.Element | null {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [windowState, setWindowState] = useState<WindowState>(INITIAL_WINDOW_STATE)

  useEffect(() => {
    void window.pinbench.appInfo().then(setAppInfo)
    return window.pinbench.window.onStateChange(setWindowState)
  }, [])

  if (!appInfo) return null
  return <App appInfo={appInfo} windowState={windowState} />
}

const host = document.getElementById('root')
if (!host) throw new Error('renderer root element is missing')

createRoot(host).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
