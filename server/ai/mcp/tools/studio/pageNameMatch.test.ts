/**
 * pageNameMatch — resolving a screen by the name the agent used for the file.
 *
 * The regression that motivates the kebab derivation: a naive lowercase
 * matcher resolved `Checkout` and silently failed on `AddMobile`, because a
 * page id is the KEBAB-cased stem (`add-mobile`). Multi-word screens are
 * exactly the names an agent is most likely to have just written, so the
 * naive version failed on the common case while passing the demo.
 */
import { describe, expect, it } from 'bun:test'
import { pageKey, resolvePageByName, resolveRequestedPages } from './pageNameMatch'

const PAGES = [
  { id: 'add-mobile', title: 'AddMobile' },
  { id: 'sign-up', title: 'SignUp' },
  { id: 'home', title: 'Home' },
]

describe('pageKey', () => {
  it('reduces every spelling of a screen to the id form', () => {
    for (const spelling of ['AddMobile', 'AddMobile.tsx', 'pages/AddMobile.tsx', 'pages\\AddMobile.tsx', 'add-mobile']) {
      expect(pageKey(spelling)).toBe('add-mobile')
    }
  })

  it('splits camelCase rather than flattening it — the multi-word bug', () => {
    expect(pageKey('AddMobile')).not.toBe('addmobile')
  })
})

describe('resolvePageByName', () => {
  it('matches a multi-word screen by its PascalCase file name', () => {
    expect(resolvePageByName(PAGES, 'AddMobile')?.id).toBe('add-mobile')
    expect(resolvePageByName(PAGES, 'pages/SignUp.tsx')?.id).toBe('sign-up')
  })

  it('prefers an exact page id over any fuzzy interpretation of it', () => {
    // An id read out of a previous tool result must never be re-parsed as a name.
    const shadowed = [{ id: 'sign-up', title: 'Something Else' }, { id: 'other', title: 'sign-up' }]
    expect(resolvePageByName(shadowed, 'sign-up')?.title).toBe('Something Else')
  })

  it('returns null for a screen that does not exist, rather than a near miss', () => {
    expect(resolvePageByName(PAGES, 'Checkout')).toBeNull()
  })
})

describe('resolveRequestedPages', () => {
  it('reports unmatched names instead of dropping them silently', () => {
    const { ids, unmatched } = resolveRequestedPages(PAGES, ['AddMobile', 'Nope'], 20)
    expect(ids).toEqual(['add-mobile'])
    expect(unmatched).toEqual(['Nope'])
  })

  it('de-duplicates two spellings of the same screen', () => {
    expect(resolveRequestedPages(PAGES, ['AddMobile', 'add-mobile'], 20).ids).toEqual(['add-mobile'])
  })

  it('falls back to every page, capped, when nothing was requested', () => {
    expect(resolveRequestedPages(PAGES, undefined, 2).ids).toEqual(['add-mobile', 'sign-up'])
  })
})
