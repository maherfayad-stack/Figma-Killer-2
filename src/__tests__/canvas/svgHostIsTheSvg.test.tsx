/**
 * P5-D SVG-0 — a literal `<svg>` renders AS the node, not inside a
 * Studio-owned `<span style="display:contents">`.
 *
 * The span made the canvas DOM `.row > span > svg` where the user's app has
 * `.row > svg`, so `.row > svg`, `svg:first-child` and `svg + span` matched
 * something different in the editor than in the app (audit `08-svg.md` §2
 * defect 1), and the resize offer refused the node because its host had no
 * box. Computed geometry is asserted in a real browser by
 * `tests/e2e/svg-renders-as-itself.e2e.ts`; this suite pins the DOM shape.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import type { ModuleComponentProps } from '@core/module-engine'
import { SvgEditor } from '@modules/base/svg/SvgEditor'
import { splitSvgRoot } from '@modules/base/svg/splitSvgRoot'
import type { SvgStoredProps } from '@modules/base/svg/props'

const ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" style="color: red; --tint: blue" aria-hidden="true">'
  + '<path d="M4 4h16v16H4z" fill-rule="evenodd"></path></svg>'

afterEach(() => cleanup())

function renderSvg(props: Partial<SvgStoredProps>, extra: Partial<ModuleComponentProps<SvgStoredProps>> = {}) {
  return render(
    <div className="row">
      <SvgEditor
        props={{ svg: ICON, title: '', ...props } as SvgStoredProps}
        nodeId="pages/Home.tsx:4:7"
        isSelected={false}
        mcClassName="icon"
        nodeWrapperProps={{ 'data-node-id': 'pages/Home.tsx:4:7', 'data-module-id': 'base.svg', tabIndex: 0 }}
        {...extra}
      />
      <span className="label">Label</span>
    </div>,
  )
}

describe('a literal <svg> renders as itself', () => {
  it('puts the node id on the <svg> element, a direct child of its parent', () => {
    const { container } = renderSvg({})
    const node = container.querySelector('[data-node-id="pages/Home.tsx:4:7"]')!
    expect(node.localName).toBe('svg')
    expect(node.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(node.parentElement?.className).toBe('row')
    expect(container.querySelector('span[data-node-id]')).toBeNull()
  })

  it('matches the child, first-child and adjacent-sibling selectors the app matches', () => {
    const { container } = renderSvg({})
    const node = container.querySelector('[data-node-id]')
    expect(container.querySelector('.row > svg')).toBe(node)
    expect(container.querySelector('svg:first-child')).toBe(node)
    expect(container.querySelector('svg + span.label')).not.toBeNull()
  })

  it('carries the root attributes, the editor props, and the drawing as real SVG children', () => {
    const { container } = renderSvg({})
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('stroke-width')).toBe('2')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('data-module-id')).toBe('base.svg')
    expect(svg.getAttribute('tabindex')).toBe('0')
    const path = svg.querySelector(':scope > path')!
    expect(path.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(path.getAttribute('d')).toBe('M4 4h16v16H4z')
    expect(path.getAttribute('fill-rule')).toBe('evenodd')
  })

  it("uses the node's class and style, with the markup's root style underneath", () => {
    const { container } = renderSvg({}, {
      mcClassName: 'icon icon--big',
      nodeWrapperProps: { 'data-node-id': 'n', style: { color: 'green' } },
    })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toBe('icon icon--big')
    expect((svg as SVGSVGElement).style.color).toBe('green')
    expect((svg as SVGSVGElement).style.getPropertyValue('--tint')).toBe('blue')
  })

  it("falls back to the markup's own class when the node has none", () => {
    const { container } = renderSvg({}, { mcClassName: '' })
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('icon')
  })

  it('labels the graphic itself when the node has an accessible title', () => {
    const { container } = renderSvg({ title: 'Close' })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Close')
  })

  it('never carries an event handler from the markup onto the element', () => {
    const { container } = renderSvg({ svg: '<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"></path></svg>' })
    expect(container.querySelector('svg')!.getAttribute('onload')).toBeNull()
  })
})

describe('the other shapes are unchanged', () => {
  it('keeps an authored ?raw wrapper as the node, with the graphic inside it', () => {
    const { container } = renderSvg({ tag: 'span' })
    const node = container.querySelector('[data-node-id]')!
    expect(node.localName).toBe('span')
    expect(node.querySelector(':scope > svg')).not.toBeNull()
    expect((node as HTMLElement).style.display).toBe('')
  })

  it('keeps a box-less span for markup that is not one <svg> element', () => {
    const { container } = renderSvg({ svg: '<svg viewBox="0 0 1 1"></svg><svg viewBox="0 0 2 2"></svg>' })
    const node = container.querySelector('[data-node-id]') as HTMLElement
    expect(node.localName).toBe('span')
    expect(node.style.display).toBe('contents')
    expect(node.querySelectorAll('svg')).toHaveLength(2)
  })
})

describe('splitSvgRoot', () => {
  it('parses each distinct markup once', () => {
    expect(splitSvgRoot(ICON)).toBe(splitSvgRoot(ICON))
  })

  it('refuses loose text beside the root', () => {
    expect(splitSvgRoot('hello<svg></svg>')).toBeUndefined()
    expect(splitSvgRoot('<div></div>')).toBeUndefined()
  })
})
