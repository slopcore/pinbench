/**
 * electron-builder config — macOS (arm64) for now.
 *
 *   npm run dist:mac      signed with your Developer ID if the keychain has one,
 *                         else ad-hoc; not notarized
 *   npm run release:mac   same, then notarized via the `pinbench-notary`
 *                         keychain profile (`xcrun notarytool store-credentials`)
 *
 * In CI (.github/workflows/release-mac.yml) the certificate arrives as
 * `CSC_LINK` / `CSC_KEY_PASSWORD` (electron-builder imports it into a temporary
 * keychain) and notarization uses `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
 * `APPLE_API_ISSUER`.
 *
 * `scripts/bundle-qemu.mjs` stages the patched QEMU + its dylibs + ESP ROMs in
 * `release/qemu` first; it ships as `Resources/qemu`.
 */
import { execFileSync } from 'node:child_process'

function hasDeveloperId() {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    }).includes('Developer ID Application')
  } catch {
    return false
  }
}

const developerId = Boolean(process.env.CSC_LINK) || hasDeveloperId()
const notarize =
  developerId && Boolean(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY)

if (!developerId) {
  console.warn(
    '[pinbench] no "Developer ID Application" certificate — ad-hoc signing, no notarization'
  )
} else if (!notarize) {
  console.warn('[pinbench] no notarization credentials — signing without notarization')
}

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.slopcore.pinbench',
  productName: 'PinBench',
  copyright: 'Copyright © 2026 slopcore',
  directories: { output: 'release/dist', buildResources: 'packaging' },
  files: ['out/**', 'resources/splash/**', 'package.json'],
  extraResources: [
    { from: 'release/qemu', to: 'qemu' },
    { from: 'boards', to: 'boards', filter: ['*.board.json'] },
    { from: 'runtime', to: 'runtime' },
    { from: 'scripts/pinbench-mcp.mjs', to: 'scripts/pinbench-mcp.mjs' }
  ],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    // Unset → electron-builder picks the Developer ID from the keychain.
    ...(developerId ? {} : { identity: '-' }),
    notarize
  },
  dmg: {
    title: '${productName} ${version}',
    backgroundColor: '#07030f'
  }
}
