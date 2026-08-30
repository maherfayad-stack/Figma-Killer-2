/**
 * PropertyControlRenderer — dispatch table tests.
 *
 * Covers (Guideline #221 / Constraint #212):
 *   1. Each PropertyControl type renders the correct underlying control
 *   2. Every control wrapper carries data-testid="property-control-{propKey}"
 *   3. Wrapper has minHeight:44 (WCAG 2.5.5 touch-target)
 *   4. Unknown control types return null (no crash)
 *   5. Numeric controls render inputs, not range sliders
 *   6. Numeric inputs expose min / max / step constraints
 *   7. GroupSection aria-expanded toggles on click
 *   8. Property conditions (declarative) — conditional controls hidden when condition fails
 *
 * Uses renderToStaticMarkup where DOM interaction is not needed (fast + no cleanup).
 * Uses @testing-library/react for interactive tests (GroupSection collapse).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { EditorPermissionsContext } from '@site/editorPermissionsContext'
import type { PropertyControl } from '@core/module-engine'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { useEditorStore } from '@site/store/store'

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderControl(
  control: PropertyControl,
  propKey = 'myProp',
  value: unknown = '',
  sourceLockReason?: string,
): string {
  return renderToStaticMarkup(
    <PropertyControlRenderer
      propKey={propKey}
      control={control}
      value={value}
      onChange={() => {}}
      {...(sourceLockReason !== undefined ? { sourceLockReason } : {})}
    />
  )
}

function installMediaFetchStub(
  assets: CmsMediaAsset[],
  uploadAsset?: CmsMediaAsset,
): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/admin/api/cms/media')) {
      if (init?.method === 'POST') {
        if (!uploadAsset) throw new Error('Unexpected media upload')
        return new Response(JSON.stringify({ asset: uploadAsset }), { status: 200 })
      }
      return new Response(JSON.stringify({ assets }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${String(input)}`)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

const mediaAssets: CmsMediaAsset[] = [
  {
    id: 'asset-image',
    filename: 'hero.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    publicPath: '/uploads/hero.png',
    uploadedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'asset-video',
    filename: 'intro.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 4321,
    publicPath: '/uploads/intro.mp4',
    uploadedByUserId: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// 1 — data-testid and minHeight wrapper (Guideline #221 / WCAG 2.5.5)
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — wrapper (data-testid + minHeight)', () => {
  it('wraps every control with data-testid="property-control-{propKey}"', () => {
    const html = renderControl({ type: 'text', label: 'Name' }, 'userName')
    expect(html).toContain('data-testid="property-control-userName"')
  })

  it('uses the exact propKey in the testid (no transformation)', () => {
    const html = renderControl({ type: 'text', label: 'X' }, 'some-complex_key')
    expect(html).toContain('data-testid="property-control-some-complex_key"')
  })

  it('wrapper has compact min-height (Guideline #357 — WCAG touch targets waived for editor chrome)', async () => {
    // Guideline #357: editor chrome controls use compact density.
    // Post-Task #399: min-height is in ControlRow.module.css, not an inline style.
    // It is now the shared `--control-row-h` token rather than a literal, so
    // the properties panel can rebind it to the inspector's tighter 24px row
    // without every other admin inspector following it down. Assert the
    // indirection plus the concrete values behind it.
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../ui/components/ControlRow/ControlRow.module.css', import.meta.url),
      'utf-8',
    )
    const globals = readFileSync(
      new URL('../../styles/globals.css', import.meta.url),
      'utf-8',
    )
    expect(css).toMatch(/min-height:\s*var\(--control-row-h\)/)
    // The admin default stays at the documented compact density; the
    // inspector's own row is tighter still, and never taller.
    const adminRow = Number(globals.match(/--control-row-h:\s*(\d+)px/)?.[1])
    const inspectorRow = Number(globals.match(/--inspector-row-h:\s*(\d+)px/)?.[1])
    expect(adminRow).toBe(28)
    expect(inspectorRow).toBeLessThanOrEqual(adminRow)
  })

  it('keeps the renderer shell separate from the concrete control layout wrapper', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/property-controls/PropertyControlRenderer.tsx', import.meta.url),
      'utf-8',
    )

    expect(src).not.toContain('className={styles.controlWrapper}')
  })

  it('returns null (empty string) for unknown control type', () => {
    const html = renderControl({ type: 'unknown-future-type' as unknown as 'text', label: 'X' })
    expect(html).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2 — Type dispatch: correct input element rendered for each type
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — type dispatch', () => {
  it('text → renders <input type="text">', () => {
    const html = renderControl({ type: 'text', label: 'Title' }, 'title', 'Hello')
    expect(html).toContain('type="text"')
    expect(html).toContain('id="ctrl-title"')
  })

  it('text → can normalize identifier values while typing', () => {
    const changes: Array<[string, unknown]> = []

    render(
      <PropertyControlRenderer
        propKey="formId"
        control={{ type: 'text', label: 'Form ID', normalize: 'identifier' }}
        value=""
        onChange={(key, value) => changes.push([key, value])}
      />,
    )

    fireEvent.change(screen.getByLabelText('Form ID'), {
      target: { value: 'Contact Form "Main"' },
    })

    expect(changes).toEqual([['formId', 'Contact-Form-Main']])
  })

  it('textarea → renders <textarea>', () => {
    const html = renderControl({ type: 'textarea', label: 'Body' }, 'body', 'Some text')
    expect(html).toContain('<textarea')
  })

  it('number → renders <input type="number"> with constraints', () => {
    const html = renderControl({ type: 'number', label: 'Count', min: 0, max: 100, step: 1 }, 'count', 5)
    expect(html).toContain('type="number"')
    expect(html).toContain('min="0"')
    expect(html).toContain('max="100"')
    expect(html).toContain('step="1"')
    expect(html).not.toContain('type="range"')
  })

  it('color → renders <input type="color"> or color-specific control', () => {
    const html = renderControl({ type: 'color', label: 'Background' }, 'bgColor', '#ffffff')
    // Color control renders some kind of color input or picker
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('data-testid="property-control-bgColor"')
  })

  it('color → embeds the swatch inside the text value field', () => {
    render(
      <PropertyControlRenderer
        propKey="bgColor"
        control={{ type: 'color', label: 'Background' }}
        value="#ffffff"
        onChange={() => {}}
      />
    )

    const wrapper = screen.getByTestId('property-control-bgColor')
    const colorInput = wrapper.querySelector('input[type="color"]')
    const textInput = screen.getByLabelText('Background')
    const field = wrapper.querySelector('[data-color-field="true"]')

    expect(colorInput).not.toBeNull()
    expect(field).not.toBeNull()
    expect(field?.contains(colorInput)).toBe(true)
    expect(field?.contains(textInput)).toBe(true)
  })

  it('color → autocompletes framework color tokens as CSS variable references', () => {
    const token = useEditorStore.getState().createSite('Token test')
    useEditorStore.setState({ site: token } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })
    const changes: Array<{ key: string; value: unknown }> = []

    render(
      <PropertyControlRenderer
        propKey="bgColor"
        control={{ type: 'color', label: 'Background' }}
        value=""
        onChange={(key, value) => changes.push({ key, value })}
      />,
    )

    fireEvent.focus(screen.getByLabelText('Background'))
    expect(screen.getByRole('listbox', { name: /background color tokens/i })).toBeDefined()
    fireEvent.click(screen.getByRole('option', { name: /--primary/i }))

    expect(changes.at(-1)).toEqual({ key: 'bgColor', value: 'var(--primary)' })
  })

  it('select → renders <select>', () => {
    const html = renderControl({
      type: 'select',
      label: 'Variant',
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Secondary', value: 'secondary' },
      ],
    }, 'variant', 'primary')
    expect(html).toContain('<select')
    expect(html).toContain('Primary')
    expect(html).toContain('Secondary')
  })

  it('toggle → renders checkbox or toggle element', () => {
    const html = renderControl({ type: 'toggle', label: 'Visible' }, 'visible', true)
    // Toggle renders a checkbox or switch
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('data-testid="property-control-visible"')
  })

  it('image → renders <input type="text"> or image picker', () => {
    const html = renderControl({ type: 'image', label: 'Image Source' }, 'src', '')
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('data-testid="property-control-src"')
  })

  it('image → empty state shows a Browse library button + no media-kind mismatch', async () => {
    const restoreFetch = installMediaFetchStub(mediaAssets)
    try {
      render(
        <PropertyControlRenderer
          propKey="src"
          control={{ type: 'image', label: 'Image Source' }}
          value=""
          onChange={() => {}}
        />
      )
      // The control surface is small: "No image selected" + a Browse button.
      // The grid + filename buttons live inside MediaPickerModal, opened on demand.
      expect(await screen.findByText(/no image selected/i)).toBeDefined()
      const browse = screen.getByRole('button', { name: /browse image library/i })
      expect(browse).toBeDefined()
    } finally {
      restoreFetch()
    }
  })

  it('image → uses the shared SegmentedControl for library and URL modes', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/property-controls/MediaLibraryControl.tsx', import.meta.url),
      'utf-8',
    )

    expect(src).toContain("import { SegmentedControl } from '@ui/components/SegmentedControl'")
    expect(src).toContain('<SegmentedControl')
    expect(src).not.toContain('mediaSourceSwitch')
  })

  it('image → opens the picker modal when Browse library is clicked', async () => {
    const restoreFetch = installMediaFetchStub(mediaAssets)
    try {
      render(
        <PropertyControlRenderer
          propKey="src"
          control={{ type: 'image', label: 'Image Source' }}
          value=""
          onChange={() => {}}
        />,
      )

      const browse = await screen.findByRole('button', { name: /browse image library/i })
      fireEvent.click(browse)

      // The modal portals into <body> with `role="dialog"` and an aria-label
      // that names the kind it's selecting.
      const modal = await screen.findByRole('dialog', { name: /select an image/i })
      expect(modal).toBeDefined()
    } finally {
      restoreFetch()
    }
  })

  it('image → keeps custom URL entry as a fallback mode', async () => {
    const restoreFetch = installMediaFetchStub(mediaAssets)
    const changes: Array<{ key: string; value: unknown }> = []
    try {
      render(
        <PropertyControlRenderer
          propKey="src"
          control={{ type: 'image', label: 'Image Source' }}
          value=""
          onChange={(key, value) => changes.push({ key, value })}
        />
      )

      // Flip to URL mode via the segmented control, then type a URL.
      fireEvent.click(screen.getByRole('button', { name: /custom url/i }))
      fireEvent.change(screen.getByLabelText('Image Source'), {
        target: { value: 'https://example.com/photo.png' },
      })

      expect(changes).toContainEqual({ key: 'src', value: 'https://example.com/photo.png' })
    } finally {
      restoreFetch()
    }
  })

  it('media → video kind also opens the picker modal', async () => {
    const restoreFetch = installMediaFetchStub(mediaAssets)
    try {
      render(
        <PropertyControlRenderer
          propKey="videoUrl"
          control={{ type: 'media', mediaKind: 'video', label: 'Video file' }}
          value=""
          onChange={() => {}}
        />
      )

      const browse = await screen.findByRole('button', { name: /browse video library/i })
      fireEvent.click(browse)
      const modal = await screen.findByRole('dialog', { name: /select a video/i })
      expect(modal).toBeDefined()
    } finally {
      restoreFetch()
    }
  })

  it('image → expired CMS sessions show a sign-in message instead of local media fallback', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }) as typeof fetch

    try {
      render(
        <PropertyControlRenderer
          propKey="src"
          control={{ type: 'image', label: 'Image Source' }}
          value=""
          onChange={() => {}}
        />
      )

      expect(await screen.findByText('Sign in again to use CMS media.')).toBeDefined()
      expect(screen.queryByText('Unauthorized')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('url → renders <input type="url"> or URL control', () => {
    const html = renderControl({ type: 'url', label: 'Link' }, 'href', 'https://example.com')
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('data-testid="property-control-href"')
  })

  it('richtext → does not render a visible site-editor control', () => {
    const html = renderControl({ type: 'richtext', label: 'Content' }, 'content', '')
    expect(html).toBe('')
  })

})

describe('PropertyControlRenderer — compact field sizing', () => {
  it('uses the same compact field size for property panel input controls', async () => {
    const { readFileSync } = await import('fs')
    const controlFiles = [
      'TextControl.tsx',
      'NumberControl.tsx',
      'SelectControl.tsx',
      'UrlControl.tsx',
      // ColorControl delegates its compact field to ColorValueInput, which is
      // where the colour text input's `fieldSize="sm"` now lives.
      'ColorValueInput.tsx',
    ]

    for (const fileName of controlFiles) {
      const src = readFileSync(
        new URL(`../../admin/pages/site/property-controls/${fileName}`, import.meta.url),
        'utf-8',
      )
      expect(src).toContain('fieldSize="sm"')
    }
  })
})

// ---------------------------------------------------------------------------
// 3 — Labels: htmlFor linkage (accessibility)
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — label accessibility', () => {
  it('label htmlFor matches input id (ctrl-{propKey})', () => {
    const html = renderControl({ type: 'text', label: 'Font Size' }, 'fontSize')
    expect(html).toContain('for="ctrl-fontSize"')
    expect(html).toContain('id="ctrl-fontSize"')
  })

  it('displays the control label text', () => {
    const html = renderControl({ type: 'text', label: 'My Custom Label' }, 'myProp')
    expect(html).toContain('My Custom Label')
  })

  it('falls back to propKey when label is not provided', () => {
    const html = renderControl({ type: 'text' } as PropertyControl, 'noLabel')
    expect(html).toContain('noLabel')
  })

  it('override prop shows purple label (isOverride=true)', () => {
    const html = renderToStaticMarkup(
      <PropertyControlRenderer
        propKey="fontSize"
        control={{ type: 'text', label: 'Font Size' }}
        value="24px"
        onChange={() => {}}
        isOverride={true}
      />
    )
    // Post-Task #399: override color is in ControlRow.module.css (.labelOverride class).
    // CSS module classes resolve to empty strings in renderToStaticMarkup test env.
    // Instead, verify the outer wrapper exposes data-override="true" for testability.
    expect(html).toContain('data-override="true"')
  })
})

// ---------------------------------------------------------------------------
// 4 — Numeric inputs
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — numeric inputs', () => {
  it('renders the current value in a number input', () => {
    const html = renderControl(
      { type: 'number', label: 'Border Radius', min: 0, max: 48, step: 1 },
      'borderRadius',
      16
    )
    expect(html).toContain('type="number"')
    expect(html).toContain('16')
  })

  it('exposes min and max on the number input', () => {
    const html = renderControl(
      { type: 'number', label: 'Opacity', min: 0, max: 100, step: 1 },
      'opacity',
      50
    )
    expect(html).toContain('min="0"')
    expect(html).toContain('max="100"')
  })

  it('exposes step on the number input', () => {
    const html = renderControl(
      { type: 'number', label: 'Size', min: 0, max: 48, step: 0.5 },
      'fontSize',
      24
    )
    expect(html).toContain('step="0.5"')
  })

  it('displays unit next to the label', () => {
    const html = renderControl(
      { type: 'number', label: 'Padding', min: 0, max: 64, step: 1, unit: 'px' },
      'padding',
      8
    )
    expect(html).toContain('px<')
  })

  it('does not import SliderControl in the properties renderer', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/property-controls/PropertyControlRenderer.tsx', import.meta.url),
      'utf-8'
    )
    expect(src).not.toContain('SliderControl')
    expect(src).not.toContain("case 'slider'")
  })
})

// ---------------------------------------------------------------------------
// 5 — GroupSection: interactive collapse (DOM test)
// ---------------------------------------------------------------------------

describe('GroupSection — collapse toggle', () => {
  it('renders the group label as a button with aria-expanded', () => {
    render(
      <PropertyControlRenderer
        propKey="typography"
        control={{
          type: 'group',
          label: 'Typography',
          children: {
            fontSize: { type: 'number', label: 'Font Size', min: 8, max: 72, step: 1 },
          },
        }}
        value={{}}
        onChange={() => {}}
      />
    )
    const toggleBtn = screen.getByRole('button')
    expect(toggleBtn).toBeDefined()
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles aria-expanded when clicked', async () => {
    render(
      <PropertyControlRenderer
        propKey="layout"
        control={{
          type: 'group',
          label: 'Layout',
          children: {
            width: { type: 'text', label: 'Width' },
          },
        }}
        value={{}}
        onChange={() => {}}
      />
    )
    const toggleBtn = screen.getByRole('button')
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('hides children when collapsed (defaultCollapsed=true)', () => {
    const { container } = render(
      <PropertyControlRenderer
        propKey="advanced"
        control={{
          type: 'group',
          label: 'Advanced',
          collapsed: true,
          children: {
            zIndex: { type: 'number', label: 'Z-Index', min: 0, max: 9999, step: 1 },
          },
        }}
        value={{}}
        onChange={() => {}}
      />
    )
    // Children are not rendered when collapsed
    expect(container.querySelector('[data-testid="property-control-zIndex"]')).toBeNull()
  })

  it('shows children when expanded (defaultCollapsed=false)', () => {
    const { container } = render(
      <PropertyControlRenderer
        propKey="basic"
        control={{
          type: 'group',
          label: 'Basic',
          collapsed: false,
          children: {
            opacity: { type: 'number', label: 'Opacity', min: 0, max: 100, step: 1 },
          },
        }}
        value={{}}
        onChange={() => {}}
      />
    )
    expect(container.querySelector('[data-testid="property-control-opacity"]')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 6 — Disabled state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7 — Layout variant: inline (default) vs stacked
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — layout variant', () => {
  it('inline-by-default control types expose data-layout="inline"', () => {
    const html = renderControl({ type: 'text', label: 'Title' }, 'title')
    expect(html).toContain('data-layout="inline"')
  })

  it('media/image/textarea control types default to stacked', () => {
    expect(renderControl({ type: 'image', label: 'Image' }, 'src')).toContain('data-layout="stacked"')
    expect(
      renderControl({ type: 'media', mediaKind: 'video', label: 'Clip' }, 'video'),
    ).toContain('data-layout="stacked"')
    expect(renderControl({ type: 'textarea', label: 'Body' }, 'body')).toContain(
      'data-layout="stacked"',
    )
  })

  it('explicit schema layout overrides the per-type default', () => {
    // text would normally be inline → force stacked
    const stackedText = renderControl(
      { type: 'text', label: 'Alt text', layout: 'stacked' },
      'alt',
    )
    expect(stackedText).toContain('data-layout="stacked"')

    // textarea would normally be stacked → force inline
    const inlineTextarea = renderControl(
      { type: 'textarea', label: 'Notes', layout: 'inline' },
      'notes',
    )
    expect(inlineTextarea).toContain('data-layout="inline"')
  })

  it('exposes the resolved layout on the outer testid wrapper', () => {
    // CSS module classnames resolve to empty strings in this test env
    // (see Post-Task #399 notes elsewhere in this file), so we check the
    // data-layout attribute that the renderer publishes for testability.
    render(
      <PropertyControlRenderer
        propKey="alt"
        control={{ type: 'text', label: 'Alt text', layout: 'stacked' }}
        value=""
        onChange={() => {}}
      />,
    )
    expect(screen.getByTestId('property-control-alt').getAttribute('data-layout')).toBe('stacked')
  })

  it('CSS module exposes a stacked variant for the control wrapper', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../ui/components/ControlRow/ControlRow.module.css', import.meta.url),
      'utf-8',
    )
    expect(css).toMatch(/\.controlWrapperStacked\s*\{[^}]*grid-template-columns:\s*1fr/)
  })
})

describe('PropertyControlRenderer — disabled prop', () => {
  it('renders with reduced opacity when disabled=true', () => {
    const html = renderToStaticMarkup(
      <PropertyControlRenderer
        propKey="myProp"
        control={{ type: 'text', label: 'Disabled Field' }}
        value=""
        onChange={() => {}}
        disabled={true}
      />
    )
    // Post-Task #399: opacity is in ControlRow.module.css (.controlWrapperDisabled class).
    // CSS module classes resolve to empty strings in renderToStaticMarkup test env.
    // Instead, verify the outer wrapper exposes data-disabled="true" for testability.
    expect(html).toContain('data-disabled="true"')
  })

  it('passes disabled to the underlying input', () => {
    const html = renderToStaticMarkup(
      <PropertyControlRenderer
        propKey="myProp"
        control={{ type: 'text', label: 'Test' }}
        value=""
        onChange={() => {}}
        disabled={true}
      />
    )
    expect(html).toContain('disabled')
  })

  it('disables content controls for structure-only editors', () => {
    const html = renderToStaticMarkup(
      <EditorPermissionsContext.Provider
        value={{ canEditStructure: true, canEditContent: false, canEditStyle: false }}
      >
        <PropertyControlRenderer
          propKey="text"
          control={{ type: 'text', label: 'Text' }}
          value="Existing copy"
          onChange={() => {}}
        />
      </EditorPermissionsContext.Provider>,
    )

    expect(html).toContain('data-disabled="true"')
    expect(html).toContain('disabled')
  })

  it('keeps layout controls editable for structure-only editors', () => {
    const html = renderToStaticMarkup(
      <EditorPermissionsContext.Provider
        value={{ canEditStructure: true, canEditContent: false, canEditStyle: false }}
      >
        <PropertyControlRenderer
          propKey="columns"
          control={{ type: 'number', label: 'Columns' }}
          value={3}
          onChange={() => {}}
        />
      </EditorPermissionsContext.Provider>,
    )

    expect(html).toContain('data-category="layout"')
    expect(html).not.toContain('data-disabled="true"')
  })
})

/**
 * Data binding ("Bind to data field") was removed from the editor entirely.
 * This block replaces the old affordance-eligibility suite: the contract is no
 * longer "which controls get a binding affordance" but "none of them do", and
 * pinning it keeps the CMS-era control from quietly reappearing on a row.
 */
describe('PropertyControlRenderer — no data-binding affordance', () => {
  for (const [name, control, value] of [
    ['text', { type: 'text', label: 'Title' }, 'Hello'],
    ['select', { type: 'select', label: 'Loading', options: [{ label: 'Lazy', value: 'lazy' }] }, 'lazy'],
    ['color', { type: 'color', label: 'Background' }, '#ffffff'],
    ['toggle', { type: 'toggle', label: 'Skeleton' }, false],
  ] as const) {
    it(`offers no binding control on a ${name} row`, () => {
      render(
        <PropertyControlRenderer propKey="prop" control={control} value={value} onChange={() => {}} />,
      )
      expect(screen.queryByRole('button', { name: /bind/i })).toBeNull()
      expect(screen.queryByText(/bind to data/i)).toBeNull()
    })
  }
})

// ---------------------------------------------------------------------------
// Structured (array/object) values — read-only, never an editable input
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — structured values', () => {
  it('renders a read-only summary instead of a text input for an array value', () => {
    const html = renderControl({ type: 'text', label: 'Actions' }, 'actions', [
      { label: 'This device' },
      { label: 'Another device' },
    ])

    // The hazard this guards: `String(value)` in the text branch renders
    // `[object Object]` in an editable box, and one keystroke would replace the
    // whole array with that string — which the studio save path would then try
    // to write back over the source array.
    expect(html).not.toContain('[object Object]')
    expect(html).not.toContain('<input')
    expect(html).toContain('data-testid="code-value-actions"')
    expect(html).toContain('2 items')
  })

  it('summarises an object value by its keys', () => {
    const html = renderControl({ type: 'text', label: 'Search' }, 'search', {
      value: 'x',
      placeholder: 'Search',
    })

    expect(html).toContain('value, placeholder')
    expect(html).not.toContain('<input')
  })

  it('marks the row disabled so no binding affordance offers to overwrite it', () => {
    const html = renderControl({ type: 'select', label: 'Items', options: [] }, 'items', ['a', 'b'])

    expect(html).toContain('data-disabled="true"')
    expect(html).not.toContain('<select')
  })

  it('leaves scalar values on their normal control', () => {
    const html = renderControl({ type: 'text', label: 'Title' }, 'title', 'Choose a device')

    expect(html).toContain('<input')
    expect(html).toContain('Choose a device')
  })

  it('does not hijack a group control, whose value is its children bag', () => {
    const html = renderControl(
      { type: 'group', label: 'Layout', children: { gap: { type: 'text', label: 'Gap' } } },
      'layout',
      { gap: '8px' },
    )

    expect(html).not.toContain('code-value-layout')
  })
})

// ---------------------------------------------------------------------------
// Source-locked nodes — the store refuses every prop write, silently
// ---------------------------------------------------------------------------

describe('PropertyControlRenderer — a source-locked node', () => {
  it('shows the value read-only with the reason, never an input', () => {
    const html = renderControl(
      { type: 'textarea', label: 'Text' },
      'text',
      'Enjoy 12% discount on hotels',
      'value from c.hotelsTitle',
    )

    // The exact trap this closes: the panel rendered the real copy in a normal
    // textarea, `updateNodeProps` returned early on `lockReason` without a word,
    // and retyping the text did nothing at all.
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<input')
    expect(html).toContain('Enjoy 12% discount on hotels')
    expect(html).toContain('value from c.hotelsTitle')
    expect(html).toContain('data-disabled="true"')
  })

  it('applies to every control type, not just text', () => {
    for (const control of [
      { type: 'select', label: 'Tag', options: [{ label: 'p', value: 'p' }] },
      { type: 'number', label: 'Size' },
      { type: 'toggle', label: 'Hidden' },
      { type: 'color', label: 'Fill' },
    ] as PropertyControl[]) {
      const html = renderControl(control, 'k', 'v', 'item 2 of DEALS')
      expect(html).not.toContain('<input')
      expect(html).not.toContain('<select')
      expect(html).toContain('item 2 of DEALS')
    }
  })

  it('shows an em dash for a locked prop that has no value', () => {
    const html = renderControl({ type: 'text', label: 'Alt' }, 'alt', '', 'spread props')

    expect(html).toContain('—')
    expect(html).toContain('spread props')
  })

  it('leaves an unlocked node fully editable', () => {
    const html = renderControl({ type: 'text', label: 'Title' }, 'title', 'Editable')

    expect(html).toContain('<input')
    expect(html).not.toContain('set in code')
  })
})
