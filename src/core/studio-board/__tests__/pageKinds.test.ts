/**
 * pageKinds — the vocabulary the scaffold route, the MCP tool and the "New
 * page" menu all validate against.
 *
 * The one thing worth gating here is that there are TWO lists — the TypeBox
 * union that rejects a bad request, and the metadata table the menu renders —
 * and they must not drift. A kind present in the schema but missing from the
 * table is a request the server accepts and then throws on; a kind in the table
 * but not the schema is a menu item that 400s when clicked.
 */
import { describe, expect, it } from 'bun:test'
import { DEFAULT_PAGE_KIND, PAGE_KINDS, PageKindSchema, pageKindPreset } from '../pageKinds'

/** The literal values the schema accepts, read back off the union itself. */
const schemaKinds = PageKindSchema.anyOf.map((member) => member.const)

describe('PAGE_KINDS', () => {
  it('covers exactly the kinds the schema accepts', () => {
    expect([...PAGE_KINDS].map((preset) => preset.kind).sort()).toEqual([...schemaKinds].sort())
  })

  it('gives every kind a preset', () => {
    for (const kind of schemaKinds) {
      expect(pageKindPreset(kind).kind).toBe(kind)
    }
  })

  it('names the default kind as one the schema accepts', () => {
    expect(schemaKinds).toContain(DEFAULT_PAGE_KIND)
    // "New page" without a choice has always meant a screen, and changing that
    // would silently re-shape every scripted caller that omits the field.
    expect(DEFAULT_PAGE_KIND).toBe('screen')
  })

  it('offers the screen first, so the common case stays one keystroke away', () => {
    expect(PAGE_KINDS[0]!.kind).toBe('screen')
  })

  it('gives every kind a label and a usable name base', () => {
    for (const preset of PAGE_KINDS) {
      expect(preset.label.length).toBeGreaterThan(0)
      // The name base becomes a component/file name, so it has to be a valid
      // JS identifier: `nextPageName` appends a digit to it and the result is
      // written straight into `export default function <name>()`.
      expect(preset.nameBase).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
    }
  })

  it('keeps typographic punctuation out of every label', () => {
    // The two sheets used to read "Bottom sheet — small"/"— big". An em dash
    // in a menu label is a character nobody can type, so it is unsearchable
    // and unspeakable, and at menu size it is hard to tell from a hyphen or a
    // minus. Whatever distinguishes two rows has to survive being read aloud.
    // En dash and the smart quotes are here for the same reason, not because
    // they have appeared yet.
    for (const preset of PAGE_KINDS) {
      expect(preset.label).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d]/)
    }
  })

  it('names the two sheets so a chooser can tell them apart', () => {
    const sheets = PAGE_KINDS.filter((preset) => preset.kind.startsWith('sheet-'))
    expect(sheets).toHaveLength(2)
    expect(sheets[0]!.label).not.toBe(sheets[1]!.label)
    // They share a name base on purpose — "small" and "large" is a fact about
    // the drawing, not about what the screen is called.
    expect(sheets[0]!.nameBase).toBe(sheets[1]!.nameBase)
  })
})
