/**
 * keyframes codemod — the `@keyframes`-scoped writers and their refusal.
 *
 * The bar every test here holds is the one `setDeclaration.test.ts` holds for
 * the top-level scope: an edit changes the bytes it was asked to change and
 * NOTHING else. A `@keyframes` body in a real repository is hand-authored
 * text — comments, blank lines, a step order chosen for readability — and the
 * whole reason this is a CST codemod rather than a re-serialisation is that
 * all of it survives.
 */
import { describe, it, expect } from 'bun:test'
import {
  analyzeKeyframesTarget,
  insertKeyframes,
  keyframesNameFromSelector,
  readKeyframeSteps,
  removeDeclarationAtKeyframe,
  setDeclarationAtKeyframe,
} from '../keyframes'

const MULTI_STEP = `.card {
  color: red;
}

@keyframes fade-in {
  /* the interesting half */
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  50% {
    opacity: 0.5;
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`

describe('keyframesNameFromSelector', () => {
  it('reads the name out of both spellings the importer produces', () => {
    expect(keyframesNameFromSelector('@keyframes fade-in')).toBe('fade-in')
    expect(keyframesNameFromSelector('@-webkit-keyframes fade-in')).toBe('fade-in')
    expect(keyframesNameFromSelector('  @keyframes  spin  ')).toBe('spin')
  })

  it('is null for anything that is not a keyframes prelude', () => {
    expect(keyframesNameFromSelector('.card')).toBeNull()
    expect(keyframesNameFromSelector('@media (min-width: 40em)')).toBeNull()
    expect(keyframesNameFromSelector('@keyframes')).toBeNull()
  })
})

describe('readKeyframeSteps', () => {
  it('returns every step in source order, with its declarations as authored', () => {
    const steps = readKeyframeSteps(MULTI_STEP, 'fade-in')
    expect(steps).not.toBeNull()
    expect(steps!.map((step) => step.keyText)).toEqual(['from', '50%', 'to'])
    expect(steps![0]!.declarations).toEqual({ opacity: '0', transform: 'translateY(8px)' })
    expect(steps![1]!.declarations).toEqual({ opacity: '0.5' })
  })

  it('is null for a name the file does not declare', () => {
    expect(readKeyframeSteps(MULTI_STEP, 'spin')).toBeNull()
  })

  it('is null rather than a throw for unparseable text', () => {
    expect(readKeyframeSteps('@keyframes fade-in { from {', 'fade-in')).toBeNull()
  })

  it('finds a vendor-prefixed block, because it is the same animation', () => {
    const steps = readKeyframeSteps('@-webkit-keyframes spin { to { transform: rotate(1turn); } }', 'spin')
    expect(steps).toHaveLength(1)
    expect(steps![0]!.declarations).toEqual({ transform: 'rotate(1turn)' })
  })
})

describe('setDeclarationAtKeyframe', () => {
  it('changes one declaration in one step and leaves every other byte alone', () => {
    const result = setDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '50%', 'opacity', '0.8')
    expect(result.changed).toBe(true)
    expect(result.css).toContain('opacity: 0.8')
    // Sibling steps, the sibling rule, the comment, and the blank lines all survive.
    expect(result.css).toContain('/* the interesting half */')
    expect(result.css).toContain('transform: translateY(8px)')
    expect(result.css).toContain('.card {\n  color: red;\n}')
    expect(result.css.split('opacity').length).toBe(MULTI_STEP.split('opacity').length)
  })

  it('appends a declaration a step does not have yet', () => {
    const result = setDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '50%', 'transform', 'scale(1.1)')
    expect(result.changed).toBe(true)
    const steps = readKeyframeSteps(result.css, 'fade-in')!
    expect(steps[1]!.declarations).toEqual({ opacity: '0.5', transform: 'scale(1.1)' })
  })

  it('creates a step the block does not have yet', () => {
    const result = setDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '25%', 'opacity', '0.25')
    expect(result.changed).toBe(true)
    const steps = readKeyframeSteps(result.css, 'fade-in')!
    expect(steps.map((step) => step.keyText)).toEqual(['from', '50%', 'to', '25%'])
  })

  it('creates the whole block when the file has no such animation', () => {
    const result = setDeclarationAtKeyframe('.card { color: red; }', 'spin', 'to', 'transform', 'rotate(1turn)')
    expect(result.changed).toBe(true)
    expect(result.css).toContain('.card { color: red; }')
    expect(readKeyframeSteps(result.css, 'spin')).toEqual([
      { keyText: 'to', declarations: { transform: 'rotate(1turn)' } },
    ])
  })

  it('matches a step case- and whitespace-insensitively without rewriting how it was authored', () => {
    const css = '@keyframes fade-in {\n  FROM { opacity: 0; }\n}'
    const result = setDeclarationAtKeyframe(css, 'fade-in', 'from', 'opacity', '0.1')
    expect(result.changed).toBe(true)
    expect(result.css).toContain('FROM')
    expect(readKeyframeSteps(result.css, 'fade-in')![0]!.declarations).toEqual({ opacity: '0.1' })
  })

  it('is a no-op when the value is already in place', () => {
    const result = setDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '50%', 'opacity', '0.5')
    expect(result.changed).toBe(false)
    expect(result.css).toBe(MULTI_STEP)
  })
})

describe('removeDeclarationAtKeyframe', () => {
  it('removes one declaration and keeps the step', () => {
    const result = removeDeclarationAtKeyframe(MULTI_STEP, 'fade-in', 'from', 'transform')
    expect(result.changed).toBe(true)
    expect(readKeyframeSteps(result.css, 'fade-in')![0]!.declarations).toEqual({ opacity: '0' })
  })

  it('removes a step it empties', () => {
    const result = removeDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '50%', 'opacity')
    expect(result.changed).toBe(true)
    expect(readKeyframeSteps(result.css, 'fade-in')!.map((step) => step.keyText)).toEqual(['from', 'to'])
  })

  it('removes the block when the last step goes with it', () => {
    const css = '@keyframes spin {\n  to { transform: rotate(1turn); }\n}\n'
    const result = removeDeclarationAtKeyframe(css, 'spin', 'to', 'transform')
    expect(result.changed).toBe(true)
    expect(result.css.trim()).toBe('')
  })

  it('is a no-op for an absent block, step, or declaration', () => {
    expect(removeDeclarationAtKeyframe(MULTI_STEP, 'spin', 'to', 'opacity').changed).toBe(false)
    expect(removeDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '75%', 'opacity').changed).toBe(false)
    expect(removeDeclarationAtKeyframe(MULTI_STEP, 'fade-in', '50%', 'color').changed).toBe(false)
  })
})

describe('insertKeyframes', () => {
  it('appends a whole new block, separated from what precedes it', () => {
    const result = insertKeyframes('.card { color: red; }', 'spin', [
      { keyText: 'from', declarations: { transform: 'rotate(0)' } },
      { keyText: 'to', declarations: { transform: 'rotate(1turn)' } },
    ])
    expect(result.changed).toBe(true)
    expect(result.css).toContain('.card { color: red; }')
    expect(readKeyframeSteps(result.css, 'spin')).toEqual([
      { keyText: 'from', declarations: { transform: 'rotate(0)' } },
      { keyText: 'to', declarations: { transform: 'rotate(1turn)' } },
    ])
  })

  it('MERGES into an existing block of the same name rather than shadowing it', () => {
    const result = insertKeyframes(MULTI_STEP, 'fade-in', [
      { keyText: '50%', declarations: { opacity: '0.6' } },
      { keyText: '75%', declarations: { opacity: '0.9' } },
    ])
    expect(result.changed).toBe(true)
    // One block, not two — the second would win entirely and the first would
    // become dead text.
    expect(result.css.match(/@keyframes fade-in/g)).toHaveLength(1)
    const steps = readKeyframeSteps(result.css, 'fade-in')!
    expect(steps.map((step) => step.keyText)).toEqual(['from', '50%', 'to', '75%'])
    expect(steps[1]!.declarations).toEqual({ opacity: '0.6' })
    // A step the caller did not mention is untouched.
    expect(steps[0]!.declarations).toEqual({ opacity: '0', transform: 'translateY(8px)' })
  })

  it('converges — inserting the same block twice changes nothing the second time', () => {
    const steps = [{ keyText: 'to', declarations: { opacity: '1' } }]
    const once = insertKeyframes('', 'fade', steps)
    const twice = insertKeyframes(once.css, 'fade', steps)
    expect(twice.changed).toBe(false)
    expect(twice.css).toBe(once.css)
  })
})

describe('analyzeKeyframesTarget — the refusal', () => {
  it('accepts a name declared once', () => {
    expect(analyzeKeyframesTarget(MULTI_STEP, 'fade-in')).toEqual({ ok: true })
  })

  it('accepts a name declared not at all — the writers create it', () => {
    expect(analyzeKeyframesTarget(MULTI_STEP, 'spin')).toEqual({ ok: true })
  })

  it('REFUSES a name declared twice, because the last block wins entirely', () => {
    const duplicated = `${MULTI_STEP}\n@keyframes fade-in { to { opacity: 1; } }`
    const analysis = analyzeKeyframesTarget(duplicated, 'fade-in')
    expect(analysis.ok).toBe(false)
    if (analysis.ok) throw new Error('expected a refusal')
    expect(analysis.refusal.reason).toBe('duplicate-keyframes')
    expect(analysis.refusal.message).toContain('2 times')
  })

  it('counts a vendor-prefixed twin as a duplicate — writing one of two is the hazard', () => {
    const prefixed = `${MULTI_STEP}\n@-webkit-keyframes fade-in { to { opacity: 1; } }`
    expect(analyzeKeyframesTarget(prefixed, 'fade-in').ok).toBe(false)
  })
})
