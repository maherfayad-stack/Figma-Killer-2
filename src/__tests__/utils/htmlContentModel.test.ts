/**
 * `@core/utils/htmlContentModel` — the table ⌘G's wrapper tag comes out of.
 *
 * The defect this closes was a single hard-coded `div`, so the test that
 * matters most is not "does it pick `span` inside a `<p>`" but "is every
 * category of HTML element accounted for". Element names are enumerated here
 * by category, and each category is asserted as a whole: a name that lands in
 * two categories, or in none, fails.
 */
import { describe, expect, it } from 'bun:test'
import {
  canWrapperTagSitHere,
  chooseGroupWrapperTag,
  htmlContentModel,
  htmlElementCategory,
  htmlPositionalParent,
  resolveContentModel,
} from '@core/utils/htmlContentModel'
import { VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'

// Every element name this module claims to know, grouped the way the HTML
// spec groups them. Kept as literal lists rather than re-derived from the
// module's own sets, so the test can disagree with the implementation.
const PHRASING = [
  'a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas', 'cite', 'code',
  'data', 'datalist', 'del', 'dfn', 'em', 'embed', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'map', 'mark', 'math', 'meter', 'noscript', 'object',
  'output', 'picture', 'progress', 'q', 'ruby', 's', 'samp', 'select', 'slot',
  'small', 'span', 'strong', 'sub', 'sup', 'svg', 'template', 'textarea', 'time',
  'u', 'var', 'video', 'wbr',
]
const FLOW = [
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl',
  'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search',
  'section', 'table', 'ul',
]
const POSITIONAL = [
  'li', 'dt', 'dd', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr',
  'td', 'th', 'option', 'optgroup', 'legend', 'summary', 'figcaption', 'source',
  'track', 'param', 'area', 'rt', 'rp', 'body', 'head', 'html',
]
const METADATA = ['base', 'link', 'meta', 'script', 'style', 'title']

describe('htmlElementCategory — every element lands in exactly one category', () => {
  it('categorises phrasing, flow, positional and metadata elements', () => {
    for (const tag of PHRASING) expect(`${tag}:${htmlElementCategory(tag)}`).toBe(`${tag}:phrasing`)
    for (const tag of FLOW) expect(`${tag}:${htmlElementCategory(tag)}`).toBe(`${tag}:flow`)
    for (const tag of POSITIONAL) expect(`${tag}:${htmlElementCategory(tag)}`).toBe(`${tag}:positional`)
    for (const tag of METADATA) expect(`${tag}:${htmlElementCategory(tag)}`).toBe(`${tag}:metadata`)
  })

  it('no name appears in two of the four lists', () => {
    const seen = new Map<string, string>()
    for (const [name, list] of [
      ['phrasing', PHRASING],
      ['flow', FLOW],
      ['positional', POSITIONAL],
      ['metadata', METADATA],
    ] as const) {
      for (const tag of list) {
        expect(seen.has(tag) ? `${tag} also in ${seen.get(tag)}` : tag).toBe(tag)
        seen.set(tag, name)
      }
    }
  })

  it('is case-insensitive, like HTML itself', () => {
    expect(htmlElementCategory('DIV')).toBe('flow')
    expect(htmlElementCategory('SPAN')).toBe('phrasing')
  })

  it('has no opinion about an unknown name — a custom element, or one HTML gained later', () => {
    expect(htmlElementCategory('my-widget')).toBeNull()
    expect(htmlElementCategory('selectedcontent')).toBeNull()
    // A COMPONENT never reaches this function (callers pass `null`), but a
    // capitalised name must not be mistaken for its lowercase element either.
    expect(htmlElementCategory('Div')).toBe('flow')
  })

  it('names the parent each positional element belongs to', () => {
    expect(htmlPositionalParent('li')).toBe('ul')
    expect(htmlPositionalParent('td')).toBe('tr')
    expect(htmlPositionalParent('option')).toBe('select')
    expect(htmlPositionalParent('div')).toBeNull()
  })
})

describe('htmlContentModel — what each element may contain', () => {
  it('every void element is empty, and the list agrees with htmlTags.ts', () => {
    for (const tag of VOID_HTML_ELEMENTS) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:empty`)
    }
    // The two lists are the same HTML fact; this is the assertion that keeps
    // them from drifting apart.
    expect(VOID_HTML_ELEMENTS.has('img')).toBe(true)
    expect(VOID_HTML_ELEMENTS.has('div')).toBe(false)
  })

  it('text-only elements are empty too — nothing that is an element fits inside', () => {
    for (const tag of ['option', 'textarea', 'title', 'script', 'style']) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:empty`)
    }
  })

  it('phrasing-content parents hold only text-level elements', () => {
    for (const tag of ['p', 'h1', 'h6', 'span', 'label', 'button', 'em', 'pre', 'q']) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:phrasing`)
    }
  })

  it('flow-content parents hold anything', () => {
    for (const tag of ['div', 'section', 'li', 'td', 'figure', 'blockquote', 'dd', 'form']) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:flow`)
    }
  })

  it('list, table, select and picture parents accept only their own children', () => {
    for (const tag of ['ul', 'ol', 'table', 'tr', 'thead', 'select', 'optgroup', 'picture', 'colgroup']) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:restricted`)
    }
    const ul = htmlContentModel('ul')
    expect(ul?.kind === 'restricted' && ul.allows.has('li')).toBe(true)
    expect(ul?.kind === 'restricted' && ul.allows.has('div')).toBe(false)
    // `<dl>` is the one restricted parent HTML lets you group with a `<div>`.
    const dl = htmlContentModel('dl')
    expect(dl?.kind === 'restricted' && dl.allows.has('div')).toBe(true)
  })

  it('transparent elements defer to their parent rather than guessing', () => {
    for (const tag of ['a', 'ins', 'del', 'object', 'slot', 'video', 'audio', 'canvas', 'map']) {
      expect(`${tag}:${htmlContentModel(tag)?.kind}`).toBe(`${tag}:transparent`)
    }
  })
})

describe('resolveContentModel — the walk up the ancestor chain', () => {
  it('stops at the first ancestor with a model of its own', () => {
    expect(resolveContentModel(['div', 'p'])?.kind).toBe('flow')
    expect(resolveContentModel(['p', 'div'])?.kind).toBe('phrasing')
  })

  it('walks THROUGH a transparent element to whatever really encloses it', () => {
    // `<p><a>…</a></p>` — the `<a>` is phrasing-only because the `<p>` is.
    expect(resolveContentModel(['a', 'p'])?.kind).toBe('phrasing')
    // `<div><a>…</a></div>` — the same `<a>` now takes block content.
    expect(resolveContentModel(['a', 'div'])?.kind).toBe('flow')
  })

  it('stops with no answer at a component, and at an empty chain', () => {
    expect(resolveContentModel([null, 'p'])).toBeNull()
    expect(resolveContentModel(['a', null, 'p'])).toBeNull()
    expect(resolveContentModel([])).toBeNull()
    expect(resolveContentModel(['my-widget', 'p'])).toBeNull()
  })
})

describe('chooseGroupWrapperTag — the tag ⌘G writes', () => {
  it('writes a <span> around inline elements inside a <p> — the defect this closes', () => {
    expect(chooseGroupWrapperTag({ ancestorTags: ['p'], memberTags: ['span', 'span'] })).toEqual({
      ok: true,
      tag: 'span',
    })
  })

  it('writes a <div> around block elements in a flow container', () => {
    expect(chooseGroupWrapperTag({ ancestorTags: ['div'], memberTags: ['div', 'section'] })).toEqual({
      ok: true,
      tag: 'div',
    })
  })

  it('keeps an all-inline run inline even where a <div> would also be legal', () => {
    // `<li><span/><span/></li>`: a `<div>` is valid HTML but stops the run
    // flowing with the text around it, which is a change the user did not ask
    // for. Same reasoning inside a plain `<div>`.
    expect(chooseGroupWrapperTag({ ancestorTags: ['li', 'ul'], memberTags: ['span', 'a'] }).ok).toBe(true)
    expect(chooseGroupWrapperTag({ ancestorTags: ['li', 'ul'], memberTags: ['span', 'a'] })).toEqual({
      ok: true,
      tag: 'span',
    })
    expect(chooseGroupWrapperTag({ ancestorTags: ['div'], memberTags: ['img', 'span'] })).toEqual({
      ok: true,
      tag: 'span',
    })
  })

  it('follows the PARENT when the members are components whose category is unknown', () => {
    expect(chooseGroupWrapperTag({ ancestorTags: ['p'], memberTags: [null, null] })).toEqual({ ok: true, tag: 'span' })
    expect(chooseGroupWrapperTag({ ancestorTags: ['div'], memberTags: [null, null] })).toEqual({ ok: true, tag: 'div' })
    // One known inline member and one component is still "no opinion": the
    // component could render anything.
    expect(chooseGroupWrapperTag({ ancestorTags: ['div'], memberTags: ['span', null] })).toEqual({
      ok: true,
      tag: 'div',
    })
  })

  it('falls back to the ordinary container when the context says nothing at all', () => {
    expect(chooseGroupWrapperTag({ ancestorTags: [null], memberTags: [null] })).toEqual({ ok: true, tag: 'div' })
    expect(chooseGroupWrapperTag({ ancestorTags: [], memberTags: ['div'] })).toEqual({ ok: true, tag: 'div' })
  })

  it('REFUSES inside a <ul>, naming what a <ul> may contain', () => {
    const choice = chooseGroupWrapperTag({ ancestorTags: ['ul'], memberTags: ['li', 'li'] })
    expect(choice.ok).toBe(false)
    if (choice.ok) throw new Error('unreachable')
    // The PARENT bites first here and gives the more useful sentence: it can
    // name what a `<ul>` is allowed to contain.
    expect(choice.reason).toBe('parent-forbids-wrapper')
    expect(choice.message).toContain('<li>')
    expect(choice.message).toContain('<ul>')
  })

  it('REFUSES a positional member even when the parent is unknown', () => {
    const choice = chooseGroupWrapperTag({ ancestorTags: [null], memberTags: ['li', 'li'] })
    expect(choice.ok).toBe(false)
    if (choice.ok) throw new Error('unreachable')
    expect(choice.reason).toBe('member-is-positional')
    expect(choice.message).toContain('<ul>')
  })

  it('REFUSES a figcaption inside its figure — a flow parent is not permission', () => {
    const choice = chooseGroupWrapperTag({ ancestorTags: ['figure'], memberTags: ['figcaption'] })
    expect(choice.ok).toBe(false)
    if (choice.ok) throw new Error('unreachable')
    expect(choice.reason).toBe('member-is-positional')
  })

  it('REFUSES around table and select children wherever they are', () => {
    for (const tag of ['td', 'tr', 'option', 'thead', 'figcaption', 'source']) {
      const choice = chooseGroupWrapperTag({ ancestorTags: [null], memberTags: [tag, tag] })
      expect(`${tag}:${choice.ok}`).toBe(`${tag}:false`)
    }
  })

  it('REFUSES inside a parent that takes no wrapper — a <tr>, a <select>, a void element', () => {
    for (const parent of ['tr', 'select', 'picture', 'optgroup', 'img', 'textarea']) {
      const choice = chooseGroupWrapperTag({ ancestorTags: [parent], memberTags: [null, null] })
      expect(`${parent}:${choice.ok}`).toBe(`${parent}:false`)
      if (choice.ok) continue
      expect(choice.reason).toBe('parent-forbids-wrapper')
    }
  })

  it('REFUSES when the parent holds text only but a member is a block', () => {
    const choice = chooseGroupWrapperTag({ ancestorTags: ['p'], memberTags: ['span', 'div'] })
    expect(choice.ok).toBe(false)
    if (choice.ok) throw new Error('unreachable')
    expect(choice.reason).toBe('phrasing-conflict')
    expect(choice.message).toContain('<p>')
  })

  it('takes a <div> inside a <dl>, which is the one restricted parent that allows it', () => {
    expect(chooseGroupWrapperTag({ ancestorTags: ['dl'], memberTags: [null, null] })).toEqual({
      ok: true,
      tag: 'div',
    })
    // …including around the positional `<dt>`/`<dd>` pair, which is the exact
    // grouping the spec permits and the only one it does.
    expect(chooseGroupWrapperTag({ ancestorTags: ['dl'], memberTags: ['dt', 'dd'] })).toEqual({
      ok: true,
      tag: 'div',
    })
    // …and it stays a `<div>` even for an all-inline run, because a `<span>`
    // is not on `<dl>`'s allow list.
    expect(chooseGroupWrapperTag({ ancestorTags: ['dl'], memberTags: ['span', 'span'] })).toEqual({
      ok: true,
      tag: 'div',
    })
  })

  it('resolves a transparent ancestor before deciding', () => {
    // A block link inside a section: `<div>` is right.
    expect(chooseGroupWrapperTag({ ancestorTags: ['a', 'section'], memberTags: ['div', 'div'] })).toEqual({
      ok: true,
      tag: 'div',
    })
    // The same `<a>` inside a `<p>`: a `<div>` would be invalid twice over.
    expect(chooseGroupWrapperTag({ ancestorTags: ['a', 'p'], memberTags: ['div', 'div'] }).ok).toBe(false)
  })
})

describe('canWrapperTagSitHere — a tag the caller named, not one this module picked', () => {
  it('allows any wrapper where flow content is allowed', () => {
    expect(canWrapperTagSitHere('section', ['div'])).toBe(true)
    expect(canWrapperTagSitHere('Stack', ['div'])).toBe(true)
  })

  it('refuses a block wrapper in phrasing content, and allows an inline one', () => {
    expect(canWrapperTagSitHere('section', ['p'])).toBe(false)
    expect(canWrapperTagSitHere('em', ['p'])).toBe(true)
    // A component's category is unknown, and an unknown element renders as an
    // inline box — refusing it would block an ordinary gesture on a guess.
    expect(canWrapperTagSitHere('Stack', ['p'])).toBe(true)
  })

  it('refuses everything inside a restricted or empty parent, except what it allows', () => {
    expect(canWrapperTagSitHere('div', ['ul'])).toBe(false)
    expect(canWrapperTagSitHere('li', ['ul'])).toBe(true)
    expect(canWrapperTagSitHere('div', ['dl'])).toBe(true)
    expect(canWrapperTagSitHere('div', ['img'])).toBe(false)
  })

  it('says yes when it knows nothing', () => {
    expect(canWrapperTagSitHere('div', [null])).toBe(true)
    expect(canWrapperTagSitHere('div', [])).toBe(true)
  })
})
