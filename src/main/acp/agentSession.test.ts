import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_PROTOCOL_VERSION } from '../../shared/acp/methods'
import { ProjectFiles } from '../fileTree'
import { AcpConnection } from './connection'
import { AgentSession, type SessionCallbacks } from './agentSession'
import { transportPair } from './testTransport'

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

/** A minimal scripted agent on the far end of the pair. */
function fakeAgent(
  conn: AcpConnection,
  script: (session: AcpConnection) => Promise<void> = async () => {}
) {
  conn.on('initialize', () => ({
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true } },
    agentInfo: { name: 'fake', version: '0' }
  }))
  conn.on('session/new', (params) => {
    ;(conn as unknown as { lastNewSession: unknown }).lastNewSession = params
    return { sessionId: 'sess-1' }
  })
  conn.on('session/prompt', async () => {
    await script(conn)
    return { stopReason: 'end_turn' }
  })
}

function callbacks(over: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    fs: {
      readTextFile: vi.fn(async () => 'file contents'),
      writeTextFile: vi.fn(async () => {})
    },
    requestPermission: vi.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } })),
    onUpdate: vi.fn(),
    ...over
  }
}

const session = (script?: (c: AcpConnection) => Promise<void>) => {
  const { a, b } = transportPair()
  const agentConn = new AcpConnection(b)
  fakeAgent(agentConn, script)
  const clientConn = new AcpConnection(a)
  const cbs = callbacks()
  const s = new AgentSession({
    connection: clientConn,
    clientInfo: { name: 'PinBench', version: '0.1.0' },
    cwd: '/home/u/proj',
    mcpServerUrl: 'http://127.0.0.1:41234/mcp',
    mcpServerToken: 'tok',
    callbacks: cbs
  })
  return { s, cbs, agentConn }
}

describe('AgentSession', () => {
  it('initialises and creates a session listing the control server', async () => {
    const { s, agentConn } = session()
    const id = await s.start()
    expect(id).toBe('sess-1')
    expect(s.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    const newSession = (
      agentConn as unknown as { lastNewSession: { cwd: string; mcpServers: unknown[] } }
    ).lastNewSession
    expect(newSession.cwd).toBe('/home/u/proj')
    expect(newSession.mcpServers).toEqual([
      {
        type: 'http',
        name: 'pinbench',
        url: 'http://127.0.0.1:41234/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer tok' }]
      }
    ])
  })

  it('refuses prompt() before start() resolves', async () => {
    const { s } = session()
    await expect(s.prompt('hi')).rejects.toThrow(/start\(\)/)
  })

  it('runs a prompt turn and returns the stop reason', async () => {
    const { s } = session()
    await s.start()
    expect(await s.prompt('do the thing')).toEqual({ stopReason: 'end_turn' })
  })

  it('serves fs/read_text_file from the sandboxed provider during a turn', async () => {
    const { s, cbs } = session(async (agent) => {
      const res = await agent.request('fs/read_text_file', { path: '/home/u/proj/src/main.cpp' })
      expect(res).toEqual({ content: 'file contents' })
    })
    await s.start()
    await s.prompt('read a file')
    expect(cbs.fs.readTextFile).toHaveBeenCalledWith(
      '/home/u/proj/src/main.cpp',
      undefined,
      undefined
    )
  })

  it('serves fs/write_text_file', async () => {
    const { s, cbs } = session(async (agent) => {
      await agent.request('fs/write_text_file', { path: '/home/u/proj/x.txt', content: 'hi' })
    })
    await s.start()
    await s.prompt('write a file')
    expect(cbs.fs.writeTextFile).toHaveBeenCalledWith('/home/u/proj/x.txt', 'hi')
  })

  it('routes session/request_permission to the callback', async () => {
    const { s, cbs } = session(async (agent) => {
      const out = await agent.request('session/request_permission', {
        toolCall: { title: 'flash' }
      })
      expect(out).toMatchObject({ outcome: { outcome: 'selected' } })
    })
    await s.start()
    await s.prompt('flash it')
    expect(cbs.requestPermission).toHaveBeenCalled()
  })

  it('forwards session/update notifications', async () => {
    const { s, cbs } = session(async (agent) => {
      agent.notify('session/update', {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk' }
      })
      await new Promise((r) => setTimeout(r, 5))
    })
    await s.start()
    await s.prompt('talk')
    expect(cbs.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ update: { sessionUpdate: 'agent_message_chunk' } })
    )
  })

  it('start() rejects if the agent never completes the handshake', async () => {
    const { a, b } = transportPair()
    // Accepts the request but never answers it.
    new AcpConnection(b, { initialize: () => new Promise(() => {}) })
    const s = new AgentSession({
      connection: new AcpConnection(a),
      clientInfo: { name: 'PinBench', version: '0.1.0' },
      cwd: '/p',
      mcpServerUrl: 'http://127.0.0.1:1/mcp',
      callbacks: callbacks(),
      startTimeoutMs: 40
    })
    await expect(s.start()).rejects.toThrow(/handshake in 40ms/)
  })

  it('refuses an fs/read_text_file path that escapes the project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pinbench-acp-'))
    writeFileSync(join(root, 'inside.txt'), 'ok')
    const files = new ProjectFiles(root)
    tempRoots.push(root)

    const { a, b } = transportPair()
    const agentConn = new AcpConnection(b)
    fakeAgent(agentConn, async (agent) => {
      await expect(
        agent.request('fs/read_text_file', { path: join(root, 'inside.txt') })
      ).resolves.toEqual({
        content: 'ok'
      })
      await expect(
        agent.request('fs/read_text_file', { path: join(root, '..', '..', 'etc', 'passwd') })
      ).rejects.toMatchObject({ message: expect.stringMatching(/escapes project root/) })
    })
    const s = new AgentSession({
      connection: new AcpConnection(a),
      clientInfo: { name: 'PinBench', version: '0.1.0' },
      cwd: root,
      mcpServerUrl: 'http://127.0.0.1:1/mcp',
      callbacks: {
        fs: {
          readTextFile: (path) => files.readFile(path),
          writeTextFile: (path, content) => files.writeFile(path, content)
        },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        onUpdate: vi.fn()
      }
    })
    await s.start()
    await s.prompt('read files')
  })

  it('sends session/cancel on cancel()', async () => {
    const canceled = vi.fn()
    const { a, b } = transportPair()
    const agentConn = new AcpConnection(b)
    fakeAgent(agentConn)
    agentConn.on('session/cancel', canceled)
    const s = new AgentSession({
      connection: new AcpConnection(a),
      clientInfo: { name: 'PinBench', version: '0.1.0' },
      cwd: '/p',
      mcpServerUrl: 'http://127.0.0.1:1/mcp',
      callbacks: callbacks()
    })
    await s.start()
    s.cancel()
    await new Promise((r) => setTimeout(r, 5))
    expect(canceled).toHaveBeenCalledWith({ sessionId: 'sess-1' })
  })
})
