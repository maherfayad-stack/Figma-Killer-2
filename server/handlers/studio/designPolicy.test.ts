import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_DESIGN_POLICY,
  DESIGN_SYSTEM_FINDING_CODES,
  asDesignPolicy,
  findingSeverity,
  resolveDesignPolicy,
} from './designPolicy'
import type { QualityFindingCode } from './qualityAudit'

describe('resolveDesignPolicy', () => {
  it('an explicit tool argument outranks everything', () => {
    expect(resolveDesignPolicy({ toolArg: 'free', turn: 'follow', project: 'follow' }))
      .toEqual({ policy: 'free', source: 'tool-arg' })
  })

  it('the turn outranks the project default', () => {
    expect(resolveDesignPolicy({ turn: 'follow', project: 'free' }))
      .toEqual({ policy: 'follow', source: 'turn' })
  })

  it('the project default answers when the turn carries nothing', () => {
    expect(resolveDesignPolicy({ project: 'free' })).toEqual({ policy: 'free', source: 'project' })
  })

  it('defaults to balanced — never to follow (refuses work nobody asked it to) or free (a loosening the server may not do on its own)', () => {
    expect(resolveDesignPolicy({})).toEqual({ policy: DEFAULT_DESIGN_POLICY, source: 'default' })
    expect(DEFAULT_DESIGN_POLICY).toBe('balanced')
  })
})

describe('asDesignPolicy', () => {
  it('narrows a known literal and rejects everything else', () => {
    expect(asDesignPolicy('follow')).toBe('follow')
    expect(asDesignPolicy('strict')).toBeUndefined()
    expect(asDesignPolicy(3)).toBeUndefined()
    expect(asDesignPolicy(null)).toBeUndefined()
  })
})

describe('findingSeverity', () => {
  it('follow makes every design-system finding an error', () => {
    for (const code of DESIGN_SYSTEM_FINDING_CODES) {
      expect(findingSeverity(code, 'follow')).toBe('error')
    }
  })

  it('balanced makes the same set warnings', () => {
    for (const code of DESIGN_SYSTEM_FINDING_CODES) {
      expect(findingSeverity(code, 'balanced')).toBe('warning')
    }
  })

  it('free turns the same set off entirely', () => {
    for (const code of DESIGN_SYSTEM_FINDING_CODES) {
      expect(findingSeverity(code, 'free')).toBe('off')
    }
  })

  it('never turns off a correctness or composition finding at any policy', () => {
    const alwaysErrors: QualityFindingCode[] = [
      'low-contrast-pair',
      'font-not-available',
      'unresolved-asset-import',
      'hand-authored-vector-path',
      'hardcoded-inline-sizing',
      'flat-type-hierarchy',
      'monotone-band-rhythm',
      'no-focal-point',
    ]
    for (const code of alwaysErrors) {
      expect(findingSeverity(code, 'follow')).toBe('error')
      expect(findingSeverity(code, 'balanced')).toBe('error')
      expect(findingSeverity(code, 'free')).toBe('error')
    }
  })
})
