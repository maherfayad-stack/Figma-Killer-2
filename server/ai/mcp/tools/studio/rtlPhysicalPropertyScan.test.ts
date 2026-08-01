import { describe, expect, it } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { findPhysicalPropertiesOnNode } from './rtlPhysicalPropertyScan'

function rule(styles: Record<string, unknown>, contextStyles: Record<string, Record<string, unknown>> = {}): StyleRule {
  return {
    id: 'r1',
    kind: 'class',
    name: 'hero',
    selector: '.hero',
    order: 0,
    styles,
    contextStyles,
    createdAt: 0,
    updatedAt: 0,
  } as StyleRule
}

describe('findPhysicalPropertiesOnNode', () => {
  it('finds a physical property by name', () => {
    const styleRules = { r1: rule({ marginLeft: '8px' }) }
    expect(findPhysicalPropertiesOnNode(['r1'], styleRules)).toEqual(['margin-left'])
  })

  it('finds a physical VALUE on a directionally-neutral property', () => {
    const styleRules = { r1: rule({ textAlign: 'left' }) }
    expect(findPhysicalPropertiesOnNode(['r1'], styleRules)).toEqual(['text-align: left'])
  })

  it('does not flag a logical property or a neutral value', () => {
    const styleRules = { r1: rule({ marginInlineStart: '8px', textAlign: 'center' }) }
    expect(findPhysicalPropertiesOnNode(['r1'], styleRules)).toEqual([])
  })

  it('scans contextStyles overrides too, not just the base declarations', () => {
    const styleRules = { r1: rule({}, { desktop: { paddingRight: '4px' } }) }
    expect(findPhysicalPropertiesOnNode(['r1'], styleRules)).toEqual(['padding-right'])
  })

  it('dedupes across multiple assigned rules', () => {
    const styleRules = {
      r1: rule({ marginLeft: '8px' }),
      r2: rule({ marginLeft: '4px' }),
    }
    expect(findPhysicalPropertiesOnNode(['r1', 'r2'], styleRules)).toEqual(['margin-left'])
  })

  it('ignores a classId with no matching rule', () => {
    expect(findPhysicalPropertiesOnNode(['missing'], {})).toEqual([])
  })
})
