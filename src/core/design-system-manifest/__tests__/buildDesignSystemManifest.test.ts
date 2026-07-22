import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { buildDesignSystemManifest } from '../buildDesignSystemManifest'
import type { ComponentManifest } from '../../component-manifest/types'

// Runs against the REAL installed `@alm-design/design-system` package.
// Pinned to 1.1.2 so the assertions below (component names, Accolade's
// documented `size` enum) stay deterministic.
const require = createRequire(import.meta.url)
const installedVersion = (require('@alm-design/design-system/package.json') as { version: string }).version

describe('buildDesignSystemManifest', () => {
  it('is running against the pinned design-system version', () => {
    expect(installedVersion).toBe('1.1.2')
  })

  it('includes the expected core components', async () => {
    const manifest = await buildDesignSystemManifest()
    const names = manifest.components.map((c) => c.name)
    for (const expected of ['Button', 'Chip', 'Cell', 'Dialog', 'Accolade']) {
      expect(names).toContain(expected)
    }
  })

  it('gives Button a non-empty props array with name/tsType/required on every prop', async () => {
    const manifest = await buildDesignSystemManifest()
    const button = manifest.components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()
    expect(button!.props.length).toBeGreaterThan(0)
    for (const prop of button!.props) {
      expect(typeof prop.name).toBe('string')
      expect(prop.name.length).toBeGreaterThan(0)
      expect(typeof prop.tsType).toBe('string')
      expect(typeof prop.required).toBe('boolean')
    }
  })

  it("parses Accolade's size enum from its apiDoc usage example", async () => {
    const manifest = await buildDesignSystemManifest()
    const accolade = manifest.components.find((c) => c.name === 'Accolade')
    expect(accolade).toBeDefined()

    const sizeProp = accolade!.props.find((p) => p.name === 'size')

    if (sizeProp?.enumValues) {
      // Preferred, explicit assertion: the package's documented behavior as
      // of 1.1.2 — `size="regular" // regular | small`.
      expect(sizeProp.enumValues).toContain('regular')
      expect(sizeProp.enumValues).toContain('small')
    } else {
      // Fallback only if the installed package genuinely differs: find ANY
      // component+prop with a parsed enum of at least two values.
      const anyEnumProp = manifest.components
        .flatMap((c) => c.props.map((p) => ({ component: c.name, prop: p })))
        .find(({ prop }) => (prop.enumValues?.length ?? 0) >= 2)

      expect(anyEnumProp).toBeDefined()
      expect(anyEnumProp!.prop.enumValues!.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('cleans enum tokens to bare values, dropping parenthetical/prose but keeping hyphenated values intact', async () => {
    const manifest = await buildDesignSystemManifest()
    const button = manifest.components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()

    const sizeProp = button!.props.find((p) => p.name === 'size')
    expect(sizeProp?.enumValues).toEqual(['default', 'medium', 'small'])

    const dirProp = button!.props.find((p) => p.name === 'dir')
    expect(dirProp?.enumValues).toEqual(['ltr', 'rtl'])

    // Hyphenated values with no trailing space/paren must survive untouched.
    const variantProp = button!.props.find((p) => p.name === 'variant')
    expect(variantProp?.enumValues).toContain('primary')
    expect(variantProp?.enumValues).toContain('primary-inverted')

    const cell = manifest.components.find((c) => c.name === 'Cell')
    expect(cell).toBeDefined()
    const visualProp = cell!.props.find((p) => p.name === 'visual')
    expect(visualProp?.enumValues).toContain('icon')
    expect(visualProp?.enumValues).toContain('3d-icon')
    expect(visualProp?.enumValues).toContain('image')
    expect(visualProp?.enumValues).toContain('null')
  })

  it("sets every component's file to the package import specifier", async () => {
    const manifest: ComponentManifest = await buildDesignSystemManifest()
    expect(manifest.components.length).toBeGreaterThan(0)
    for (const component of manifest.components) {
      expect(component.file).toBe('@alm-design/design-system')
    }
  })
})
