/**
 * base.svg — inline SVG module.
 *
 * Stores a raw inline-SVG markup string (`svg`) and emits it verbatim, after
 * the publisher boundary sanitises it via the DOMPurify SVG profile
 * (`escapeProps` → `sanitizeSvg`). Inline (vs. an `<img src>`) so the SVG can
 * inherit `currentColor` and be styled by user CSS classes — the way logos and
 * icons are authored in real sites.
 *
 * The `svg` prop key is recognised by `escapeProps` as an SVG boundary, so it
 * is neither HTML-escaped (which would print `&lt;svg&gt;`) nor richtext-
 * stripped (which would remove every SVG tag).
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { Value } from '@core/utils/typeboxHelpers'
import { SvgEditor } from './SvgEditor'
import { resolveSvgHostTag } from './hostTag'
import { SvgPropsSchema, type SvgStoredProps } from './props'

export const SvgModule: ModuleDefinition<SvgStoredProps> = {
  id: 'base.svg',
  name: 'SVG',
  description: 'Inline vector graphic (logo or icon).',
  category: 'Media',
  version: '1.0.0',
  icon: ImageSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    svg: {
      type: 'svg',
      label: 'SVG',
      category: 'content',
    },
    title: {
      type: 'text',
      label: 'Accessible label',
      category: 'content',
      placeholder: 'e.g. Company logo',
    },
  },

  propsSchema: SvgPropsSchema,

  defaults: Value.Create(SvgPropsSchema),

  component: SvgEditor,

  // The element this node actually IS in the source: the graphic itself for a
  // literal `<svg>`, or the wrapper the author wrote around a `?raw` icon.
  // Drives the tree-ladder badge, which would otherwise label an authored
  // `<span>` as an `<svg>`.
  htmlTag: (props) => resolveSvgHostTag(props.tag) ?? 'svg',

  render: (props) => {
    // `props.svg` was already sanitised at the escapeProps boundary; this is
    // the final, safe markup. An a11y label, when present, is added to the
    // root element so the inline graphic announces itself.
    const markup = String(props.svg ?? '')
    if (!markup.trim()) return { html: '' }

    const label = String(props.title ?? '').trim()
    // Inject role/aria-label onto the opening <svg> tag.
    const graphic = label
      ? markup.replace(/^(\s*<svg\b)/i, `$1 role="img" aria-label="${label}"`)
      : markup

    // Re-emit the element the source wrote around the graphic. Without it the
    // node's classIds land on the `<svg>` itself, so the `.icon svg { … }` half
    // of the standard icon-sizing pair matches nothing and the published page
    // disagrees with both the canvas and the project's own dev build.
    // `resolveSvgHostTag` returns only safe, non-void lowercase tag names, so
    // this is already escape-safe to interpolate.
    const hostTag = resolveSvgHostTag(props.tag)
    if (hostTag) return { html: `<${hostTag}>${graphic}</${hostTag}>` }
    return { html: graphic }
  },
}

registry.registerOrReplace(SvgModule)
