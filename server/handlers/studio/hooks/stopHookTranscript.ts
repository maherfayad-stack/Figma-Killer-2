/**
 * stopHookTranscript — the assistant's own last reply, read out of the
 * `claude` CLI's transcript file.
 *
 * ## Why the gate needs it
 *
 * A9's balanced Stop gate asks "is every differing region either fixed or
 * NAMED". The first half is measured (the compare verdict on disk); the second
 * half is a claim the agent makes in prose, and prose is the only place it can
 * be made. Without the reply the gate can only ever ask for another compare,
 * which is exactly the loop the mode-aware gate exists to end: balanced allows
 * a deliberate deviation, and a gate that cannot read the deviation cannot
 * allow it.
 *
 * ## Why this is a best-effort read
 *
 * The transcript path arrives in the Stop hook's stdin payload
 * (`transcript_path`) and its line format belongs to the CLI, not to Studio.
 * So every failure mode here — the file is absent, a line is not JSON, a line
 * is a shape this reader does not know — degrades to "no reply text", which
 * the gate treats as "nothing was named". That is the safe direction (one
 * extra compare is asked for, never a page waved through) and it is also
 * what is true when the reply genuinely cannot be read.
 *
 * Bounded: only the tail of the file is read, and only the trailing assistant
 * text is returned. A long session's transcript is megabytes, and the gate's
 * question is about the LAST reply.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

/** How much of the transcript's tail to read. Comfortably more than one reply and its tool results, far less than a session. */
const TAIL_BYTES = 256_000
/** The reply handed to the gate is capped — the region-name check is a substring scan, and an unbounded string would make a pathological transcript a pathological scan. */
const MAX_REPLY_CHARS = 20_000

/** Every string in `content`, whether it is a bare string, a `{type:'text',text}` block, or an array of either. Anything else contributes nothing. */
function collectText(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (Array.isArray(content)) return content.flatMap((part) => collectText(part))
  if (typeof content === 'object' && content !== null) {
    const block = content as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
  }
  return []
}

/** The tail of `file`, decoded as UTF-8. Reads through a file descriptor rather than `readFileSync` so a multi-megabyte transcript never lands in memory whole. */
function readTail(file: string): string {
  const size = statSync(file).size
  if (size <= TAIL_BYTES) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(TAIL_BYTES)
    readSync(fd, buffer, 0, TAIL_BYTES, size - TAIL_BYTES)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The trailing assistant text in the transcript at `transcriptPath` — the
 * reply the user is about to read — or `undefined` when it cannot be read.
 *
 * "Trailing" means the assistant turns after the last user/tool-result entry:
 * a reply split across several assistant records is joined, and an earlier
 * turn's reply is never included, because a region named three turns ago was
 * named about a screen that has since been rewritten.
 */
export function readLastAssistantReply(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined
  try {
    if (!existsSync(transcriptPath)) return undefined
    const lines = readTail(transcriptPath).split('\n')
    const trailing: string[] = []
    // Walk backwards: collect assistant text until something that is not an
    // assistant record interrupts it. The first (partial) line of a tail read
    // is simply unparseable and stops the walk, which is correct — a fragment
    // is not evidence.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim()
      if (line.length === 0) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        break
      }
      if (typeof entry !== 'object' || entry === null) break
      const record = entry as { type?: unknown; role?: unknown; message?: { role?: unknown; content?: unknown }; content?: unknown }
      const role = record.message?.role ?? record.role ?? record.type
      if (role !== 'assistant') break
      const text = collectText(record.message?.content ?? record.content).join('\n')
      if (text.trim().length > 0) trailing.unshift(text)
    }
    const reply = trailing.join('\n').trim()
    return reply.length > 0 ? reply.slice(-MAX_REPLY_CHARS) : undefined
  } catch (err) {
    console.error('[studio/hooks/stopHookTranscript] could not read the transcript — continuing without the reply:', err)
    return undefined
  }
}
