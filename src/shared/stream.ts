/**
 * A line splitter that understands carriage returns.
 *
 * `emulator.ts` splits on `/\r?\n/` because UART output is newline-terminated.
 * `pio run` is not: its first run downloads a toolchain and draws `\r`-based
 * progress bars, and the roadmap warns those minutes "will look like a hang".
 * This splitter surfaces a `\r` segment as a *replaceable* current line so the
 * UI can overwrite one row instead of scrolling forever.
 */

export interface StreamSegment {
  text: string
  /** True for a `\r` update: overwrite the previous line, do not append. */
  replace: boolean
}

export class LineStreamer {
  private buffer = ''

  /** Feed a chunk; get back the completed segments it produced. */
  push(chunk: string): StreamSegment[] {
    this.buffer += chunk
    const segments: StreamSegment[] = []

    // Split on either terminator, keeping which one matched.
    const re = /(\r\n|\n|\r)/
    let match: RegExpExecArray | null
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index
      const terminator = match[1]!
      const text = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + terminator.length)
      // A bare `\r` (not `\r\n`) is a progress redraw of the current line.
      segments.push({ text, replace: terminator === '\r' })
    }

    return segments
  }

  /** Whatever is left unterminated — call on stream end. */
  flush(): StreamSegment | null {
    if (this.buffer.length === 0) return null
    const text = this.buffer
    this.buffer = ''
    return { text, replace: false }
  }
}
