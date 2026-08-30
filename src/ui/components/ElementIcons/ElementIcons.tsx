/**
 * ElementIcons — glyphs for the canvas notch's element primitives.
 *
 * These are hand-drawn rather than imported from `pixel-art-icons` because the
 * vendored catalogue has no mark for any of the three: a bare letterform, a
 * Figma-style frame crosshair, and a Figma-style section outline. They live in
 * `src/ui/` for the same reason `AlmLogo` does — it is the one place the icon
 * gates exempt, precisely so bespoke marks have an honest home instead of
 * being smuggled into a component file (`icon-catalog-integrity` Gate 3).
 *
 * They match the vendored set's drawing conventions exactly, so they sit next
 * to real pixel-art icons in the same toolbar without looking foreign:
 * `viewBox="0 0 24 24"`, `fill={color}` with `currentColor` as the default,
 * and a single path built only from axis-aligned segments on a 2px grid — no
 * curves and no strokes, which is what makes the set read as pixel art.
 *
 * Each implements `IconComponent` (`size`/`color`/`className`/`style`), so the
 * notch's `renderActionButton` takes them through the same `icon` slot a
 * vendored icon uses.
 */
import type { IconProps } from 'pixel-art-icons/types'

/**
 * A capital T — the universal "text" mark, and what the user of a design tool
 * expects on the button that adds a text element.
 */
export function TextGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M4 4h16v2h-7v14h-2V6H4V4Z" />
    </svg>
  )
}

/**
 * The frame crosshair: two verticals and two horizontals crossing, ends
 * overhanging — Figma's frame mark, and the one every designer reads as
 * "a box that holds things". Used for the `<div>` primitive.
 */
export function FrameGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M7 3h2v18H7zM15 3h2v18h-2zM3 7h18v2H3zM3 15h18v2H3z" />
    </svg>
  )
}

/**
 * A square outline with its top-left corner stepped inward — Figma's section
 * mark. Used for the `<span>` primitive: a wrapper that groups a run of
 * content rather than laying it out.
 */
export function SectionGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M10 4h10v2H10zM18 4h2v16h-2zM4 18h16v2H4zM4 10h2v10H4zM8 6h2v2H8zM6 8h2v2H6z" />
    </svg>
  )
}
