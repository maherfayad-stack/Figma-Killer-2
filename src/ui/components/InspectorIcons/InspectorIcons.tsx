/**
 * InspectorIcons — glyphs for the properties panel's icon toggle groups.
 *
 * Figma's inspector names a value with a picture, not a word: text alignment
 * is four bar-stack marks, not a dropdown reading "left / center / right".
 * That is what lets a 240px panel hold what ours needed 360px and a 100px
 * label column for. The vendored `pixel-art-icons` catalogue has the ten
 * flex-alignment marks but nothing for text alignment, decoration, slant,
 * flow direction, line height, or letter spacing — so those are drawn here.
 *
 * They live in `src/ui/` for the same reason `ElementIcons` and `AlmLogo` do:
 * it is the one place the icon gates exempt (`icon-catalog-integrity` Gate 3),
 * precisely so bespoke marks have an honest home instead of being smuggled
 * into a panel component.
 *
 * Drawing conventions match the vendored set exactly, so these sit beside a
 * real pixel-art icon in the same toggle group without looking foreign:
 * `viewBox="0 0 24 24"`, `fill={color}` defaulting to `currentColor`, and a
 * single path built only from axis-aligned segments on a 2px grid — no
 * curves, no strokes. A diagonal is a staircase of 2×2 blocks, which is what
 * makes the set read as pixel art rather than as a downscaled vector.
 *
 * Each implements `IconComponent` (`size`/`color`/`className`/`style`), so a
 * `SegmentedControl` option takes them through the same `icon` slot a
 * vendored icon uses.
 */
import type { IconProps } from 'pixel-art-icons/types'

/**
 * Shared shell. Every glyph in this file differs only by its path data, so
 * the eleven SVG attributes that must stay identical live in exactly one
 * place — a copy-paste divergence here would show up as one icon in a toggle
 * group sitting a pixel off from its neighbours.
 */
function Glyph({ d, size = 24, color = 'currentColor', className, style }: IconProps & { d: string }) {
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
      <path d={d} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Text alignment — four bar stacks. The long bars are the full measure; the
// short ones are the ragged edge, and which side they hang from is the whole
// message.
// ---------------------------------------------------------------------------

export function TextAlignLeftIcon(props: IconProps) {
  return <Glyph {...props} d="M3 5h18v2H3V5Zm0 4h12v2H3V9Zm0 4h18v2H3v-2Zm0 4h12v2H3v-2Z" />
}

export function TextAlignCenterIcon(props: IconProps) {
  return <Glyph {...props} d="M3 5h18v2H3V5Zm3 4h12v2H6V9Zm-3 4h18v2H3v-2Zm3 4h12v2H6v-2Z" />
}

export function TextAlignRightIcon(props: IconProps) {
  return <Glyph {...props} d="M3 5h18v2H3V5Zm6 4h12v2H9V9Zm-6 4h18v2H3v-2Zm6 4h12v2H9v-2Z" />
}

export function TextAlignJustifyIcon(props: IconProps) {
  return <Glyph {...props} d="M3 5h18v2H3V5Zm0 4h18v2H3V9Zm0 4h18v2H3v-2Zm0 4h18v2H3v-2Z" />
}

// ---------------------------------------------------------------------------
// Type style — slant, decoration, and the "no decoration" slash.
// ---------------------------------------------------------------------------

/** A serifed I sheared right, built as three 2px steps between its two bars. */
export function TextItalicIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M11 4h9v2h-9V4Zm4 2h3v4h-3V6Zm-2 4h3v4h-3v-4Zm-2 4h3v4h-3v-4ZM4 18h9v2H4v-2Z"
    />
  )
}

/** A T with a rule straight through it. */
export function TextStrikethroughIcon(props: IconProps) {
  return <Glyph {...props} d="M6 4h12v2h-5v5h-2V6H6V4Zm-3 8h18v2H3v-2Zm8 4h2v4h-2v-4Z" />
}

/** A 45° staircase — the panel's universal "none / unset / clear". */
export function NoneSlashIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M5 17h2v2H5v-2Zm2-2h2v2H7v-2Zm2-2h2v2H9v-2Zm2-2h2v2h-2v-2Zm2-2h2v2h-2V9Zm2-2h2v2h-2V7Zm2-2h2v2h-2V5Z"
    />
  )
}

// ---------------------------------------------------------------------------
// Type metrics — the two fields Figma labels with a glyph inside the input
// rather than a caption beside it.
// ---------------------------------------------------------------------------

/** Two text rules with a capped vertical measure between them. */
export function LineHeightIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M3 4h6v2H3V4Zm2 2h2v12H5V6Zm-2 12h6v2H3v-2Zm8-14h10v2H11V4Zm0 14h10v2H11v-2Z"
    />
  )
}

/** A letterform pinned between two measure bars. */
export function LetterSpacingIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M3 4h2v16H3V4Zm16 0h2v16h-2V4ZM10 8h4v2h-4V8Zm-1 2h2v6H9v-6Zm4 0h2v6h-2v-6Zm-3 2h4v2h-4v-2Z"
    />
  )
}

// ---------------------------------------------------------------------------
// Flex flow — three children in a track, the first one drawn oversized so the
// direction (and therefore the reverse variants) is legible at 14px.
// ---------------------------------------------------------------------------

export function FlowRowIcon(props: IconProps) {
  return <Glyph {...props} d="M4 5h4v14H4V5Zm6 2h4v10h-4V7Zm6 0h4v10h-4V7Z" />
}

export function FlowRowReverseIcon(props: IconProps) {
  return <Glyph {...props} d="M16 5h4v14h-4V5Zm-6 2h4v10h-4V7Zm-6 0h4v10H4V7Z" />
}

export function FlowColumnIcon(props: IconProps) {
  return <Glyph {...props} d="M5 4h14v4H5V4Zm2 6h10v4H7v-4Zm0 6h10v4H7v-4Z" />
}

export function FlowColumnReverseIcon(props: IconProps) {
  return <Glyph {...props} d="M5 16h14v4H5v-4Zm2-6h10v4H7v-4Zm0-6h10v4H7V4Z" />
}

// ---------------------------------------------------------------------------
// Display — the three that earn a mark. `inline`, `inline-block` and the long
// tail keep words; a picture for them would be a puzzle, not a label.
// ---------------------------------------------------------------------------

/** A filled block spanning the measure. */
export function DisplayBlockIcon(props: IconProps) {
  return <Glyph {...props} d="M3 6h18v5H3V6Zm0 7h18v5H3v-5Z" />
}

/** Three children in a row — the same mark as flow-row, without the emphasis. */
export function DisplayFlexIcon(props: IconProps) {
  return <Glyph {...props} d="M4 7h4v10H4V7Zm6 0h4v10h-4V7Zm6 0h4v10h-4V7Z" />
}

/** A 2×2 lattice. */
export function DisplayGridIcon(props: IconProps) {
  return <Glyph {...props} d="M4 5h7v7H4V5Zm9 0h7v7h-7V5ZM4 14h7v7H4v-7Zm9 0h7v7h-7v-7Z" />
}

// ---------------------------------------------------------------------------
// Size constraints — the four fields Figma writes as marks rather than as
// "Min W" / "Max H". The distinction the pair has to carry is which way the
// arrows point: INTO a limit for a minimum ("at least this"), OUT to a pair
// of walls for a maximum ("no further than this"). Heads are a single 2px
// step, not the vendored set's three, because these render at 13px inside a
// field rather than at 24 on a toolbar.
// ---------------------------------------------------------------------------

/** Two arrows converging on one bar — `→|←`. */
export function MinWidthIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M11 4h2v16h-2V4ZM2 11h7v2H2v-2Zm5-2h2v2H7V9Zm0 4h2v2H7v-2Zm8-2h7v2h-7v-2Zm0-2h2v2h-2V9Zm0 4h2v2h-2v-2Z"
    />
  )
}

/** One arrow spanning two walls — `|↔|`. */
export function MaxWidthIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M2 4h2v16H2V4Zm18 0h2v16h-2V4ZM6 11h12v2H6v-2Zm2-2h2v2H8V9Zm0 4h2v2H8v-2Zm6-4h2v2h-2V9Zm0 4h2v2h-2v-2Z"
    />
  )
}

/** The vertical `MinWidthIcon` — two arrows converging on one rule. */
export function MinHeightIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M4 11h16v2H4v-2ZM11 2h2v7h-2V2ZM9 7h2v2H9V7Zm4 0h2v2h-2V7Zm-2 8h2v7h-2v-7Zm-2 0h2v2H9v-2Zm4 0h2v2h-2v-2Z"
    />
  )
}

/** The vertical `MaxWidthIcon` — one arrow spanning two rules. */
export function MaxHeightIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M4 2h16v2H4V2Zm0 18h16v2H4v-2ZM11 6h2v12h-2V6ZM9 8h2v2H9V8Zm4 0h2v2h-2V8Zm-4 6h2v2H9v-2Zm4 0h2v2h-2v-2Z"
    />
  )
}

// ---------------------------------------------------------------------------
// Misc field marks
// ---------------------------------------------------------------------------

/** A frame with two opposed corner brackets — the crop/ratio mark. */
export function AspectRatioIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M3 5h18v2H3V5Zm0 12h18v2H3v-2ZM3 5h2v14H3V5Zm16 0h2v14h-2V5ZM7 9h5v2H9v3H7V9Zm10 6h-5v-2h3v-3h2v5Z"
    />
  )
}

/**
 * A square half-filled down the middle — solid on one side, empty on the
 * other. The same "this much of it is there" mark Figma puts on opacity.
 */
export function OpacityIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M5 5h14v2H5V5Zm0 12h14v2H5v-2ZM5 5h2v14H5V5Zm12 0h2v14h-2V5Zm-5 2h5v10h-5V7Z"
    />
  )
}

/** Two panels with a marked channel between them — the flex/grid gap. */
export function GapIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M3 4h6v16H3V4Zm12 0h6v16h-6V4Zm-4 3h2v3h-2V7Zm0 5h2v3h-2v-3Zm0 5h2v2h-2v-2Zm0-13h2v2h-2V4Z"
    />
  )
}

// ---------------------------------------------------------------------------
// Border marks
// ---------------------------------------------------------------------------

/** Three rules of increasing weight — the stroke-width field's mark. */
export function StrokeWeightIcon(props: IconProps) {
  return <Glyph {...props} d="M3 5h18v1H3V5Zm0 5h18v2H3v-2Zm0 6h18v4H3v-4Z" />
}

/** A corner turning through a stepped quarter-round. */
export function CornerRadiusIcon(props: IconProps) {
  return (
    <Glyph
      {...props}
      d="M3 12h2v9H3v-9Zm9-9h9v2h-9V3ZM3 10h2v2H3v-2Zm1-2h2v2H4V8Zm2-2h2v2H6V6Zm2-2h2v2H8V4Zm2-1h2v2h-2V3Z"
    />
  )
}
