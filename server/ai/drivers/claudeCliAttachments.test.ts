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
})
