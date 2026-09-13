/**
 * Pure freeze-declaration tests + the DOM-lifecycle controller, shared by
 * `CanvasAnimationInjector` and the live runtime. The reactive stylesheet
 * text itself is exercised end-to-end (through the component) by
 * `canvasAnimationInjector.test.tsx`; this file covers the module's own
 * public contract in isolation, plus the controller's `update()`/`dispose()`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  animationFreezeDeclarations,
  buildAnimationRules,
  freezeAllMedia,
  freezeMediaElement,
  patchReducedMotionMatchMedia,
  startAnimationFreeze,
} from '@core/studio-runtime'

describe('animationFreezeDeclarations', () => {
  it('"end" freezes on the last keyframe', () => {
    const css = animationFreezeDeclarations('end')
    expect(css).toContain('animation-iteration-count: 1 !important')
    expect(css).toContain('animation-fill-mode: forwards !important')
    expect(css).not.toContain('animation-play-state')
  })

  it('"start" pauses instead', () => {
    const css = animationFreezeDeclarations('start')
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).not.toContain('animation-fill-mode')
  })

  it('a fractional freeze point uses a negative delay against a normalised duration', () => {
    const css = animationFreezeDeclarations(0.4)
    expect(css).toContain('animation-duration: 1s !important')
    expect(css).toContain('animation-delay: -0.4s !important')
    expect(css).toContain('animation-play-state: paused !important')
  })

  it('clamps a fraction outside 0…1', () => {
    expect(animationFreezeDeclarations(2)).toContain('animation-delay: -1s !important')
    expect(animationFreezeDeclarations(-1)).toContain('animation-delay: -0s !important')
  })
})

describe('buildAnimationRules', () => {
  it('idle phase adds transition:none on top of the freeze declarations', () => {
    const css = buildAnimationRules('end', 'idle')
    expect(css).toContain('transition: none !important')
    expect(css).toContain('animation-fill-mode: forwards !important')
  })

  it('reset phase strips animation entirely, without transition:none', () => {
    const css = buildAnimationRules('end', 'reset')
    expect(css).toContain('animation: none !important')
    expect(css).not.toContain('transition: none')
  })

  it('playing phase lets it run once, without transition:none', () => {
    const css = buildAnimationRules('end', 'playing')
    expect(css).toContain('animation-play-state: running !important')
    expect(css).not.toContain('transition: none')
  })

  it('always covers pseudo-elements and kills smooth scroll', () => {
    const css = buildAnimationRules('end', 'idle')
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
    expect(css).toContain('scroll-behavior: auto !important')
  })
})

describe('freezeMediaElement / freezeAllMedia', () => {
  afterEach(() => {
    document.querySelectorAll('video, audio').forEach((el) => el.remove())
  })

  it('strips autoplay and pauses a video', () => {
    const video = document.createElement('video')
    video.setAttribute('autoplay', '')
    document.body.appendChild(video)
    freezeMediaElement(video)
    expect(video.hasAttribute('autoplay')).toBe(false)
  })

  it('freezeAllMedia covers every video/audio under the document', () => {
    const video = document.createElement('video')
    video.setAttribute('autoplay', '')
    const audio = document.createElement('audio')
    audio.setAttribute('autoplay', '')
    document.body.append(video, audio)
    freezeAllMedia(document)
    expect(video.hasAttribute('autoplay')).toBe(false)
    expect(audio.hasAttribute('autoplay')).toBe(false)
  })

  it('ignores a non-media element', () => {
    const div = document.createElement('div')
    div.setAttribute('autoplay', '')
    freezeMediaElement(div)
    expect(div.hasAttribute('autoplay')).toBe(true)
    div.remove()
  })
})

describe('patchReducedMotionMatchMedia', () => {
  it('reports reduce for a prefers-reduced-motion query and restores on cleanup', () => {
    const view = document.defaultView!
    const original = view.matchMedia
    const restore = patchReducedMotionMatchMedia(view)

    expect(view.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
    expect(view.matchMedia('(prefers-reduced-motion: no-preference)').matches).toBe(false)

    restore?.()
    expect(view.matchMedia).toBe(original)
  })

  it('leaves unrelated queries untouched', () => {
    const view = document.defaultView!
    const restore = patchReducedMotionMatchMedia(view)
    const result = view.matchMedia('(min-width: 10px)')
    expect(typeof result.matches).toBe('boolean')
    restore?.()
  })
})

describe('startAnimationFreeze — DOM lifecycle controller', () => {
  const STYLE_ID = 'test-animation-freeze'

  afterEach(() => {
    document.getElementById(STYLE_ID)?.remove()
  })

  it('mounts the stylesheet at the given freeze point/phase', () => {
    const controller = startAnimationFreeze(document, STYLE_ID, 'end', 'idle', 'test-caller')
    const el = document.getElementById(STYLE_ID)
    expect(el?.getAttribute('data-source')).toBe('test-caller')
    expect(el?.textContent).toContain('animation-fill-mode: forwards !important')
    controller.dispose()
  })

  it('update() re-renders the stylesheet without touching the matchMedia patch', () => {
    const view = document.defaultView!
    const controller = startAnimationFreeze(document, STYLE_ID)
    const patchedMatchMedia = view.matchMedia

    controller.update('start', 'idle')

    expect(document.getElementById(STYLE_ID)?.textContent).toContain('animation-play-state: paused !important')
    // Same patched function reference — update() did not tear down and
    // reinstall the matchMedia patch.
    expect(view.matchMedia).toBe(patchedMatchMedia)
    controller.dispose()
  })

  it('dispose() removes the stylesheet and restores matchMedia', () => {
    const view = document.defaultView!
    const original = view.matchMedia
    const controller = startAnimationFreeze(document, STYLE_ID)
    controller.dispose()
    expect(document.getElementById(STYLE_ID)).toBeNull()
    expect(view.matchMedia).toBe(original)
  })
})
