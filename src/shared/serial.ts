// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export interface SerialLine {
  /** Milliseconds since emulator start. */
  t: number
  text: string
}
