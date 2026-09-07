/**
 * `resolveDesignReference`'s precedence, and the refusals that replaced its
 * old "most recently registered wins" tie-break.
 *
 * Every case here is a shape that actually occurred in this repo's own `test4`
 * workspace, whose manifest is what surfaced the bug: three Figma frames
 * registered by URL and scoped to their pages, then a run of chat crops
 * registered against `sms` while the user asked questions about it. Under the
 * old rule the newest crop won and `studio_compare` refused on aspect ratio
 * forever; the page's real 375x800 design was still on disk and unreachable.
 *
 * The manifest is written directly rather than through
 * `registerDesignReference`, because the point of most of these tests is the
 * shape of an entry the store did NOT write — a legacy row with no `role` —
 * and because it keeps the fixtures readable next to the assertions they
 * drive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHAT_ATTACHMENT_REFERENCE_SOURCE,
  type DesignReference,
} from '../../../../handlers/studio/designReferenceSchema'
import { resolveDesignReference } from './referenceResolve'

let dir: string

/** A valid UUID v4 — `getDesignReference` pattern-checks ids before touching disk. */
function id(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

function reference(overrides: Partial<DesignReference> & { id: string }): DesignReference {
  return {
    ext: 'png',
    mimeType: 'image/png',
    width: 375,
    height: 800,
    sizeBytes: 1000,
    contentHash: `hash-${overrides.id}`,
    relPath: `.studio/references/${overrides.id}.png`,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function writeManifest(references: DesignReference[]): void {
  const refsDir = join(dir, '.studio', 'references')
  mkdirSync(refsDir, { recursive: true })
  writeFileSync(join(refsDir, 'manifest.json'), JSON.stringify({ version: 1, references }, null, 2))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w91a-reference-resolve-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveDesignReference — precedence', () => {
  it('an explicit referenceId beats everything, including a context image', () => {
    // The explicit gesture: naming an id is how a chat attachment becomes the
    // spec for a call, which is what every ambiguity refusal points at.
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'spec' }),
      reference({ id: id(2), pageId: 'sms', role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', id(2))

    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.reference.id).toBe(id(2))
    expect(resolved.ok && resolved.implicit).toBe(false)
    expect(resolved.ok && resolved.role).toBe('context')
  })

  it('a page-scoped spec wins over a newer chat attachment on the same page', () => {
    // THE bug, reduced: test4's sms page, its 375x800 Figma frame registered
    // days before a 943x294 crop. "Most recently registered" picked the crop.
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'spec', source: 'https://figma.com/design/x?node-id=2-2176' }),
      reference({
        id: id(2),
        pageId: 'sms',
        width: 943,
        height: 294,
        role: 'context',
        source: CHAT_ATTACHMENT_REFERENCE_SOURCE,
        createdAt: '2026-09-03T07:07:43.629Z',
      }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.reference.id).toBe(id(1))
    expect(resolved.ok && resolved.role).toBe('spec')
  })

  it('an UNSCOPED spec still beats a page-scoped chat attachment — role outranks page scope', () => {
    // The composer's DESIGN REFERENCE control registers unscoped by design.
    // Losing to a crop that happens to name the page would make the deliberate
    // control the weaker of the two ways to supply a design.
    writeManifest([
      reference({ id: id(1), role: 'spec', label: 'hero.png' }),
      reference({ id: id(2), pageId: 'sms', role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
    ])

    expect(resolveDesignReference(dir, 'sms', undefined).ok).toBe(true)
    const resolved = resolveDesignReference(dir, 'sms', undefined)
    expect(resolved.ok && resolved.reference.id).toBe(id(1))
  })

  it('a page-scoped spec beats an unscoped one', () => {
    writeManifest([
      reference({ id: id(1), role: 'spec' }),
      reference({ id: id(2), pageId: 'sms', role: 'spec' }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.reference.id).toBe(id(2))
  })

  it('a lone chat attachment is still the spec, so paste-and-build keeps working', () => {
    // Demoting attachments to `context` must not un-arm the ruler for the
    // flagship flow `registerTurnDesignReferences` exists to serve.
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.reference.id).toBe(id(1))
    expect(resolved.ok && resolved.role).toBe('context')
    expect(resolved.ok && resolved.implicit).toBe(true)
  })
})

describe('resolveDesignReference — refusals', () => {
  it('refuses a page with two equally-ranked specs, naming both ids and the argument that settles it', () => {
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'spec', label: 'SMS v1' }),
      reference({ id: id(2), pageId: 'sms', role: 'spec', label: 'SMS v2' }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain(id(1))
    expect(!resolved.ok && resolved.error).toContain(id(2))
    expect(!resolved.ok && resolved.error).toContain('referenceId')
  })

  it('refuses a page whose only candidates are several chat attachments, rather than picking the newest', () => {
    // The live shape in test4: three crops on `sms`. Newest-wins is exactly
    // what shipped the wrong spec, and oldest-wins would fail the user who
    // pastes a corrected comp — so neither is a defensible tie-break.
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
      reference({ id: id(2), pageId: 'sms', width: 943, height: 294, role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
      reference({ id: id(3), pageId: 'sms', width: 501, height: 120, role: 'context', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain('943x294')
    expect(!resolved.ok && resolved.error).toContain('studio_register_design_reference')
  })

  it('refuses rather than reaching for another screen\'s design', () => {
    // The old project-wide "most recent" fallback is how screen 2's comp came
    // to be measured against screen 1.
    writeManifest([
      reference({ id: id(1), pageId: 'onboarding', role: 'spec' }),
      reference({ id: id(2), pageId: 'sign-up', role: 'spec' }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain('scoped to a different screen')
    expect(!resolved.ok && resolved.error).toContain('onboarding')
  })

  it('keeps the long "nothing registered at all" message, which is a different dead end', () => {
    writeManifest([])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain('no design reference registered for this project')
  })

  it('refuses an unknown explicit id instead of falling back to an implicit pick', () => {
    writeManifest([reference({ id: id(1), pageId: 'sms', role: 'spec' })])

    const resolved = resolveDesignReference(dir, 'sms', id(9))

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain('studio_list_design_references')
  })
})

describe('resolveDesignReference — manifests written before roles existed', () => {
  it('reads a legacy chat-attachment entry as context and a legacy Figma entry as spec', () => {
    // No `role` on either row — exactly what `.studio/references/manifest.json`
    // holds today in every existing workspace. No rewrite pass runs, so the
    // derivation from `source` is the whole migration.
    writeManifest([
      reference({
        id: id(1),
        pageId: 'sms',
        source: 'https://www.figma.com/design/xUc1yhOPDGa7xEDa0jPhcT/Untitled?node-id=2-2176',
        label: 'SMS — Figma',
      }),
      reference({
        id: id(2),
        pageId: 'sms',
        width: 943,
        height: 294,
        source: CHAT_ATTACHMENT_REFERENCE_SOURCE,
        label: 'Attached in chat',
      }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.reference.id).toBe(id(1))
    expect(resolved.ok && resolved.role).toBe('spec')
  })

  it('reads a legacy entry with no source at all as a spec — a bare register call was always deliberate', () => {
    writeManifest([reference({ id: id(1), pageId: 'sms' })])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.role).toBe('spec')
  })

  it('an explicit role on the entry overrides the source-based derivation', () => {
    // A chat attachment promoted durably (by a future "use as design
    // reference" action) keeps its `chat-attachment` provenance — the source
    // records how it arrived, the role records what it is.
    writeManifest([
      reference({ id: id(1), pageId: 'sms', role: 'spec', source: CHAT_ATTACHMENT_REFERENCE_SOURCE }),
      reference({ id: id(2), pageId: 'sms', role: 'context', source: 'https://figma.com/design/x' }),
    ])

    const resolved = resolveDesignReference(dir, 'sms', undefined)

    expect(resolved.ok && resolved.reference.id).toBe(id(1))
  })
})
