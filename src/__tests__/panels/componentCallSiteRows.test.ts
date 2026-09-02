/**
 * componentCallSiteRows — E2.5's catalog-driven Component-section row set.
 * Pure-function tests (no React, no store) for the three behaviors the work
 * order calls out explicitly:
 *   1. A declared-but-unset prop still gets a row.
 *   2. A named union-alias (`enum` PropKind) renders a `select`, not `text`.
 *   3. A declared `node`-kind (slot) prop with no call-site value gets a
 *      `slot`-type row (the panel's way of learning a slot exists — E1's
 *      catalog, never a phantom placeholder node).
 */
import { describe, expect, it } from 'bun:test'
import { buildComponentCallSiteRows } from '@site/panels/PropertiesPanel/componentCallSiteRows'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { studioSlotValue } from '@core/utils/studioSlotSentinel'

const cardSpec: LocalComponentSpec = {
  name: 'Card',
  file: 'src/components/Card.tsx',
  exportName: 'default',
  isDefaultExport: true,
  props: [
    { name: 'title', kind: { kind: 'string' }, required: true },
    { name: 'variant', kind: { kind: 'enum', values: ['primary', 'ghost'] }, required: false },
    { name: 'header', kind: { kind: 'node' }, required: false },
  ],
}

describe('buildComponentCallSiteRows', () => {
  it('gives a declared prop a row even when the call site never passes it', () => {
    const rows = buildComponentCallSiteRows(cardSpec, { title: 'Hello' })
    const variantRow = rows.find((r) => r.key === 'variant')
    expect(variantRow).toBeDefined()
    expect(variantRow?.value).toBeUndefined()
  })

  it('renders a named union alias (enum PropKind) as a select, not a text box', () => {
    const rows = buildComponentCallSiteRows(cardSpec, {})
    const variantRow = rows.find((r) => r.key === 'variant')
    expect(variantRow?.control).toEqual({
      type: 'select',
      label: 'variant',
      options: [
        { label: 'primary', value: 'primary' },
        { label: 'ghost', value: 'ghost' },
      ],
    })
  })

  it('gives a declared, unfilled slot prop a slot-type row — offered, not a phantom node', () => {
    const rows = buildComponentCallSiteRows(cardSpec, {})
    const headerRow = rows.find((r) => r.key === 'header')
    expect(headerRow?.control).toEqual({ type: 'slot', label: 'header' })
    expect(headerRow?.value).toBeUndefined()
  })

  it('a filled slot prop carries the real sentinel value through unchanged', () => {
    const sentinel = studioSlotValue('pages/Home.tsx:9:11')
    const rows = buildComponentCallSiteRows(cardSpec, { header: sentinel })
    const headerRow = rows.find((r) => r.key === 'header')
    expect(headerRow?.value).toBe(sentinel)
  })

  it('still shows a prop the call site passes but the catalog does not declare (JS fallback / spread)', () => {
    const rows = buildComponentCallSiteRows(cardSpec, { title: 'Hello', extra: 'surprise' })
    const extraRow = rows.find((r) => r.key === 'extra')
    expect(extraRow).toBeDefined()
    expect(extraRow?.control).toEqual({ type: 'text', label: 'extra' })
  })

  it('falls back to only the currently-set props when no catalog spec is found', () => {
    const rows = buildComponentCallSiteRows(null, { title: 'Hello' })
    expect(rows).toEqual([{ key: 'title', control: { type: 'text', label: 'title' }, value: 'Hello' }])
  })
})
