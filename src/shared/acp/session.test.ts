import { describe, expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION } from './methods'
import {
  PINBENCH_CLIENT_CAPABILITIES,
  httpMcpServer,
  initializeParams,
  negotiateVersion,
  newSessionParams
} from './session'

describe('initializeParams', () => {
  it('advertises our version and fs read/write; terminal is off until wired', () => {
    const p = initializeParams({ name: 'PinBench', version: '0.1.0' })
    expect(p.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    expect(p.clientCapabilities).toEqual(PINBENCH_CLIENT_CAPABILITIES)
    expect(p.clientCapabilities.fs).toEqual({ readTextFile: true, writeTextFile: true })
    expect(p.clientCapabilities.terminal).toBe(false)
  })

  it('takes an explicit capability override', () => {
    const p = initializeParams(
      { name: 'PinBench', version: '0.1.0' },
      { fs: { readTextFile: true, writeTextFile: false }, terminal: true }
    )
    expect(p.clientCapabilities.terminal).toBe(true)
    expect(p.clientCapabilities.fs.writeTextFile).toBe(false)
  })
})

describe('negotiateVersion', () => {
  it('never exceeds ours and never drops below 1', () => {
    expect(negotiateVersion(999)).toBe(ACP_PROTOCOL_VERSION)
    expect(negotiateVersion(0)).toBe(1)
    expect(negotiateVersion(1)).toBe(1)
  })

  it('falls back to ours when the agent omits or fuzzes the number', () => {
    expect(negotiateVersion(undefined)).toBe(ACP_PROTOCOL_VERSION)
    expect(negotiateVersion('nan')).toBe(ACP_PROTOCOL_VERSION)
    expect(negotiateVersion(1.5)).toBe(ACP_PROTOCOL_VERSION)
  })
})

describe('httpMcpServer', () => {
  it('builds an http entry with no headers by default', () => {
    expect(httpMcpServer('pinbench', 'http://127.0.0.1:41000/mcp')).toEqual({
      type: 'http',
      name: 'pinbench',
      url: 'http://127.0.0.1:41000/mcp',
      headers: []
    })
  })

  it('adds a bearer header when a token is given', () => {
    expect(httpMcpServer('pinbench', 'http://x', 'sekret').headers).toEqual([
      { name: 'Authorization', value: 'Bearer sekret' }
    ])
  })
})

describe('newSessionParams', () => {
  it('carries the cwd and lists exactly the control server', () => {
    const control = httpMcpServer('pinbench', 'http://x')
    expect(newSessionParams('/home/u/proj', control)).toEqual({
      cwd: '/home/u/proj',
      mcpServers: [control]
    })
  })
})
