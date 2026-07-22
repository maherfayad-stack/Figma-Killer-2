/**
 * inPlaceInspector — pure-function tests for the mini-inspector's schema
 * filtering. `visibleInspectorControls` is fully deterministic (no DOM, no
 * store) and mirrors the exact filtering `renderModuleTabContent` applies
 * before handing a schema entry to `PropertyControlRenderer`: drop `hidden`
 * controls, drop controls whose `condition` doesn't match current props.
 * Rendering/geometry/anchoring is a human dogfood — not covered here.
 */
import { describe, it, expect } from 'bun:test'
import { visibleInspectorControls } from '@site/canvas/InPlaceInspector/visibleInspectorControls'
import type { PropertySchema } from '@core/module-engine'

describe('visibleInspectorControls', () => {
  it('returns every entry when none are hidden or conditional', () => {
    const schema: PropertySchema = {
      label: { type: 'text', label: 'Label' },
      size: {
        type: 'select',
        label: 'Size',
        options: [{ label: 'Small', value: 'sm' }],
      },
    }
    const result = visibleInspectorControls(schema, {})
    expect(result.map(([key]) => key)).toEqual(['label', 'size'])
  })

  it('drops controls with hidden: true', () => {
    const schema: PropertySchema = {
      label: { type: 'text', label: 'Label' },
      internal: { type: 'text', label: 'Internal', hidden: true },
    }
    const result = visibleInspectorControls(schema, {})
    expect(result.map(([key]) => key)).toEqual(['label'])
  })

  it('drops a control whose condition does not match current props', () => {
    const schema: PropertySchema = {
      variant: {
        type: 'select',
        label: 'Variant',
        options: [{ label: 'Icon', value: 'icon' }],
      },
      iconName: {
        type: 'text',
        label: 'Icon name',
        condition: { field: 'variant', eq: 'icon' },
      },
    }

    const hidden = visibleInspectorControls(schema, { variant: 'text' })
    expect(hidden.map(([key]) => key)).toEqual(['variant'])

    const shown = visibleInspectorControls(schema, { variant: 'icon' })
    expect(shown.map(([key]) => key)).toEqual(['variant', 'iconName'])
  })

  it('evaluates a compound (and/or) condition', () => {
    const schema: PropertySchema = {
      mode: { type: 'text', label: 'Mode' },
      count: { type: 'number', label: 'Count' },
      advanced: {
        type: 'toggle',
        label: 'Advanced',
        condition: {
          and: [
            { field: 'mode', notEq: 'simple' },
            { field: 'count', in: [2, 3] },
          ],
        },
      },
    }

    expect(
      visibleInspectorControls(schema, { mode: 'complex', count: 3 }).map(([key]) => key),
    ).toEqual(['mode', 'count', 'advanced'])

    expect(
      visibleInspectorControls(schema, { mode: 'simple', count: 3 }).map(([key]) => key),
    ).toEqual(['mode', 'count'])
  })

  it('returns an empty array for an empty schema', () => {
    expect(visibleInspectorControls({}, {})).toEqual([])
  })
})
