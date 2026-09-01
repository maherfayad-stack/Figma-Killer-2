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

  // `style` is pulled OUT of the wrapper bag and merged with `display:
  // contents` rather than replaced — the node's own inline styles
  // (`node.inlineStyles`, e.g. a `color` a source SVG's `currentColor`
  // fill reads) still need to land on this element.
  //
  // `display: contents` because a raw `<svg>` reached through an inline
  // JSX-element prop (`<Cell icon={<svg .../>}/>`, and the identical case
  // one level inside a fragment slot, `icon={<><A/><svg/></>}`) is meant
  // to sit as a DIRECT child of its parent in the rendered design — the
  // source never wrote a wrapping element around it. Before this, the
  // plain (block-default-inline) `<span>` this element mounts under DID
  // generate its own box: an inline element's line box is taller than a
  // same-height block child sized purely by content, so every cell using
  // this shape rendered 20px taller on the canvas than in a real browser
  // (measured: two `.cell__visual--icon` cells on a real board, [24,44]
  // instead of [24,24]). `nodeVisualRect` already falls back to the union
  // of a box-less node's children for exactly this shape (the design-system
  // host div in `src/modules/alm/register.tsx` uses the identical pattern),
  // so selection/hover geometry is unaffected.
  const { style: nodeStyle, ...editorProps } = nodeWrapperProps ?? {}
  const style: React.CSSProperties = { ...nodeStyle, display: 'contents' }

  const label = String(props.title ?? '').trim()
  return (
    <span
      {...editorProps}
      style={style}
      className={mcClassName}
      {...(label ? { role: 'img', 'aria-label': label } : {})}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
