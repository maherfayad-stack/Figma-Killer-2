/**
 * The prototype op layer: what each operation does to the file, and the two
 * requests the server refuses outright.
 */
import { describe, it, expect } from 'bun:test'
import { applyPrototypeOp, type PrototypeOp } from '../../../server/handlers/studio/prototypeStore'
import { createPrototypeFile, upsertPrototypeLink, type PrototypeFile, type PrototypeLink } from '@core/studio-prototype'

function link(overrides: Partial<PrototypeLink> = {}): PrototypeLink {
  return {
    id: 'link-1',
    origin: 'design',
    source: {
      pageId: 'welcome',
      node: { nodeId: 'Welcome.tsx:12:4', indexPath: [0], moduleId: 'base.button', textSnippet: 'Continue' },
    },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'sign-in',
    transition: 'slide-left',
    ...overrides,
  }
}

function fileWith(...links: PrototypeLink[]): PrototypeFile {
  return links.reduce(upsertPrototypeLink, createPrototypeFile())
}

function apply(file: PrototypeFile, op: PrototypeOp) {
  return applyPrototypeOp(file, op)
}

describe('upsert', () => {
  it('adds a link, then replaces it by id', () => {
    const added = apply(createPrototypeFile(), { kind: 'upsert', link: link() })
    expect(added.ok && added.file.links).toHaveLength(1)

    const replaced = apply(added.ok ? added.file : createPrototypeFile(), {
      kind: 'upsert',
      link: link({ targetPageId: 'otp' }),
    })
    expect(replaced.ok && replaced.file.links).toHaveLength(1)
    expect(replaced.ok && replaced.file.links[0]!.targetPageId).toBe('otp')
  })

  it('normalizes on the way in, so a repairable request is stored repaired', () => {
    // The reader would fix this on the next load anyway; fixing it at the write
    // means the file on disk is never in a shape something has to repair.
    const result = apply(createPrototypeFile(), {
      kind: 'upsert',
      link: link({ transition: 'sheet' }),
    })
    expect(result.ok && result.file.links[0]!.transition).toBe('instant')
  })

  it('refuses a link that could only be stored by inventing a destination', () => {
    const result = apply(createPrototypeFile(), {
      kind: 'upsert',
      link: link({ targetPageId: null }),
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.status).toBe(400)
  })
})

describe('remove', () => {
  it('removes by id', () => {
    const result = apply(fileWith(link()), { kind: 'remove', linkId: 'link-1' })
    expect(result.ok && result.file.links).toHaveLength(0)
    expect(result.ok && result.changed).toBe(true)
  })

  it('reports changed:false for an id that is already gone, so nothing is rewritten', () => {
    const result = apply(fileWith(link()), { kind: 'remove', linkId: 'nope' })
    expect(result.ok && result.changed).toBe(false)
  })
})

describe('prune', () => {
  it('drops links whose source or target page is gone', () => {
    const file = fileWith(link({ id: 'a' }), link({ id: 'b', targetPageId: 'deleted' }))
    const result = apply(file, { kind: 'prune', pageIds: ['welcome', 'sign-in'] })
    expect(result.ok && result.file.links.map((l) => l.id)).toEqual(['a'])
  })

  it('refuses an empty page list instead of wiping every flow', () => {
    // An empty list is indistinguishable from a caller whose pages failed to
    // load. Obeying it would delete the whole prototype.
    const result = apply(fileWith(link()), { kind: 'prune', pageIds: [] })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('still exist')
  })

  it('reports changed:false when there is nothing to prune', () => {
    const result = apply(fileWith(link()), { kind: 'prune', pageIds: ['welcome', 'sign-in'] })
    expect(result.ok && result.changed).toBe(false)
  })
})
