import { describe, expect, test } from 'bun:test'
import { applyPrototypeOp, type PrototypeOp } from '../prototypeStore'

/** A link as an older build wrote it: a bare "click" trigger and an `origin` the reader repairs or drops. */
const LEGACY = `{
  "version": 1,
  "links": [
    {
      "id": "legacy",
      "origin": "design",
      "source": {
        "pageId": "a",
        "node": {
          "nodeId": "pages/A.tsx:3:7",
          "indexPath": [
            0
          ],
          "moduleId": "base.text",
          "textSnippet": "A"
        }
      },
      "trigger": "click",
      "action": "navigate",
      "targetPageId": "b",
      "transition": "slide-left"
    }
  ]
}
`

const NEW_LINK = {
  id: 'new',
  source: { pageId: 'b', node: { nodeId: 'pages/B.tsx:3:7', indexPath: [0], moduleId: 'base.text', textSnippet: 'B' } },
  trigger: { kind: 'click' as const },
  action: 'navigate' as const,
  targetPageId: 'a',
  transition: 'slide-left' as const,
}

function apply(stored: string | null, op: PrototypeOp) {
  const result = applyPrototypeOp(stored, op)
  if (!result.ok) throw new Error(result.error)
  return result
}

describe('prototype link operations write only the link they name', () => {
  test('adding a link leaves every other entry byte for byte, and removing it restores the file', () => {
    const added = apply(LEGACY, { kind: 'upsert', link: NEW_LINK })
    expect(added.changed).toBe(true)
    expect(added.text.startsWith(LEGACY.slice(0, LEGACY.length - '\n  ]\n}\n'.length) + ',')).toBe(true)
    expect(added.file.links.map((link) => link.id)).toEqual(['legacy', 'new'])

    const removed = apply(added.text, { kind: 'remove', linkId: 'new' })
    expect(removed.text).toBe(LEGACY)
  })

  test('editing a link keeps the fields the editor does not model, and leaves its neighbours alone', () => {
    const withTwo = apply(LEGACY, { kind: 'upsert', link: NEW_LINK }).text
    const legacy = apply(withTwo, { kind: 'upsert', link: NEW_LINK }).file.links[0]!
    const edited = apply(withTwo, { kind: 'upsert', link: { ...legacy, action: 'overlay', transition: 'sheet' } })
    const links = JSON.parse(edited.text).links
    expect(links[0].origin).toBe('design')
    expect(links[0].action).toBe('overlay')
    // The other link is the same entry it was.
    expect(JSON.stringify(links[1])).toBe(JSON.stringify(JSON.parse(withTwo).links[1]))
  })

  test('an op that changes nothing reports unchanged and keeps the stored text', () => {
    const missing = apply(LEGACY, { kind: 'remove', linkId: 'nope' })
    expect(missing.changed).toBe(false)
    expect(missing.text).toBe(LEGACY)
    const absent = apply(null, { kind: 'remove', linkId: 'nope' })
    expect(absent.changed).toBe(false)
  })

  test('the first link makes the file', () => {
    const created = apply(null, { kind: 'upsert', link: NEW_LINK })
    expect(created.changed).toBe(true)
    expect(JSON.parse(created.text)).toEqual({ version: 1, links: [JSON.parse(JSON.stringify(NEW_LINK))] })
  })

  test('prune drops the links to missing pages and keeps an entry the reader cannot read', () => {
    const odd = LEGACY.replace('"links": [', '"links": [\n    { "hand": "written" },')
    const pruned = apply(odd, { kind: 'prune', pageIds: ['b'] })
    expect(pruned.file.links).toHaveLength(0)
    expect(pruned.text).toContain('"hand": "written"')
    expect(() => apply(odd, { kind: 'prune', pageIds: [] })).toThrow()
  })
})
