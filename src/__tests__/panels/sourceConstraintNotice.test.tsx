/**
 * `SourceConstraintNotice` says one of three things, and the point of this
 * suite is that it says the TRUE one.
 *
 * The defect it pins: every node whose value the evaluator had to resolve —
 * 149 of the 276 flagged nodes on the real eSIM board — used to be shown
 * "This element can't be moved or deleted from here", which is false for an
 * ordinary `<h1>{c.heading}</h1>` at a known line and column. Since `lock-01`
 * the parser does not lock those (`withResolution`), so the notice must not
 * claim they are locked either. A false explanation is worse than a lock.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { SourceConstraintNotice } from '@site/panels/PropertiesPanel/SourceConstraintNotice'

afterEach(cleanup)

const CANNOT_MOVE = /can't be moved or deleted/i

describe('SourceConstraintNotice', () => {
  it('a structurally locked element with a source location says so, and keeps its values editable', () => {
    render(<SourceConstraintNotice lockReason="spread props" hasWritableLocation codeProps={['title']} />)

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('structure-locked')
    expect(notice.textContent).toMatch(CANNOT_MOVE)
    expect(notice.textContent).toContain('spread props')
    expect(notice.textContent).toMatch(/One value comes from an expression/)
  })

  it('a `.map` row says one piece of source renders every row', () => {
    render(
      <SourceConstraintNotice lockReason="item 2 of DEALS" hasWritableLocation={false} codeProps={['title']} />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('list-row')
    expect(notice.textContent).toMatch(/One piece of source renders every row/)
  })

  it('a resolution-only element does NOT claim it cannot be moved', () => {
    render(
      <SourceConstraintNotice
        resolution={{ source: 'c.heading' }}
        hasWritableLocation
        codeProps={['title']}
      />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('values-only')
    expect(notice.textContent).not.toMatch(CANNOT_MOVE)
    expect(notice.textContent).toMatch(/it is not locked/)
    // It still names the one prop that genuinely has no writable target.
    expect(notice.textContent).toContain('value from c.heading')
    expect(notice.textContent).toMatch(/One value comes from an expression/)
    expect(notice.textContent).toContain('title')
  })

  it('names every code-valued prop, and ignores inline-style entries the style rows already refuse', () => {
    render(
      <SourceConstraintNotice
        resolution={{ source: 'c.heading' }}
        hasWritableLocation
        codeProps={['title', 'label', 'style:color']}
      />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.textContent).toMatch(/2 values come from an expression/)
    expect(notice.textContent).toContain('title, label')
    expect(notice.textContent).toMatch(/stay read-only/)
    expect(notice.textContent).not.toContain('style:color')
  })

  it("drops the `callSiteProps:` namespace — the row the user reads this against is labelled `title`", () => {
    render(
      <SourceConstraintNotice
        resolution={{ source: 't.homepage.upcomingTrip' }}
        hasWritableLocation
        codeProps={['callSiteProps:title', 'callSiteProps:actionLabel']}
      />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.textContent).toContain('title, actionLabel')
    expect(notice.textContent).not.toContain('callSiteProps')
  })

  it('states where resolved text writes, and how many places it changes', () => {
    render(
      <SourceConstraintNotice
        resolution={{ source: 'c.hotelsTag' }}
        hasWritableLocation
        textOrigin={{ rel: 'src/i18n/translations.js', line: 142, col: 18 }}
        sharedWith={5}
      />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('values-only')
    expect(notice.textContent).toContain('src/i18n/translations.js')
    expect(notice.textContent).toContain('142')
    expect(notice.textContent).toMatch(/changes all\s*5\s*places/)
  })

  it('surfaces the evaluator\'s own note when it had to choose', () => {
    render(
      <SourceConstraintNotice
        resolution={{ source: 'translations[lang]', note: 'showing the "en" entry' }}
        hasWritableLocation
        codeProps={['text']}
      />,
    )

    expect(screen.getByTestId('source-constraint-notice').textContent).toContain('showing the "en" entry')
  })

  it('renders nothing when there is no structural lock and nothing read-only to explain', () => {
    // The shape a branch-chosen node has: a `resolution` borrowed to carry a
    // structural note, no code-valued prop. `BranchChoiceNotice` owns that node.
    const { container } = render(
      <SourceConstraintNotice resolution={{ source: 'src/screens/Home.jsx', note: 'chose the loaded state' }} hasWritableLocation />,
    )

    expect(container.firstChild).toBeNull()
  })
})
