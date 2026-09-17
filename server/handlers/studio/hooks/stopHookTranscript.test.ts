import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLastAssistantReply } from './stopHookTranscript'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-stop-transcript-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function transcript(lines: unknown[]): string {
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'))
  return file
}

describe('readLastAssistantReply', () => {
  it('reads the trailing assistant text', () => {
    const file = transcript([
      { type: 'user', message: { role: 'user', content: 'Build the hero.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'R1@y412 is deliberate.' }] } },
    ])
    expect(readLastAssistantReply(file)).toBe('R1@y412 is deliberate.')
  })

  it('joins a reply split across several assistant records', () => {
    const file = transcript([
      { type: 'user', message: { role: 'user', content: 'Build it.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First half.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second half.' }] } },
    ])
    expect(readLastAssistantReply(file)).toBe('First half.\nSecond half.')
  })

  it('never reaches back past the last user turn — a region named three turns ago was named about a different screen', () => {
    const file = transcript([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OLD REPLY' }] } },
      { type: 'user', message: { role: 'user', content: 'Now rewrite it.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'NEW REPLY' }] } },
    ])
    expect(readLastAssistantReply(file)).toBe('NEW REPLY')
  })

  it('accepts a bare string content and a bare role field', () => {
    const file = transcript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done' },
    ])
    expect(readLastAssistantReply(file)).toBe('done')
  })

  it('returns undefined for an absent path, an absent file, and a file with no assistant text', () => {
    expect(readLastAssistantReply(undefined)).toBeUndefined()
    expect(readLastAssistantReply(join(dir, 'nope.jsonl'))).toBeUndefined()
    expect(readLastAssistantReply(transcript([{ type: 'user', message: { role: 'user', content: 'hi' } }]))).toBeUndefined()
  })

  it('never throws on a malformed transcript', () => {
    const file = join(dir, 'bad.jsonl')
    writeFileSync(file, '{"type":"assistant"\nnot json at all\n')
    expect(() => readLastAssistantReply(file)).not.toThrow()
  })
})
