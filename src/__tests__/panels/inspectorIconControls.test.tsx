/**
 * The inspector's picture vocabulary — icon toggle groups and in-field glyphs.
 *
 * These pin the Figma-parity density pass at the level that actually matters:
 * not "the CSS says 24px" but "the control a user reaches for is a row of
 * marks, and operating it writes the right CSS".
 *
 * Three facts, each of which used to be false:
 *
 *  - a `text-align` row rendered as a word dropdown that needed a label column
 *    beside it to mean anything. It is now four segments and no words.
 *  - there was no way back to "unset" from a toggle group, because unlike the
 *    old `<select>` it has no empty option. Clicking the pressed segment
 *    clears the property.
 *  - `line-height` kept a visible label. It now carries a glyph inside the
 *    field and NO caption at all — a mark plus the word it stands for is the
 *    same name twice, which was most of what made the panel feel crowded.
 *    That must not cost the field its accessible name, since the glyph is
 *    `aria-hidden` and screen readers would otherwise get an unnamed input.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup, within } from '@testing-library/react'
import { ClassPropertyRow } from '@site/panels/PropertiesPanel/ClassPropertyRow'

afterEach(cleanup)

const noop = () => {}

describe('inspector icon toggle groups', () => {
  it('renders text-align as a group of marks, not a word dropdown', () => {
    render(
      <ClassPropertyRow
        property="textAlign"
        value="center"
        layout="stacked"
        onChange={noop}
        onRemove={noop}
      />,
    )

    const group = screen.getByRole('group', { name: 'Text align' })
    const segments = within(group).getAllByRole('button')
    expect(segments).toHaveLength(4)

    // No `<select>` anywhere in the row, and no visible word for the value —
    // the whole point of the group is that the mark IS the label.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(group.textContent).toBe('')

    // The active value is expressed as pressed state, which is what makes it
    // readable without opening anything.
    const pressed = segments.filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute('aria-label')).toContain('Align center')
  })

  it('commits the CSS keyword — not the tooltip wording — when a segment is picked', () => {
    const written: Array<[string, unknown]> = []
    render(
      <ClassPropertyRow
        property="textAlign"
        value={undefined}
        layout="stacked"
        onChange={(property, next) => written.push([String(property), next])}
        onRemove={noop}
      />,
    )

    screen.getByRole('button', { name: /Justify/ }).click()

    expect(written).toEqual([['textAlign', 'justify']])
  })

  it('clears the property when the pressed segment is clicked again', () => {
    // The old `<select>` had an explicit `—` option; a toggle group has no
    // empty segment, so without this there is no route back to unset.
    const removed: string[] = []
    render(
      <ClassPropertyRow
        property="textAlign"
        value="center"
        layout="stacked"
        onChange={noop}
        onRemove={(property) => removed.push(String(property))}
      />,
    )

    screen.getByRole('button', { name: /Align center/ }).click()

    expect(removed).toEqual(['textAlign'])
  })

  it('keeps every enum a group only where a mark is genuinely readable', () => {
    // `whiteSpace` has no honest picture — `pre-line` versus `pre-wrap` is not
    // something a 14px glyph can say — so it must still be a dropdown. This is
    // the guard against the density pass turning every enum into a rebus.
    render(
      <ClassPropertyRow
        property="whiteSpace"
        value="nowrap"
        layout="stacked"
        onChange={noop}
        onRemove={noop}
      />,
    )

    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('inspector in-field glyphs', () => {
  it('names line-height with a glyph while keeping its accessible name', () => {
    render(
      <ClassPropertyRow
        property="lineHeight"
        value="1.4"
        layout="stacked"
        onChange={noop}
        onRemove={noop}
      />,
    )

    // Reachable by name even though nothing spells it out on screen: the glyph
    // is `aria-hidden`, so the input's own `aria-label` is the only name there
    // is, and dropping it would leave an unlabelled field.
    const field = screen.getByRole('textbox', { name: 'Line height' })
    expect((field as HTMLInputElement).value).toBe('1.4')

    // And nothing spells it out: a field carrying its own mark does not also
    // get a caption. This is the assertion that keeps the density pass from
    // quietly regressing one property at a time.
    expect(screen.queryByText('Line height')).toBeNull()
  })

  it('leaves a caption on the properties whose value is cryptic on its own', () => {
    // The counterweight to the assertion above. `nowrap` under nothing is a
    // riddle, so `white-space` keeps its caption — "drop every label" would
    // be a worse panel than the one this pass started from.
    render(
      <ClassPropertyRow
        property="whiteSpace"
        value="nowrap"
        layout="stacked"
        onChange={noop}
        onRemove={noop}
      />,
    )

    expect(screen.queryByText('White space')).toBeTruthy()
  })

  it('drops the caption from a value that already names itself', () => {
    // `border-box` IS the label. This is what let the Size section give up
    // two full-width captioned rows for one paired row.
    render(
      <ClassPropertyRow
        property="boxSizing"
        value="border-box"
        layout="stacked"
        onChange={noop}
        onRemove={noop}
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Box sizing' })).toBeTruthy()
    expect(screen.queryByText('Box sizing')).toBeNull()
  })
})
