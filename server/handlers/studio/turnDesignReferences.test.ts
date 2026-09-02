import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { resolveDesignReference } from '../../ai/mcp/tools/studio/referenceResolve'
import { listDesignReferences } from './designReferenceStore'
import { CHAT_ATTACHMENT_REFERENCE_SOURCE, registerTurnDesignReferences } from './turnDesignReferences'

async function png(width: number, height: number, rgb: [number, number, number]): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    raw[i * 3] = rgb[0]
    raw[i * 3 + 1] = rgb[1]
    raw[i * 3 + 2] = rgb[2]
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer())
}

describe('registerTurnDesignReferences', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-turn-refs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('arms an attached image so studio_compare has something to measure against', async () => {
    // The whole point: before this, a design pasted into chat left
    // `.studio/references/` empty and `studio_compare` answered "there is no
    // design reference registered", so nothing was ever measured.
    const armed = await registerTurnDesignReferences(dir, [await png(40, 20, [12, 154, 176])])

    expect(armed).toHaveLength(1)
    expect(armed[0]!.width).toBe(40)
    expect(armed[0]!.height).toBe(20)
    expect(armed[0]!.source).toBe(CHAT_ATTACHMENT_REFERENCE_SOURCE)
    expect(listDesignReferences(dir, undefined, undefined).references).toHaveLength(1)
  })

  it('is idempotent by content hash across turns', async () => {
    // This runs on EVERY turn and a conversation re-sends its attachments.
    // Registering unconditionally would write one copy of the same comp per
    // turn and keep re-pointing `studio_compare`'s most-recent fallback at a
    // fresh duplicate.
    const bytes = await png(40, 20, [12, 154, 176])

    const first = await registerTurnDesignReferences(dir, [bytes])
    const second = await registerTurnDesignReferences(dir, [bytes])
    const third = await registerTurnDesignReferences(dir, [bytes])

    expect(second[0]!.id).toBe(first[0]!.id)
    expect(third[0]!.id).toBe(first[0]!.id)
    expect(listDesignReferences(dir, undefined, undefined).references).toHaveLength(1)
  })

  it('registers genuinely different attachments separately', async () => {
    const armed = await registerTurnDesignReferences(dir, [
      await png(40, 20, [12, 154, 176]),
      await png(40, 20, [239, 69, 80]),
    ])

    expect(armed).toHaveLength(2)
    expect(armed[0]!.id).not.toBe(armed[1]!.id)
    expect(armed.map((r) => r.label)).toEqual(['Attached in chat (1)', 'Attached in chat (2)'])
  })

  it('drops an unusable attachment without failing the turn', async () => {
    // Arming is a convenience, not a precondition — an SVG (which the store
    // refuses, having no fixed pixel size to diff against) or a corrupt
    // upload must not stop the user's actual request from running.
    const armed = await registerTurnDesignReferences(dir, [
      new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')),
      await png(10, 10, [0, 0, 0]),
    ])

    expect(armed).toHaveLength(1)
    expect(armed[0]!.width).toBe(10)
  })

  it('does nothing at all for a turn with no attachments', async () => {
    expect(await registerTurnDesignReferences(dir, [])).toEqual([])
    expect(listDesignReferences(dir, undefined, undefined).references).toHaveLength(0)
  })

  it('scopes a pasted reference to the active page, so two screens pasted in one conversation each resolve their own', async () => {
    // The flagship bug: before threading `pageId`, every pasted reference
    // registered unscoped and could never win `resolveDesignReference`'s
    // "this page's own" branch — so pasting screen 2's comp anywhere later in
    // the SAME conversation silently redirected every future comparison for
    // screen 1 onto screen 2's design.
    const pageA = await registerTurnDesignReferences(
      dir,
      [await png(40, 20, [12, 154, 176])],
      'page-a',
    )
    const pageB = await registerTurnDesignReferences(
      dir,
      [await png(30, 30, [239, 69, 80])],
      'page-b',
    )

    const resolvedA = resolveDesignReference(dir, 'page-a', undefined)
    const resolvedB = resolveDesignReference(dir, 'page-b', undefined)

    expect(resolvedA.ok && resolvedA.reference.id).toBe(pageA[0]!.id)
    expect(resolvedB.ok && resolvedB.reference.id).toBe(pageB[0]!.id)
    // Each page's own reference wins over the other page's — not just over
    // "most recent project-wide", which would have passed even with the bug.
    expect(resolvedA.ok && resolvedA.reference.id).not.toBe(pageB[0]!.id)
  })

  it('registers unscoped when no pageId is threaded, degrading to the pre-fix fallback rather than guessing', async () => {
    const armed = await registerTurnDesignReferences(dir, [await png(40, 20, [12, 154, 176])])

    expect(armed[0]!.pageId).toBeUndefined()
  })
})
