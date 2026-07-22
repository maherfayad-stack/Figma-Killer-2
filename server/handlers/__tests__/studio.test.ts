/**
 * studio.ts — unit tests for the pure pageId-derivation helper.
 *
 * `pageIdFromFileName` turns a page file's basename into the stable,
 * unique `pageId`/`slug` the multi-page `/admin/api/studio/load` scan uses
 * (Phase 1, Increment 1B — multi-frame board).
 */
import { describe, it, expect } from 'bun:test'
import { pageIdFromFileName } from '../studio'

describe('pageIdFromFileName', () => {
  it('lowercases a simple basename', () => {
    expect(pageIdFromFileName('Home.tsx')).toBe('home')
  })

  it('lowercases another simple basename', () => {
    expect(pageIdFromFileName('About.tsx')).toBe('about')
  })

  it('kebab-cases a multi-word PascalCase basename', () => {
    expect(pageIdFromFileName('MyPage.tsx')).toBe('my-page')
  })

  it('collapses non-alphanumeric separators to a single dash', () => {
    expect(pageIdFromFileName('Contact Us.tsx')).toBe('contact-us')
  })

  it('strips leading/trailing dashes produced by punctuation at the edges', () => {
    expect(pageIdFromFileName('_Home_.tsx')).toBe('home')
  })

  it('falls back to "page" for a basename with no alphanumeric characters', () => {
    expect(pageIdFromFileName('___.tsx')).toBe('page')
  })
})
