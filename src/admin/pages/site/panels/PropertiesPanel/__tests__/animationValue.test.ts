/**
 * animationValue / transitionValue — the Animations section's resolution
 * logic (W5-5).
 *
 * Two things are being defended here, and they pull in opposite directions.
 * The parser has to be GENEROUS enough to read real-world CSS — the shorthand
 * is order-independent, half of it is usually omitted, and a list can hold
 * several animations — and STRICT enough that anything it cannot fully account
 * for becomes a whole-value refusal rather than a partial read that silently
 * drops the part it did not understand. Every `raw`/`mixed` case below is the
 * second half doing its job.
 */
import { describe, it, expect } from 'bun:test'
import {
  ANIMATION_DEFAULTS,
  animationClearProperties,
  animationFieldPatch,
  animationRemovalPatch,
  resolveAnimations,
  serializeAnimation,
  serializeAnimations,
  splitTopLevelCommas,
} from '../animationValue'
import { resolveTransitions, transitionFieldPatch, transitionRemovalPatch } from '../transitionValue'

describe('splitTopLevelCommas', () => {
  it('splits between list items but not inside a function', () => {
    expect(splitTopLevelCommas('a 1s, b 2s')).toEqual(['a 1s', 'b 2s'])
    expect(splitTopLevelCommas('a 1s cubic-bezier(0, 0, 1, 1), b 2s')).toEqual([
      'a 1s cubic-bezier(0, 0, 1, 1)',
      'b 2s',
    ])
  })
})

describe('resolveAnimations — the shorthand', () => {
  it('is `none` for a rule with no motion at all', () => {
    expect(resolveAnimations({}).kind).toBe('none')
  })

  it('reads every component regardless of the order they were written in', () => {
    const source = resolveAnimations({ animation: '300ms ease-out 100ms 2 alternate both paused fade-in' })
    expect(source.kind).toBe('shorthand')
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.animations[0]).toEqual({
      name: 'fade-in',
      duration: '300ms',
      timingFunction: 'ease-out',
      delay: '100ms',
      iterationCount: '2',
      direction: 'alternate',
      fillMode: 'both',
      playState: 'paused',
    })
  })

  it('defaults every component the shorthand omits', () => {
    const source = resolveAnimations({ animation: 'fade-in 300ms' })
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.animations[0]).toEqual({ ...ANIMATION_DEFAULTS, name: 'fade-in', duration: '300ms' })
  })

  it('reads the FIRST time as duration and the second as delay', () => {
    const source = resolveAnimations({ animation: 'fade 2s 1s' })
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.animations[0]!.duration).toBe('2s')
    expect(source.animations[0]!.delay).toBe('1s')
  })

  it('keeps a cubic-bezier whole, spaces and all — neither its commas nor its spaces split it', () => {
    const source = resolveAnimations({ animation: 'fade 1s cubic-bezier(.4, 0, .2, 1)' })
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.animations[0]!.timingFunction).toBe('cubic-bezier(.4, 0, .2, 1)')
    expect(source.animations[0]!.duration).toBe('1s')
  })

  it('reads a comma-separated list as several animations', () => {
    const source = resolveAnimations({ animation: 'fade 1s, spin 2s linear infinite' })
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.animations).toHaveLength(2)
    expect(source.animations[1]!.iterationCount).toBe('infinite')
  })

  it('REFUSES the whole value when a component makes no sense, rather than reading half of it', () => {
    const source = resolveAnimations({ animation: 'fade 1s wobbly sideways' })
    expect(source.kind).toBe('raw')
    if (source.kind !== 'raw') throw new Error('expected raw')
    expect(source.reason).toContain('sideways')
  })

  it('REFUSES three times, which the grammar does not allow', () => {
    expect(resolveAnimations({ animation: 'fade 1s 2s 3s' }).kind).toBe('raw')
  })
})

describe('resolveAnimations — the longhands', () => {
  it('reads a rule written entirely in longhands', () => {
    const source = resolveAnimations({
      animationName: 'spin',
      animationDuration: '2s',
      animationIterationCount: 'infinite',
    })
    expect(source.kind).toBe('longhand')
    if (source.kind !== 'longhand') throw new Error('expected longhand')
    expect(source.animations[0]).toEqual({
      ...ANIMATION_DEFAULTS,
      name: 'spin',
      duration: '2s',
      iterationCount: 'infinite',
    })
  })

  it('repeats a shorter longhand list across the names, as the cascade does', () => {
    const source = resolveAnimations({ animationName: 'a, b', animationDuration: '1s' })
    if (source.kind !== 'longhand') throw new Error('expected longhand')
    expect(source.animations.map((animation) => animation.duration)).toEqual(['1s', '1s'])
  })

  it('REFUSES a rule that sets BOTH shapes — which wins depends on source order', () => {
    const source = resolveAnimations({ animation: 'fade 1s', animationDuration: '2s' })
    expect(source.kind).toBe('mixed')
    if (source.kind !== 'mixed') throw new Error('expected mixed')
    expect(source.reason).toContain('order')
  })
})

describe('serializeAnimation', () => {
  it('omits every component still at its initial value', () => {
    expect(serializeAnimation({ ...ANIMATION_DEFAULTS, name: 'fade', duration: '300ms' })).toBe('fade 300ms')
  })

  it('emits the duration whenever a delay is set, so the two times cannot be confused', () => {
    expect(serializeAnimation({ ...ANIMATION_DEFAULTS, name: 'fade', delay: '1s' })).toBe('fade 0s 1s')
  })

  it('round-trips a fully-specified animation', () => {
    const value = 'fade-in 300ms ease-out 100ms 2 alternate both paused'
    const source = resolveAnimations({ animation: value })
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(serializeAnimations(source.animations)).toBe(value)
  })

  it('is `none` for an animation with nothing set', () => {
    expect(serializeAnimation({ ...ANIMATION_DEFAULTS })).toBe('none')
  })
})

describe('animationFieldPatch — writing back into the shape it found', () => {
  it('rewrites the SHORTHAND when the source is a shorthand', () => {
    const source = resolveAnimations({ animation: 'fade 1s, spin 2s' })
    expect(animationFieldPatch(source, 0, 'duration', '400ms')).toEqual({ animation: 'fade 400ms, spin 2s' })
  })

  it('writes the LONGHAND when the source is longhands — never a competing shorthand', () => {
    const source = resolveAnimations({ animationName: 'spin', animationDuration: '2s' })
    expect(animationFieldPatch(source, 0, 'duration', '3s')).toEqual({ animationDuration: '3s' })
  })

  it('writes nothing for a refused value', () => {
    expect(animationFieldPatch(resolveAnimations({ animation: 'fade 1s wobbly x' }), 0, 'duration', '1s')).toBeNull()
  })

  it('drops one animation out of the list, and reports "clear it all" for the last', () => {
    const two = resolveAnimations({ animation: 'fade 1s, spin 2s' })
    expect(animationRemovalPatch(two, 0)).toEqual({ animation: 'spin 2s' })

    const one = resolveAnimations({ animation: 'fade 1s' })
    expect(animationRemovalPatch(one, 0)).toBeNull()
    expect(animationClearProperties(one)).toEqual(['animation'])
  })

  it('clearing the last LONGHAND animation names every longhand, not just the name', () => {
    const source = resolveAnimations({ animationName: 'spin', animationDuration: '2s' })
    expect(animationClearProperties(source)).toContain('animationName')
    expect(animationClearProperties(source)).toContain('animationPlayState')
  })
})

describe('resolveTransitions', () => {
  it('reads a transition list', () => {
    const source = resolveTransitions({ transition: 'opacity 200ms ease 50ms, transform 300ms' })
    expect(source.kind).toBe('shorthand')
    if (source.kind !== 'shorthand') throw new Error('expected shorthand')
    expect(source.transitions[0]).toEqual({
      property: 'opacity',
      duration: '200ms',
      timingFunction: 'ease',
      delay: '50ms',
    })
    expect(source.transitions[1]!.property).toBe('transform')
  })

  it('treats `transition: none` as no transitions', () => {
    expect(resolveTransitions({ transition: 'none' }).kind).toBe('none')
  })

  it('REFUSES a value it cannot fully account for', () => {
    expect(resolveTransitions({ transition: 'opacity 1s ease fast furious' }).kind).toBe('raw')
  })

  it('edits timing without touching the property list', () => {
    const source = resolveTransitions({ transition: 'opacity 200ms, transform 300ms' })
    expect(transitionFieldPatch(source, 1, 'duration', '500ms')).toEqual({
      transition: 'opacity 200ms, transform 500ms',
    })
    expect(transitionRemovalPatch(source, 0)).toEqual({ transition: 'transform 300ms' })
    expect(transitionRemovalPatch(resolveTransitions({ transition: 'opacity 200ms' }), 0)).toBeNull()
  })
})
