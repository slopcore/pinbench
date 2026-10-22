#!/usr/bin/env node
/**
 * stdio → loopback-HTTP bridge for PinBench's ACP control server.
 *
 * PinBench (started `--acp`, or any dev run) stands up an MCP-over-HTTP control
 * server on 127.0.0.1 and drops its URL + per-session bearer token in
 * `/tmp/pinbench-acp.json`. Claude Code (and other stdio-only MCP clients)
 * can't dial a loopback URL directly, so this script is the `Stdio` MCP server
 * they spawn: it reads newline-delimited JSON-RPC on stdin, POSTs each frame to
 * the control server, and writes the response frame back on stdout.
 *
 * Register once:
 *   claude mcp add pinbench -- node <repo>/scripts/pinbench-mcp.mjs
 *
 * The token/port change every time PinBench restarts; this script re-reads the
 * file on each request, so after restarting PinBench just `/mcp` reconnect (or
 * restart the CLI).
 */
import { readFileSync } from 'node:fs'

const INFO_PATH = process.env.PINBENCH_ACP_INFO ?? '/tmp/pinbench-acp.json'

function endpoint() {
  let raw
  try {
    raw = readFileSync(INFO_PATH, 'utf8')
  } catch {
    throw new Error(
      `PinBench ACP info not found at ${INFO_PATH} — is PinBench running (dev, or --acp)?`
    )
  }
  const { url, token } = JSON.parse(raw)
  if (!url || !token) throw new Error(`Malformed ${INFO_PATH}: need { url, token }`)
  return { url, token }
}

async function forward(frame) {
  const { url, token } = endpoint()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(frame)
  })
  if (res.status === 202 || res.status === 204) return undefined // notification, no reply
  const text = await res.text()
  if (!res.ok) {
    if (frame.id === undefined) return undefined
    return {
      jsonrpc: '2.0',
      id: frame.id,
      error: {
        code: -32000,
        message: `control server HTTP ${res.status}`,
        data: text.slice(0, 500)
      }
    }
  }
  return text ? JSON.parse(text) : undefined
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let pending = 0
let stdinEnded = false
const maybeExit = () => {
  if (stdinEnded && pending === 0) process.exit(0)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    pending += 1
    forward(frame)
      .then((reply) => {
        if (reply !== undefined) write(reply)
      })
      .catch((err) => {
        if (frame.id !== undefined) {
          write({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32001, message: String(err?.message ?? err) }
          })
        }
      })
      .finally(() => {
        pending -= 1
        maybeExit()
      })
  }
})
process.stdin.on('end', () => {
  stdinEnded = true
  maybeExit()
})
