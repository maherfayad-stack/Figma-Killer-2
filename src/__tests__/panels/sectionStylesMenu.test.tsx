/**
 * The section-header styles buttons — one button per style FAMILY.
 *
 * This used to be a single button per section that opened both families at
 * once, and on a real project that menu was unusable: a framework generates a
 * handful of text styles and several hundred colour utilities, so the six
 * things the Typography button existed for sat under a "Text styles" heading
 * that scrolled off the top of a wall of colours.
 *
 * The fix is not a better heading. Which KIND of style you are applying is
 * something you already know before you reach for the button, so it belongs
 * in the button. These pin that:
 *
 *  - Typography offers two buttons, and each menu contains only its family;
 *  - a section with one family still gets exactly one button;
 *  - picking a style adds the class to the node rather than copying its
 *    declarations anywhere;
 *  - **the project's OWN CSS classes count as styles.** This menu originally
 *    required `generated.origin === 'framework'`, which on a real Studio
 *    project matched almost nothing — the repo is the document, its rules are
 *    parsed out of the project's own CSS, and a parsed rule carries no
 *    `generated` metadata. A project full of type classes opened this menu
 *    and was told "no generated text styles yet".
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { SectionStylesMenu } from '@site/panels/PropertiesPanel/SectionStylesMenu'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage } from '../fixtures'

afterEach(cleanup)

const NODE_ID = 'node-1'

/*
 * `useEditorStore` is a module singleton, so it is shared by every test file
 * that bun runs in this process. Seeding it without putting it back leaves
 * the next file editing OUR fixture site with OUR stubbed actions — which is
 * exactly what happened when this file first landed and took five unrelated
 * properties-panel tests down with it. Snapshot the keys this file touches,
 * restore them after each test.
 */
const pristine = (() => {
  const { site, activePageId, addNodeClass } = useEditorStore.getState()
  return { site, activePageId, addNodeClass }
})()

function typographyRule(name: string, step: string): StyleRule {
  return {
    id: `rule-${name}`,
    name,
    selector: `.${name}`,
    styles: { fontSize: '16px', lineHeight: '1.4' },
    generated: {
      origin: 'framework',
      family: 'typography',
      sourceId: 'group-1',
      generatorId: 'gen-1',
      tokenName: 'text',
      step,
      locked: true,
    },
  } as StyleRule
}

function colorRule(name: string, utility: 'text' | 'background' | 'border'): StyleRule {
  return {
    id: `rule-${name}`,
    name,
    selector: `.${name}`,
    styles:
      utility === 'background'
        ? { backgroundColor: 'var(--brand-600)' }
        : utility === 'border'
          ? { borderColor: 'var(--brand-600)' }
          : { color: 'var(--brand-600)' },
    generated: {
      origin: 'framework',
      family: 'color',
      sourceId: 'token-brand',
      utility,
      tokenName: 'brand',
      locked: true,
    },
  } as StyleRule
}

/** A rule as `studioCss.ts` produces it: parsed from the project's own CSS, no `generated`. */
function authoredRule(name: string, styles: Record<string, unknown>): StyleRule {
  return {
    id: `rule-${name}`,
    name,
    kind: 'class',
    selector: `.${name}`,
    styles,
    contextStyles: {},
    createdAt: 1,
    updatedAt: 1,
  } as StyleRule
}

beforeEach(() => {
  const rules: Record<string, StyleRule> = {}
  for (const rule of [
    typographyRule('text-m', 'm'),
    typographyRule('text-l', 'l'),
    colorRule('text-brand', 'text'),
    colorRule('bg-brand', 'background'),
    colorRule('border-brand', 'border'),
    // The project's own CSS — what `studioCss.ts` actually hands the store.
    authoredRule('PlanCard_name__d3b29', { fontWeight: 600 }),
    authoredRule('statusTime', { fontSize: '15px', fontWeight: 600, color: '#fff' }),
    authoredRule('brand-ink', { color: 'var(--brand-600)' }),
    // A whole-component class: sets type AND layout, so it is NOT a style.
    authoredRule('frame', {
      display: 'flex',
      maxWidth: '390px',
      fontFamily: 'Open Sans',
      color: '#888',
      background: '#000',
    }),
  ]) {
    rules[rule.id] = rule
  }

  useEditorStore.setState({
    site: makeSite({ pages: [makePage({ id: 'page-1' })], styleRules: rules }),
    activePageId: 'page-1',
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  useEditorStore.setState(pristine as Parameters<typeof useEditorStore.setState>[0])
})

function openMenu(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('section styles menu', () => {
  it('gives Typography one button per family, never one button for both', () => {
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)

    expect(screen.getByRole('button', { name: /text styles/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /text color styles/i })).toBeTruthy()
  })

  it('shows only type styles behind the text-styles button', () => {
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text styles/i)

    const menu = screen.getByRole('menu', { name: 'Text styles' })
    expect(within(menu).getByText('text-m')).toBeTruthy()
    expect(within(menu).getByText('text-l')).toBeTruthy()
    // The colour utility that used to share this menu.
    expect(within(menu).queryByText('text-brand')).toBeNull()
  })

  it('shows only colour styles behind the colour button', () => {
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text color styles/i)

    const menu = screen.getByRole('menu', { name: 'Text color styles' })
    expect(within(menu).getByText('text-brand')).toBeTruthy()
    expect(within(menu).queryByText('text-m')).toBeNull()
    // Scoped to THIS section's utility kinds — a background utility belongs
    // to the Background header, not here.
    expect(within(menu).queryByText('bg-brand')).toBeNull()
  })

  it("offers the project's own CSS classes, not just framework-generated ones", () => {
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text styles/i)

    const menu = screen.getByRole('menu', { name: 'Text styles' })
    // A bare `font-weight` rule is a text style. This is the regression:
    // it was invisible because nothing generated it.
    expect(within(menu).getByText('PlanCard_name__d3b29')).toBeTruthy()
    expect(within(menu).getByText('statusTime')).toBeTruthy()
  })

  it('leaves whole-component classes out of the style menus', () => {
    // `.frame` sets font-family and colour, but also display and max-width.
    // Offering it would make this menu a second ClassPicker — which is what
    // the ClassPicker is for.
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text styles/i)

    expect(within(screen.getByRole('menu', { name: 'Text styles' })).queryByText('frame')).toBeNull()
  })

  it('reads a colour style off its declarations too', () => {
    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text color styles/i)

    const menu = screen.getByRole('menu', { name: 'Text color styles' })
    expect(within(menu).getByText('brand-ink')).toBeTruthy()
    // A pure `color` rule is a colour style, not a text style.
    expect(within(menu).queryByText('PlanCard_name__d3b29')).toBeNull()
  })

  it('gives a single-family section exactly one button', () => {
    render(<SectionStylesMenu sectionId="background" nodeId={NODE_ID} assignedClassIds={[]} />)

    expect(screen.getAllByRole('button')).toHaveLength(1)
    openMenu(/apply background color styles/i)
    const menu = screen.getByRole('menu', { name: 'Background color styles' })
    expect(within(menu).getByText('bg-brand')).toBeTruthy()
    expect(within(menu).queryByText('border-brand')).toBeNull()
  })

  it('renders nothing for a section with no generated family behind it', () => {
    const { container } = render(
      <SectionStylesMenu sectionId="spacing" nodeId={NODE_ID} assignedClassIds={[]} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('applies a style by adding its class to the node, not by copying declarations', () => {
    const applied: Array<[string, string]> = []
    useEditorStore.setState({
      addNodeClass: (nodeId: string, classId: string) => applied.push([nodeId, classId]),
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<SectionStylesMenu sectionId="typography" nodeId={NODE_ID} assignedClassIds={[]} />)
    openMenu(/apply text styles/i)
    fireEvent.click(screen.getByText('text-l'))

    expect(applied).toEqual([[NODE_ID, 'rule-text-l']])
  })
})
