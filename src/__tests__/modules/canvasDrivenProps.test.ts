/**
 * `dir` is the canvas's, on every path that renders a design-system component.
 *
 * The rule shipped in `src/modules/alm/register.tsx` first and was NOT applied
 * to `registerProjectModules.ts` — the generic path every design system other
 * than the one hardcoded package goes through. That left the exact defect the
 * rule exists to prevent fully alive for any other project: a `dir` row in the
 * panel showing `ltr` while the board previewed RTL, because the manifest's own
 * enum default was stamped onto every insert and an explicit prop outranks the
 * provider. Hence the source-scan gate below — the failure mode here is a
 * SECOND copy of the rule, or a path that forgets it, not a wrong branch inside
 * one function.
 *
 * The last case pins the deliberate boundary: a LOCAL component keeps its `dir`
 * row, because Studio wraps no provider around it and would be removing a
 * control with nothing left to drive it.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  controlForPropKind,
  isCanvasDrivenProp,
  stripCanvasDrivenProps,
  withCanvasDrivenProps,
} from '@site/property-controls/componentPropKind'
import { buildComponentCallSiteRows } from '@site/panels/PropertiesPanel/componentCallSiteRows'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/** The two files that turn a design system's components into canvas modules. */
const REGISTRATION_PATHS = [
  'src/modules/alm/register.tsx',
  'src/admin/pages/site/studio/registerProjectModules.ts',
] as const

describe('canvas-driven props', () => {
  it('offers no control for a handler, whichever path asks', () => {
    expect(controlForPropKind('onClick', { kind: 'handler' })).toBeUndefined()
    // Every value-carrying kind still maps, unchanged.
    expect(controlForPropKind('title', { kind: 'string' })?.type).toBe('text')
    expect(controlForPropKind('open', { kind: 'boolean' })?.type).toBe('toggle')
  })

  it('strips `dir` from a node\'s props, and allocates nothing when there is none', () => {
    const withDir = { dir: 'ltr', title: 'Account' }
    expect(stripCanvasDrivenProps(withDir)).toEqual({ title: 'Account' })

    const without = { title: 'Account' }
    expect(stripCanvasDrivenProps(without)).toBe(without)
  })

  it("supplies the frame's `dir`, because stripping alone leaves the component defaulting to ltr", () => {
    // The regression this pins: `@alm-design/design-system@1.1.2` has ZERO
    // `useDir()` call sites, and 20 of its 26 components declare `dir` as a
    // prop defaulting to the literal `'ltr'` which they write on their own
    // root — beating the frame's inherited `html[dir="rtl"]`. Stripping the
    // prop and trusting a provider therefore pinned an RTL board to LTR.
    expect(withCanvasDrivenProps({ dir: 'ltr', title: 'Account' }, { direction: 'rtl' })).toEqual({
      title: 'Account',
      dir: 'rtl',
    })
    // A node with no `dir` of its own still gets the frame's.
    expect(withCanvasDrivenProps({ title: 'Account' }, { direction: 'rtl' }).dir).toBe('rtl')
    expect(withCanvasDrivenProps({ title: 'Account' }, { direction: 'ltr' }).dir).toBe('ltr')
  })

  it('is applied by BOTH design-system registration paths', () => {
    for (const rel of REGISTRATION_PATHS) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // The panel's control list and the persisted defaults must not offer
      // `dir`, and the render path must SUPPLY it — a path that skips any one
      // of the three still renders a component against the board's toggle.
      expect(source).toContain('isCanvasDrivenProp')
      expect(source).toContain('withCanvasDrivenProps')
      // ...and neither may keep a private copy of the rule.
      expect(source).not.toContain("new Set(['dir'])")
    }
  })

  it('leaves a LOCAL component its `dir` row — Studio supplies no provider there', () => {
    const rows = buildComponentCallSiteRows(
      {
        name: 'Card',
        file: 'src/Card.tsx',
        exportName: 'Card',
        isDefaultExport: false,
        props: [
          { name: 'dir', kind: { kind: 'enum', values: ['ltr', 'rtl'] }, required: false },
          { name: 'onPress', kind: { kind: 'handler' }, required: false },
        ],
      },
      {},
    )
    expect(rows.map((r) => r.key)).toEqual(['dir'])
    expect(rows[0]!.control.type).toBe('select')
  })
})
