/**
 * claudeCliAttachments (WS-12 §5.3) — real filesystem, no fakes needed (this
 * module IS the filesystem primitive; a fake would just be testing the fake).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { stageAttachments, cleanupAttachments, describeAttachmentsForPrompt } from './claudeCliAttachments'
import type { AiContentBlock } from '../runtime/types'

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('stageAttachments', () => {
  it('returns null and creates no directory when there are no image blocks', () => {
    const blocks: AiContentBlock[] = [{ kind: 'text', text: 'hello' }]
    expect(stageAttachments(blocks)).toBeNull()
  })

  it('stages one image block to a real file with the right extension', () => {
    const blocks: AiContentBlock[] = [
      { kind: 'text', text: 'look at this' },
      { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
    ]
    const staging = stageAttachments(blocks)
    try {
      expect(staging).not.toBeNull()
      expect(staging!.files).toHaveLength(1)
      expect(staging!.files[0]!.path).toMatch(/attachment-1\.png$/)
      expect(existsSync(staging!.files[0]!.path)).toBe(true)
      const written = readFileSync(staging!.files[0]!.path)
      expect(written.equals(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'))).toBe(true)
    } finally {
      if (staging) cleanupAttachments(staging.dir)
    }
  })

  it('stages multiple images, one file each, in order', () => {
    const blocks: AiContentBlock[] = [
      { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
      { kind: 'image', mimeType: 'image/jpeg', data: ONE_PIXEL_PNG_BASE64 },
    ]
    const staging = stageAttachments(blocks)
    try {
      expect(staging!.files).toHaveLength(2)
      expect(staging!.files[0]!.path).toMatch(/attachment-1\.png$/)
      expect(staging!.files[1]!.path).toMatch(/attachment-2\.jpg$/)
    } finally {
      if (staging) cleanupAttachments(staging.dir)
    }
  })

  it('cleanupAttachments removes the whole staging directory', () => {
    const blocks: AiContentBlock[] = [{ kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }]
    const staging = stageAttachments(blocks)!
    expect(existsSync(staging.dir)).toBe(true)
    cleanupAttachments(staging.dir)
    expect(existsSync(staging.dir)).toBe(false)
  })

  it('cleanupAttachments never throws for an already-removed directory', () => {
    const blocks: AiContentBlock[] = [{ kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }]
    const staging = stageAttachments(blocks)!
    cleanupAttachments(staging.dir)
    expect(() => cleanupAttachments(staging.dir)).not.toThrow()
  })

  it('describeAttachmentsForPrompt names every staged file by absolute path', () => {
    const blocks: AiContentBlock[] = [
      { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
      { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
    ]
    const staging = stageAttachments(blocks)!
    try {
      const description = describeAttachmentsForPrompt(staging)
      for (const file of staging.files) {
        expect(description).toContain(file.path)
      }
    } finally {
      cleanupAttachments(staging.dir)
    }
  })

  // WS-12 §5.3 follow-up — text-ish FILE attachments, reusing the same
  // `kind: 'image'` block shape (no new AiContentBlock kind), gated by an
  // explicit allow-list + size cap rather than staging anything handed to it.
  describe('text-ish file attachments (allow-list, size cap, refusal)', () => {
    const textToBase64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64')

    it('stages an allow-listed text-ish file, tagged kind "file"', () => {
      const blocks: AiContentBlock[] = [
        { kind: 'image', mimeType: 'text/markdown', data: textToBase64('# spec\n\nhello') },
      ]
      const staging = stageAttachments(blocks)!
      try {
        expect(staging.files).toHaveLength(1)
        expect(staging.files[0]!.kind).toBe('file')
        expect(staging.files[0]!.path).toMatch(/attachment-1\.md$/)
        expect(staging.refused).toHaveLength(0)
        expect(readFileSync(staging.files[0]!.path, 'utf-8')).toBe('# spec\n\nhello')
      } finally {
        cleanupAttachments(staging.dir)
      }
    })

    it('stages JSON and CSV and plain text, each with the right extension', () => {
      const blocks: AiContentBlock[] = [
        { kind: 'image', mimeType: 'application/json', data: textToBase64('{"a":1}') },
        { kind: 'image', mimeType: 'text/csv', data: textToBase64('a,b\n1,2') },
        { kind: 'image', mimeType: 'text/plain', data: textToBase64('plain') },
      ]
      const staging = stageAttachments(blocks)!
      try {
        expect(staging.files.map((f) => f.path.match(/\.(\w+)$/)![1])).toEqual(['json', 'csv', 'txt'])
        expect(staging.refused).toHaveLength(0)
      } finally {
        cleanupAttachments(staging.dir)
      }
    })

    it('refuses a mime type outside the allow-list, with a reason, and stages nothing for it', () => {
      const blocks: AiContentBlock[] = [
        { kind: 'image', mimeType: 'application/octet-stream', data: textToBase64('binary-ish') },
      ]
      const staging = stageAttachments(blocks)!
      expect(staging.files).toHaveLength(0)
      expect(staging.refused).toHaveLength(1)
      expect(staging.refused[0]!.mimeType).toBe('application/octet-stream')
      expect(staging.refused[0]!.reason).toContain('unsupported type')
      // Refusal-only staging must never leave a directory behind — nothing
      // was ever written, so there is nothing to clean up.
      expect(staging.dir).toBe('')
    })

    it('refuses a text-ish file over the size cap instead of staging it', () => {
      const huge = 'x'.repeat(300 * 1024) // over the 256 KiB cap
      const blocks: AiContentBlock[] = [{ kind: 'image', mimeType: 'text/plain', data: textToBase64(huge) }]
      const staging = stageAttachments(blocks)!
      expect(staging.files).toHaveLength(0)
      expect(staging.refused).toHaveLength(1)
      expect(staging.refused[0]!.reason).toContain('exceeds')
    })

    it('stages the allow-listed files and refuses the rest in the same turn, without losing either', () => {
      const blocks: AiContentBlock[] = [
        { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
        { kind: 'image', mimeType: 'text/markdown', data: textToBase64('notes') },
        { kind: 'image', mimeType: 'application/pdf', data: textToBase64('not really a pdf') },
      ]
      const staging = stageAttachments(blocks)!
      try {
        expect(staging.files).toHaveLength(2)
        expect(staging.files.map((f) => f.kind)).toEqual(['image', 'file'])
        expect(staging.refused).toHaveLength(1)
        expect(staging.refused[0]!.mimeType).toBe('application/pdf')
      } finally {
        cleanupAttachments(staging.dir)
      }
    })

    it('describeAttachmentsForPrompt separates image vs. file lines and surfaces refusals', () => {
      const blocks: AiContentBlock[] = [
        { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
        { kind: 'image', mimeType: 'text/markdown', data: textToBase64('notes') },
        { kind: 'image', mimeType: 'application/pdf', data: textToBase64('nope') },
      ]
      const staging = stageAttachments(blocks)!
      try {
        const description = describeAttachmentsForPrompt(staging)
        expect(description).toContain('Attached image file(s)')
        expect(description).toContain('Attached file(s)')
        expect(description).toContain('could not be staged')
        expect(description).toContain('application/pdf')
      } finally {
        cleanupAttachments(staging.dir)
      }
    })
  })
})
