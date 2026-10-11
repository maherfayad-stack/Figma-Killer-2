/**
 * ElementIcons — glyphs for the canvas notch: its element primitives (text,
 * frame, section) and its armed draw tools (rectangle, ellipse, pen).
 *
 * These are hand-drawn rather than imported from `pixel-art-icons` because the
 * vendored catalogue has no mark for any of them: a bare letterform, a
 * Figma-style frame crosshair, a Figma-style section outline, and the three
 * shape/vector tool marks. They live in
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

/**
 * A square outline — the rectangle tool (R). A ring, not a solid square: the
 * inner square winds the other way, so the default nonzero fill leaves it
 * empty, and a solid square would read as a fill swatch rather than a tool.
 */
export function RectangleGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
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
      <path d="M4 5h16v14H4V5Zm2 2v10h12V7H6Z" />
    </svg>
  )
}

/**
 * A stepped circle outline — the ellipse tool (O). Pixel art has no curves, so
 * the circle is eight axis-aligned runs on the 2px grid.
 */
export function EllipseGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
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
      <path d="M8 4h8v2H8zM8 18h8v2H8zM4 8h2v8H4zM18 8h2v8h-2zM6 6h2v2H6zM16 6h2v2h-2zM6 16h2v2H6zM16 16h2v2h-2z" />
    </svg>
  )
}

/**
 * A pen nib pointing down — the pen tool (P), the mark every designer reads as
 * "draw a vector path": cap, shoulders, breather hole, and the slit to the tip.
 */
export function PenGlyphIcon({ size = 24, color = 'currentColor', className, style }: IconProps) {
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
      <path d="M9 3h6v3H9zM7 7h10v2H7zM7 9h2v4H7zM15 9h2v4h-2zM11 10h2v2h-2zM9 13h2v2H9zM13 13h2v2h-2zM11 15h2v6h-2z" />
    </svg>
  )
}
