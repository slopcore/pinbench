import type { Plugin } from 'vite'

/**
 * The renderer's Content-Security Policy, injected into `index.html` at build
 * time.
 *
 * A build loads nothing from the network — fonts are bundled and there is no
 * remote content — so the shipped policy can be this tight. Vite's dev server
 * needs inline scripts, `eval` and a websocket for hot reload, and gets exactly
 * that much more, never in a build.
 */
export const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'"

export const DEVELOPMENT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws:"

export const cspFor = (development: boolean): string =>
  development ? DEVELOPMENT_CSP : PRODUCTION_CSP

export const csp = (): Plugin => ({
  name: 'pinbench-csp',
  transformIndexHtml: {
    order: 'pre',
    handler: (html, context) => html.replace('%CSP%', cspFor(context.server !== undefined))
  }
})
