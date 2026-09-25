/**
 * base.svg editor preview component.
 *
 * Renders the sanitised inline SVG into the canvas so WYSIWYG matches the
 * published output. The markup is sanitised here too (never trust that the
 * Properties panel already did it) before being injected.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { sanitizeSvg } from '@core/sanitize'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { resolveSvgHostTag } from './hostTag'
import { splitSvgRoot } from './splitSvgRoot'
import type { SvgStoredProps } from './props'

export const SvgEditor: React.FC<ModuleComponentProps<SvgStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
}) => {
  const markup = sanitizeSvg(props.svg)

  if (!markup) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<ImageSolidIcon size={20} aria-hidden="true" />}
        label="No SVG"
      />
    )
  }

  // `style` is pulled OUT of the wrapper bag rather than replaced — the node's
  // own inline styles (`node.inlineStyles`, e.g. a `color` a source SVG's
  // `currentColor` fill reads) still need to land on this element.
  const { style: nodeStyle, ...editorProps } = nodeWrapperProps ?? {}
  const label = String(props.title ?? '').trim()
  const labelProps = label ? { role: 'img', 'aria-label': label } : {}

  // The source wrote this element itself — `<span className={styles.icon}
  // dangerouslySetInnerHTML={{__html: icon}} />`, the standard way a real repo
  // inlines a `?raw` icon. Render it as its real tag with its real box: the
  // class on it is what sizes and colours the icon, and the near-universal
  // pairing (`.icon { width: 24px }` + `.icon svg { width: 100% }`) resolves
  // the inner graphic against THIS element. See `resolveSvgHostTag` for what
  // went wrong when this element was collapsed into the box-less host below.
  const hostTag = resolveSvgHostTag(props.tag)
  if (hostTag) {
    return React.createElement(hostTag, {
      ...editorProps,
      ...(nodeStyle ? { style: nodeStyle } : {}),
      className: mcClassName,
      ...labelProps,
      dangerouslySetInnerHTML: { __html: markup },
    })
  }

  // No authored wrapper: the source wrote a bare `<svg>`, and the node IS that
  // `<svg>`. It is rendered as itself — its own attributes, the node's editor
  // props, and its children as `__html` — so the canvas DOM is the app's DOM:
  // `.row > svg`, `svg:first-child` and `svg + span` match here exactly as they
  // do in the user's app, and the element has a box the resize offer can size.
  //
  // The class and inline style are the NODE's (`mcClassName`, `nodeStyle`),
  // which is where an optimistic edit lands before the reparse; the markup's
  // own copy is only the fallback for a node that has none.
  const root = splitSvgRoot(markup)
  if (root) {
    const style = root.style || nodeStyle ? { ...root.style, ...nodeStyle } : undefined
    return React.createElement('svg', {
      ...root.attributes,
      ...editorProps,
      ...(style ? { style } : {}),
      className: mcClassName || root.className,
      ...labelProps,
      dangerouslySetInnerHTML: { __html: root.inner },
    })
  }

  // Markup that is not one `<svg>` element — two graphics, or loose text, which
  // only a hand-entered CMS `svg` prop can hold; a parsed `<svg>` always has one
  // root. There is no element to render as, so a box-less span carries the
  // editor wiring instead. `display: contents` keeps it from adding a line box
  // of its own around the graphics (`board-27f`, [24,44] instead of [24,24]).
  return (
    <span
      {...editorProps}
      style={{ ...nodeStyle, display: 'contents' }}
      className={mcClassName}
      {...labelProps}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
