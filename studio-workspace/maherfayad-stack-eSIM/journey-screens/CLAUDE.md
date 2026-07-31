<!-- @alm-design/design-system: CLAUDE.md -->
# ALM 2.0 Design System

React component library and token system for Almosafer OTA. Built with Vite as an ES module library; peer deps are React 19.

Primarily designed for **mobile products** (full-viewport screens, no page-level wrapper). Can also be used for web/web apps — in that case a max-width layout container is appropriate. Never add a wrapper by default; let the consumer project define its own layout shell.

> **See also:** `design.md` — design intent, content guidelines, writing rules, and usage decision logic for each component. `CLAUDE.md` covers the technical API; `design.md` covers the *why* and *when*.

## Installation & import

```js
// in the consumer project's package.json
"design-system": "file:../design-system"  // or npm/git reference

// entry point
import {
  Button, IconButton, GlassButton, Tag, Chip, Cell, ListItem, Separator,
  Banner, SystemBanner, AdBanner, VisualCard, BottomActionBar, Navbar,
  Checkbox, Radio, Toggle, SegmentedControl,
  TextInput, Search, Slider, Stepper, ProgressStepper, CircularProgressIndicator, LinearProgressIndicator,
  Callout, Accolade, Badge, Tooltip,
  Snackbar, TabBar, BottomSheet, Dialog, ActionSheet,
  MarketingCard, Expander, Accordion,
  DesignSystemProvider,
} from 'design-system'
import 'design-system/dist/index.css'     // required — loads all tokens + component CSS
```

Tokens and component JS are bundled into `dist/index.js`; styles are a separate CSS file that **must** be imported once at the app root.

### DesignSystemProvider — set `platform` / `dir` once

Platform-aware components (`Dialog`, `ActionSheet`, `BottomSheet`, `TabBar`, `SegmentedControl`) and every component's `dir` resolve their values in this order: **explicit prop > nearest `DesignSystemProvider` > built-in default** (`platform="ios"`, `dir="ltr"`). Wrap the app (or any subtree) to set these once instead of repeating them on every component — ideal for prototypes that toggle iOS/Android or LTR/RTL globally:

```jsx
<DesignSystemProvider platform="android" dir="rtl">
  <Dialog title="…" actions={[…]} />   {/* inherits platform + dir, no props needed */}
  <BottomSheet open title="…">…</BottomSheet>
  <TabBar items={[…]} value={0} onChange={fn} />
</DesignSystemProvider>
```

- The provider is **optional** — components used without one fall back to the defaults, so nothing breaks.
- An explicit prop always wins, so you can override a single component inside a provider.
- `usePlatform(prop)` and `useDir(prop)` hooks are exported for building new platform-aware components (see *Platform variants* under Conventions).

---

## Design tokens

All tokens are CSS custom properties on `:root`. Import `src/tokens/index.css` (or the compiled `dist/index.css`) to get them all. JS mirrors are exported from `src/tokens/tokens.js` for use in inline styles, animations, or tests.

### Colors — `--color-*`

Raw palette tokens. Use semantic tokens (`--background-*`, `--text-*`, etc.) in component CSS; reach for raw tokens only when no semantic alias fits.

**Neutral** (adaptive — flip in dark mode):

| Token | Light | Dark |
|---|---|---|
| `--color-metal` | `#1C1C1C` | `#F8F9F9` |
| `--color-chateau` | `#66797F` | `#929FA3` |
| `--color-montreal` | `#A1AAAD` | `#515B5E` |
| `--color-gainsboro` | `#D8DCDE` | `#3C4244` |
| `--color-alice` | `#EDF1F3` | `#2C2F30` |
| `--color-ghost` | `#F7F9FA` | `#232525` |
| `--color-light` | `#FFFFFF` | `#1C1C1C` |
| `--color-light-40` | `rgba(255,255,255,.4)` | `rgba(28,28,28,.4)` |
| `--color-light-92` | `rgba(255,255,255,.92)` | `rgba(28,28,28,.92)` |
| `--color-black-50` | `rgba(0,0,0,.5)` | `rgba(0,0,0,.5)` |

`--color-black-50` is static (stays black in dark mode); `--color-light-40` / `-92` flip to `#1C1C1C`.

**Static** (never flip): `--color-white-static` `#FFFFFF` · `--color-metal-static` `#1C1C1C`

**Aqua** (primary brand — adaptive):

| Token | Light | Dark |
|---|---|---|
| `--color-aqua-10` | `#E9F6F8` | `#1F2A2C` |
| `--color-aqua-30` | `#BDE4EA` | `#24464B` |
| `--color-aqua-50` | `#91D2DC` | `#2A626B` |
| `--color-aqua-100` | `#0C9AB0` | `#07ACC5` |
| `--color-aqua-200` | `#008296` | `#0394AA` |

**Coral** (warning/destructive — adaptive):

| Token | Light | Dark |
|---|---|---|
| `--color-coral-10` | `#F4E3E4` | `#59393E` |
| `--color-coral-100` | `#EF4550` | `#E9666F` |
| `--color-coral-200` | `#D23241` | `#EA3944` |

**Forest** (success — adaptive):

| Token | Light | Dark |
|---|---|---|
| `--color-forest-10` | `#EAF5EB` | `#1B2C1C` |
| `--color-forest-100` | `#319E37` | `#599B5D` |
| `--color-forest-200` | `#0A8A11` | `#26972C` |

**Butter** (caution — adaptive):

| Token | Light | Dark |
|---|---|---|
| `--color-butter-10` | `#FEF5E6` | `#30291D` |
| `--color-butter-100` | `#FE9C09` | `#E79924` |

**Purple** (`lavender` / `iris` adaptive; `amethyst` static):

| Token | Light | Dark |
|---|---|---|
| `--color-lavender` | `#F7F1FF` | `#34303F` |
| `--color-iris` | `#E8D4FF` | `#6127AA` |
| `--color-amethyst` | `#875BF7` | `#875BF7` |

`--color-amethyst` is the **PurpleBlue gradient's start stop** (paired with `--color-dodger`); it's static and named so native code can reference the stop.

**Brand partners** (static): `--color-apple` `--color-almosafer` `--color-whatsapp` `--color-facebook` `--color-shukran` `--color-shukran-contrast` `--color-qitaf` `--color-mokafaa` `--color-emkan` `--color-alfursan`

`--color-apple` is the exception — it's **adaptive** (`#000000` → `#F8F9F9`), so the Apple Pay button (`--background-brand-apple`) is black on light, near-white on dark.

**Gradient colors** (static): the individual stops the gradient tokens are built from, each named so native (iOS/Android) code can reference a single stop instead of a hex literal. A fully-opaque stop is one word; a single hue reused at multiple opacities carries the opacity number. The gradient tokens under **Gradients** compose these via `var()`.

| Token | Value | Stop of |
|---|---|---|
| `--color-sulu` | `#CEFF99` | NeonGreen (start) |
| `--color-mint` | `#99FFDF` | NeonGreen (end) |
| `--color-dodger` | `#2E90FA` | PurpleBlue (end; start is `--color-amethyst`, in Purple) |
| `--color-bondi` | `#00879C` | AquaGreen (start) |
| `--color-glacier` | `#01BAD7` | AquaGreen (mid) |
| `--color-malachite` | `#0CB038` | AquaGreen (end) |
| `--color-grey-10` / `-30` | `#697586` @ 10% / 30% | GreyLeading |
| `--color-blue-10` / `-30` | `#2E90FA` @ 10% / 30% | BlueLeading |
| `--color-green-10` / `-30` | `#66C61C` @ 10% / 30% | GreenLeading |
| `--color-purple-10` / `-30` | `#875BF7` @ 10% / 30% | PurpleLeading |
| `--color-black-70` | `#000000` @ 70% | BlackLeading / BlackBottom |
| `--color-black-40` | `#000000` @ 40% | BlackTop |

### Semantic tokens — `--background-*` `--text-*` `--border-*` `--icon-*`

Prefer semantic tokens in component CSS. Pattern: `{category}-{intent}-{state}`.

**Backgrounds:**

```
--background-base-default / subtle / hover / pressed / active / disabled / inverted / selected / default-static

--background-primary-default / subtle / hover / pressed / selected / disabled

--background-warning-default / subtle / hover / pressed / selected
--background-success-default / subtle / hover / pressed / selected
--background-caution-default / subtle

--background-neutral-default / subtle / selected / disabled

--background-brand-apple / almosafer / whatsapp / facebook
--background-brand-shukran / shukran-contrast / qitaf / mokafaa / emkan / alfursan
```

**Text:**

```
--text-base-default          → --color-metal
--text-base-subtext          → --color-chateau
--text-base-inverted         → --color-light
--text-base-disabled         → --color-montreal
--text-base-inverted-static  → --color-white-static
--text-base-default-static   → --color-metal-static
--text-link-default / hover / pressed
--text-warning-default / hover / pressed
--text-success-default / hover / pressed
```

**Borders:**

```
--border-base-default / subtle / hover / pressed / selected / focused / disabled / inverted

--border-primary-default / hover / pressed / selected / active        (coral — warning/destructive)

--border-secondary-default / hover / pressed / selected / disabled     (aqua — brand/interactive)

--border-success-default
--border-caution-default
```

**Icons:**

```
--icon-base-default / subtle / inverted / disabled
--icon-base-inverted-static / base-default-static

--icon-primary-default / hover / pressed / subtle      (coral — warning/destructive)
--icon-secondary-default / hover / pressed / subtle    (aqua — brand/interactive)

--icon-success-default / subtle
--icon-caution-default / subtle
```

**AI** (AI-surface tokens, grouped under one `--ai-*` namespace):

```
--ai-background         → --color-lavender      (AI surfaces)
--ai-text-default       → --color-amethyst      (static — no dark-mode flip)
--ai-text-highlight     → --gradient-purple-blue   (PurpleBlue gradient)
--ai-border-default     → --color-iris
--ai-border-highlight   → --gradient-purple-blue   (PurpleBlue gradient)
--ai-icon               → --gradient-purple-blue   (PurpleBlue gradient)
```

`--ai-background` (lavender) and `--ai-border-default` (iris) are adaptive; `--ai-text-default` (amethyst) is **static**, so AI text holds its value in dark mode instead of flipping with the surface — check its contrast on the dark AI surface.

**Overlays:**

```
--overlay-default   → --color-black-50  (modal scrims)
--overlay-surface   → --color-light-40  (glass surface tint)
--overlay-navbar    → --color-light-92  (navbar blur layer)
```

**Gradient** (image scrims — dark → transparent, for laying over imagery):

```
--gradient-horizontal       → --gradient-black-leading (dark on the leading edge)
--gradient-vertical-bottom  → --gradient-black-bottom  (dark on the bottom)
--gradient-vertical-top     → --gradient-black-top     (dark on the top)
```

**Gradients:**

Each gradient composes named **Gradient colors** stops (above) via `var()` — the hex values live on the stops, not here. These are the **color-named base gradients**: the intent-named aliases that point at them — `--gradient-horizontal` / `-vertical-bottom` / `-vertical-top` (scrims, above), `--banner-*`, and `--highlight-*` (below) — share or wrap this layer but express a *use*, not a color. Prefer those aliases in component CSS.

```
--gradient-neon-green     NeonGreen     sulu → mint
--gradient-aqua-green     AquaGreen     bondi → glacier → malachite
--gradient-purple-blue    PurpleBlue    amethyst → dodger
--gradient-grey-leading   GreyLeading   grey-10 → grey-30
--gradient-blue-leading   BlueLeading   blue-10 → blue-30
--gradient-green-leading  GreenLeading  green-10 → green-30
--gradient-purple-leading PurpleLeading purple-10 → purple-30
--gradient-black-leading  BlackLeading  black-70 → transparent (horizontal, leading → trailing)
--gradient-black-bottom   BlackBottom   black-70 → transparent (vertical, bottom → top)
--gradient-black-top      BlackTop      black-40 → transparent (vertical, top → bottom)
```

`--gradient-black-leading` / `-bottom` / `-top` are black gradients (dark → transparent); the suffix marks which edge is darkest. Being color-named base gradients (not intent-named), they describe the color, not a use — reach for the semantic scrim alias (`--gradient-horizontal` / `-vertical-bottom` / `-vertical-top`) in component CSS where one fits.

**Banner** (gradient backgrounds for banner components):

```
--banner-neutral   → --gradient-grey-leading
--banner-info      → --gradient-blue-leading
--banner-promo     → --gradient-green-leading
--banner-featured  → --gradient-purple-leading
```

**Highlight** (gradient backgrounds for highlight/accolade labels):

```
--highlight-title    → --gradient-aqua-green
--highlight-accolade → --gradient-purple-blue
--highlight-benefit  → --gradient-neon-green
```

**Button backgrounds:**

```
--button-primary-default / hover / pressed
--button-secondary-default / hover / pressed
--button-destructive-default / hover / pressed
--button-payment-default / hover / pressed
--button-inverted-default / hover / pressed
```

### Spacing — `--space-*`

Base unit: 8px.

| Token | Value |
|---|---|
| `--space-2xs` | 2px |
| `--space-xs` | 4px |
| `--space-sm` | 8px |
| `--space-md` | 12px |
| `--space` | 16px |
| `--space-lg` | 24px |
| `--space-xl` | 32px |
| `--space-2xl` | 40px |
| `--space-3xl` | 48px |
| `--space-4xl` | 64px |
| `--space-container` | 16px |
| `--space-card-gap` | 12px |
| `--space-section` | 32px |

### Border radius — `--rounded-*`

`--rounded-xs` (4px) · `--rounded-sm` (8px) · `--rounded` (12px) · `--rounded-lg` (16px) · `--rounded-popover` (34px) · `--rounded-full` (100px)

### Elevation — `--elevation-*`

`--elevation-floating` — upward shadow (bottom sheets, sticky bars)
`--elevation-raised` — downward shadow (cards, modals)

### Typography — `--type-*` / `--font-*`

Fonts: `--font-display` = Open Sans · `--font-body` = Open Sans · Arabic (`[dir="rtl"]`): Noto Sans Arabic — all loaded via Google Fonts (weights 400, 600, 700)

**Scales:**

| Scale | Family | Size | Weight | Line-height | Letter-spacing |
|---|---|---|---|---|---|
| `display` | display | 34px | 600 | 52px | -1px |
| `headline` | display | 26px | 600 | 40px | -0.6px |
| `title` | body | 18px | 600 | 28px | -0.2px |
| `titleBold` | body | 18px | 700 | 28px | -0.2px |
| `subtitle` | body | 16px | 600 | 24px | — |
| `subtitleBold` | body | 16px | 700 | 24px | — |
| `eyebrow` | body | 12px | 400 | 16px | +1.5px |
| `body` (regular) | body | 14px | 400 | 20px | — |
| `body` (semibold) | body | 14px | 600 | 20px | — |
| `body` (bold) | body | 14px | 700 | 20px | — |
| `caption` (regular) | body | 12px | 400 | 16px | — |
| `caption` (semibold) | body | 12px | 600 | 16px | — |
| `meta` (regular) | body | 11px | 400 | 14px | — |
| `meta` (semibold) | body | 11px | 600 | 14px | — |

**Token naming:**

Display, headline, title, subtitle, eyebrow — each scale has its own full set:
```
--type-{scale}-family   --type-{scale}-size   --type-{scale}-weight
--type-{scale}-lh       --type-{scale}-ls     (letter-spacing, where non-zero)
```

Body, caption, meta — size and line-height are shared across regular/semibold; family and weight are per-variant. Bold weight is available for body only:
```
--type-body-size / lh
--type-body-regular-family / regular-weight
--type-body-semibold-family / semibold-weight
--type-body-bold-weight

--type-caption-size / lh
--type-caption-regular-family / regular-weight
--type-caption-semibold-family / semibold-weight

--type-meta-size / lh
--type-meta-regular-family / regular-weight
--type-meta-semibold-family / semibold-weight
```

Title and subtitle each have a bold weight variant:
```
--type-title-bold-weight
--type-subtitle-bold-weight
```

**Utility class:** `.eyebrow` — applies eyebrow scale with `text-transform: uppercase` and `--text-base-subtext` color. Use on label elements that precede a heading or group.

---

## Components

All components accept `className` and spread remaining props onto the root element unless noted.

### Button

```jsx
<Button
  variant="primary"          // primary | primary-inverted | secondary | secondary-inverted | destructive | payment | apple-pay | gpay-card | gpay-personalized | gpay-pay-with | gpay-checkout-with | skeleton
  size="default"             // default (48px) | medium (40px) | small (32px) — text/payment only; brand-pay variants are single fixed size
  label="Label"
  leadingIcon={<SvgIcon />}  // optional icon before the label (text variants)
  trailingIcon={<SvgIcon />} // optional icon after the label (text variants)
  cardArt="/card.png"        // selected-card thumbnail — apple-pay / gpay-card / gpay-personalized (img URL string or node); defaults to a bundled sample, pass false to hide
  cardLast4="1394"           // masked card number shown by gpay-personalized (defaults to "1394")
  dir="ltr"                  // ltr | rtl — via useDir; also localizes the gpay "…with" labels
/>
```

- Text is set via the `label` prop — the component does **not** render `children`
- Sizes are padding-driven: `default` 48px (16/24 label, 24px icons), `medium` 40px (14/20 label, 20px icons), `small` 32px (12/16 label, 16px icons). Radius is always `--rounded-full`. Borders (destructive, secondary-inverted) are drawn as a 1px **inset box-shadow** so they don't add to the height
- **Pressed "push":** on `:active` every button shrinks 1px on all sides (padding shaved via the `--btn-py`/`--btn-px` size vars) while a compensating 1px margin keeps its layout footprint fixed — so it reads as pushed-in without shifting neighbors. Paired with the darker pressed fill
- **Icon slots:** the text variants (`primary`, `primary-inverted`, `secondary`, `secondary-inverted`, `destructive`) accept optional `leadingIcon` / `trailingIcon` nodes, sized per size and tinted via `currentColor` to match the label. They are **opt-in** node props (undefined = hidden) — the Figma default of both-icons-on is a showcase/demo convention, not a component default, so existing buttons across the app are unaffected
- **Fills / borders / text per variant** (all via `--button-*` / semantic tokens — adaptive, so they flip in dark mode):
  - `primary` — `--button-primary-*` fill (aqua), white-static label, no border
  - `secondary` — `--button-secondary-*` fill (**alice**, `#EDF1F3` → ghost on hover), aqua (`--text-link-default`) label, no border. It is a **filled** button, not transparent
  - `destructive` — white fill (`--button-destructive-*`), 1px coral border (`--border-primary-*`), coral label (`--text-warning-*`); all three darken from coral-100 → coral-200 on hover/press
  - `primary-inverted` — white fill (`--button-inverted-*`), aqua label, **no border**. For dark / image surfaces
  - `secondary-inverted` — **transparent** fill, 1px subtle border (`--border-base-*`: gainsboro → aqua on hover), **white-static** label. For dark / image surfaces
- `payment` — green fill (`--button-payment-*`), white label, a `lockCheck` icon (padlock + tick) and a tighter 6px gap; pass text via `label`. Sizes: `default` / `medium`
- `skeleton` renders a `<span>` shimmer placeholder (no `label`); fixed width per size
- `disabled` renders the Figma disabled style — `--background-neutral-disabled` (alice) fill, `--text-base-disabled` (montreal) label/icons, no border, no pointer events (it is **not** an opacity change, and it overrides the variant styling uniformly)
- **Brand-pay variants** (`apple-pay`, `gpay-*`) carry brand-locked marks — do **not** recolor the marks:
  - `apple-pay` — **adaptive** surface `--background-brand-apple` (black in light → near-white in dark). The official Apple Pay mark (`applepay-mark.svg`) is inlined and rides on `color: --icon-base-inverted`, so it inverts with the surface (white mark on the black light button, dark mark on the near-white dark button); **no separate label text**. **Single fixed size (48px) — `size` does not apply.** The selected-card thumbnail (divider + `cardArt`) shows by default; pass `cardArt={false}` for the plain Apple Pay button
  - `gpay-*` — **static dark** surface (`--color-metal-static`, does not flip). Google's lockup has a fixed white "Pay" wordmark, so the button must stay dark in both themes (a light Google Pay button needs a separate dark-wordmark lockup, not shipped)
  - `gpay-card` — Google Pay lockup + divider + card thumbnail (card shown by default; `cardArt={false}` hides it)
  - `gpay-personalized` — Google Pay lockup + divider + `cardArt` + a masked `•••• {cardLast4}` number (always shown)
  - `gpay-pay-with` / `gpay-checkout-with` — a fixed "Pay with" / "Checkout with" label before the lockup. This copy is **Google-mandated, so `label` is ignored**; only `dir` localizes it ("الدفع باستخدام" / "إتمام الدفع باستخدام"). Google Pay buttons are a fixed height (52px) with a brand-locked `#3c4043` border; `size` does not apply
  - Brand assets live in `src/icons/logotypes/payment/`: `gpay-lockup.svg` (horizontal G-mark + "Pay" wordmark, distinct from the 24×24 square `gpay.svg`), `applepay-mark.svg` (Apple glyph + "Pay"), and `card-sample.png` (the default card thumbnail — replace `cardArt` with the user's real funding card in production)

### IconButton

```jsx
<IconButton
  variant="primary"   // primary | secondary | overlay | grey
  size="default"      // default (48px) | medium (40px) | small (32px)
  icon={<SvgIcon />}
  aria-label="action"
/>
```

Square button, full-radius pill. Icon slot is sized automatically per size variant.

- `overlay` — `--overlay-default` scrim background with `--icon-base-inverted-static` icon; for placing over imagery
- `grey` — `--background-base-subtle` background with `--icon-secondary-default` icon

### GlassButton

Translucent "liquid glass" action button for navigation bars and overlays atop imagery. The content layout is chosen by `type`, the surface treatment by `bg`. Used by `Navbar` (iOS back / trailing actions) and reusable elsewhere.

```jsx
<GlassButton
  bg="default"            // default (light glass) | primary (aqua fill) | dim (dark glass)
  type="back"             // back | label | back-label | 1-icon | 2-icons | x
  label="Label"           // for type="label" / "back-label"
  icon1={<SvgIcon />}     // for type="1-icon" / "2-icons" (leading)
  icon2={<SvgIcon />}     // for type="2-icons" (trailing)
  onClick={fn}
  aria-label="Back"       // set for icon-only types
  dir="ltr"               // ltr | rtl — via useDir; the back chevron mirrors automatically
/>
```

- Renders a native `<button type="button">`; remaining props (incl. `disabled`, `onClick`) spread onto it. 44px tall; single-glyph types (`back`, `1-icon`, `x`) are 44×44 circles, the rest are pills.
- **`bg`**: `default` uses the shared `--liquid-glass-bg` + blur with dark (`--icon-base-default`) content; `primary` is a solid `--background-primary-default` (aqua) with white content; `dim` is a dark glass for placing over photos, with white content.
- `type` picks the content: `back` (chevron, RTL-mirrored), `label` (text), `back-label` (chevron + text), `1-icon`/`2-icons` (consumer icons via `icon1`/`icon2`), `x` (close). The back chevron and × are built-in DS line-icons; pass your own glyphs for the icon types.
- The label uses subtitle (16px semibold) typography. The liquid-glass surface is the same CSS approximation used by `Search`/`BottomSheet` (no Figma refraction mask).

### Tag

```jsx
<Tag
  label="Label"
  variant="default"           // default | warning | caution | success | neutral
  style="tinted"              // tinted | filled
  leadingIcon={<SvgIcon />}   // optional icon before the label
  trailingIcon={<SvgIcon />}  // optional icon after the label
  skeleton={false}            // true renders a 48×20 shimmer placeholder, ignores other props
/>
```

Inline label chip, fixed 20px height. Text is set via the `label` prop (not children). `default` + `tinted` gives a neutral subtle background; other `variant`/`style` combinations select colored backgrounds via the `tag--{variant}-{style}` class.

### Chip

Interactive filter/selection chip — a pill `<button>` with optional leading icon and dropdown chevron.

```jsx
<Chip
  label="Label"
  selected={false}       // applies selected styling
  dropdown={false}       // appends a trailing chevron-down icon (filter/picker trigger)
  icon={<SvgIcon />}     // optional leading icon
  state="default"        // default | error
  skeleton={false}       // true renders a shimmer placeholder, ignores other props
  dir="ltr"              // ltr | rtl
/>
```

- Renders a native `<button type="button">`; remaining props (including `disabled`, `onClick`) spread onto it
- `dropdown` adds a trailing chevron — use for chips that open a filter/picker
- `state="error"` adds the error modifier class
- `skeleton` renders a placeholder span and ignores all other props

### Separator

```jsx
<Separator
  type="cell separator"   // cell separator (default) | section separator
  variant="simple"        // simple (default) | or | dashed
  label="OR"              // overrides the OR label (variant="or" only); defaults to "OR"/"أو" by dir
  dir="ltr"               // ltr | rtl — only affects the OR label
/>
```

- Default (`type="cell separator"`, `variant="simple"`) renders a full-width 1px `<hr>` using `--border-base-default`, no margin. Use between list items or content modules.
- `variant="or"` renders a `<div role="separator">` with a centered label between two lines (for "OR" dividers)
- `variant="dashed"` renders a dashed `<hr>`
- `type="section separator"` renders a thicker section divider as a `<div role="separator">`

### Cell

List row component with leading visual, content block, and trailing indicator.

```jsx
<Cell
  visual="icon"          // icon (24px) | 3d-icon (40px, rounded) | image (64px, rounded) | null (no visual)
  icon={<SvgIcon />}     // node, or image URL string, rendered in the visual slot
  iconSrc="/icon.png"    // image URL for the visual slot
  title="Caption"        // optional caption line above label
  label="Label text"
  subtext="Caption"      // optional caption line below label
  value="Value text"     // trailing value text
  sideIcon={<SvgIcon />} // optional trailing icon (node)
  sideIconSrc="/i.png"   // optional trailing icon (image URL)
  tag="New"              // optional trailing Tag; string or Tag props object
  trailing="chevron"     // chevron (default) | toggle | stepper | none
  toggleChecked={false}  // toggle state when trailing="toggle"
  onToggleChange={fn}    // toggle change handler
  stepperValue={1}       // Stepper value when trailing="stepper"
  stepperMin={0}         // Stepper lower bound (default 0)
  stepperMax={9}         // optional Stepper upper bound
  onStepperChange={fn}   // Stepper change handler — (n) => …
  selected={false}       // selected state — background-base-selected + border-base-selected
  showSeparator={true}   // renders a 1px bottom Separator
  dir="ltr"              // ltr | rtl — flips chevron direction
/>
```

- `trailing="stepper"` renders a `Stepper` in the trailing slot, mutually exclusive with `chevron` / `toggle` (exactly like `toggle`). Wire `stepperValue` + `onStepperChange`, and optionally `stepperMin` / `stepperMax`; the buttons swap sides in RTL. Use for rows that adjust a count in place (e.g. travelers, room quantity) — `value` / `sideIcon` / `tag` can still sit alongside it
- `selected` applies `--background-base-selected` with a `--border-base-selected` outline, rendered as an inset box-shadow so it doesn't add to the layout box or shift content

### ListItem

Selection list row — radio, checkbox, or icon type.

```jsx
<ListItem
  type="icon"            // icon (default) | radio | checkbox
  selected={false}       // selected/checked state
  disabled={false}
  error={false}
  skeleton={false}       // renders a shimmer marker + bar, ignores all other props
  label="Label"
  keyValue="Key-value"   // optional right-side label
  tag="New"              // optional trailing Tag (any type); string or Tag props object
  icon={<SvgIcon />}     // used when type="icon"
  name="group"           // forwarded to Radio for grouping (type="radio")
  id="opt-1"
  onChange={fn}
  dir="ltr"
/>
```

- All three types share one `.list-item` row — same layout, label typography, `--space-sm` (8px) gap, and trailing cluster. Only the **leading slot** differs: an icon (`icon` type), a `Checkbox` atom (`checkbox`), or a `Radio` atom (`radio`)
- State is controlled by separate boolean props (`disabled`, `error`, `skeleton`) — there is no `state` prop
- `skeleton` renders a shimmer marker (circle for `icon`/`radio`, rounded box for `checkbox`) + a bar, ignoring all other props
- `tag` renders a trailing `Tag` before the `keyValue`, in a `--space-sm` (8px) trailing cluster. Pass a string for the label, or a Tag props object (`{ label, variant, style, … }`) for full control — defaults to the neutral tinted style shown in Figma. Available on every type
- `type="checkbox"` / `type="radio"` render the row as a `<label>` that composes the bare `Checkbox` / `Radio` atom (the atoms render no label of their own) with ListItem's `label` + `keyValue`/`tag`, forwarding `selected` as `checked` (and `name` for radio grouping); hovering the row tints the marker. The `icon` type renders a non-interactive `<div>`

### Checkbox

Standalone **tick-box atom** — a 20×20 checkbox marker only, no label. Wraps a native `<input type="checkbox">` via `forwardRef` for accessibility and form-library compatibility. For a labeled selection row use `ListItem type="checkbox"` (which composes this atom with a label + key-value); for a standalone labeled checkbox, wrap it in your own `<label>`.

```jsx
<Checkbox
  checked={false}
  disabled={false}
  error={false}
  skeleton={false}       // renders a 20×20 shimmer box, ignores all other props
  onChange={(e) => setChecked(e.target.checked)}
  id="terms"             // used on the native input; falls back to useId()
  aria-label="Accept"    // accessible name when standalone (forwarded to the input)
  dir="ltr"              // ltr | rtl (no visual effect — the box is symmetric)
/>
```

- Renders only the tick box. There is **no `label`, `keyValue`, or `leadingIcon`** — compose those around it (e.g. via `ListItem type="checkbox"`)
- The native `<input>` overlays the box (`opacity:0`), so the box itself is the hit target; `forwardRef` + native `id` keep it form-library and `<label htmlFor>`-friendly
- Pass `aria-label` / `aria-labelledby` for the accessible name when standalone (both forwarded to the input); when wrapped in a `<label>`, the label text provides the name
- State is controlled by separate boolean props (`disabled`, `error`, `skeleton`) — there is no `state` prop
- Box visuals (per Figma): unselected border `--border-base-inverted`, hover `--border-base-hover`, pressed `--border-base-pressed` (hover/pressed are CSS pseudo-states, not props); when `checked` the box fills `--background-primary-default` with a white check (hover/pressed → `--background-primary-hover` / `-pressed`)
- `error` colors the border `--border-primary-default` (unselected) or fills `--background-warning-default` (selected)
- `disabled` mutes the border to `--border-base-disabled`; disabled + checked fills `--background-neutral-disabled` with an `--icon-base-disabled` (grey) check
- `skeleton` renders a 20×20 shimmer box and ignores all other props

### Radio

Standalone **radio-button atom** — a 20×20 radio marker only, no label. Wraps a native `<input type="radio">` via `forwardRef` for accessibility. For a labeled selection row use `ListItem type="radio"` (which composes this atom with a label + key-value); for a standalone labeled radio, wrap it in your own `<label>`.

```jsx
<Radio
  checked={false}
  disabled={false}
  error={false}
  skeleton={false}       // renders a 20×20 shimmer circle, ignores all other props
  name="plan"            // groups radios together — pass the same name to each
  onChange={(e) => setChecked(e.target.checked)}
  id="plan-a"            // used on the native input; falls back to useId()
  aria-label="Economy"   // accessible name when standalone (forwarded to the input)
  dir="ltr"              // ltr | rtl (no visual effect — the circle is symmetric)
/>
```

- Renders only the radio circle. There is **no `label`, `keyValue`, or `leadingIcon`** — compose those around it (e.g. via `ListItem type="radio"`)
- The native `<input>` overlays the circle (`opacity:0`), so the circle itself is the hit target; `forwardRef` + native `id` keep it form-library and `<label htmlFor>`-friendly
- Pass a shared `name` to group radios together; pass `aria-label` / `aria-labelledby` for the accessible name when standalone (both forwarded to the input)
- State is controlled by separate boolean props (`disabled`, `error`, `skeleton`) — there is no `state` prop
- Circle visuals (per Figma): unselected border `--border-base-inverted`, hover `--border-base-hover`, pressed `--border-base-pressed` (hover/pressed are CSS pseudo-states, not props); when `checked` the border turns aqua (`--border-secondary-default`) with a 10px aqua center dot (`--background-primary-default`), darkening to `--border-secondary-hover` / `-pressed` on hover/press
- `error` colors the border `--border-primary-default` (both states); error + checked fills the dot with `--background-warning-default`
- `disabled` mutes the border to `--border-base-disabled`; disabled + checked shows a faint `--background-neutral-subtle` dot
- `skeleton` renders a 20×20 shimmer circle and ignores all other props

### Toggle

Binary on/off switch with label. Wraps a native `<input type="checkbox">` via `forwardRef`. Platform-aware (iOS / Android).

```jsx
<Toggle
  platform="ios"         // ios (default) | android
  state="default"        // default | disabled | skeleton
  checked={false}
  label="Label"
  onChange={(e) => setChecked(e.target.checked)}
  dir="ltr"              // ltr | rtl
/>
```

- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); both platforms share the same DOM and differ only in styling:
  - **iOS** (default): 64×28 track with a wide white pill knob (39×24). On fills with `--background-primary-default` (aqua); off is `--background-base-active`, darkening to `--background-neutral-selected` while pressed.
  - **Android** (Material 3): 52×32 track. Off shows a 2px `--border-base-inverted` outline on a `--background-base-default` fill with a small 16px `--background-neutral-default` handle; on fills with `--background-primary-default` and the handle grows to a 24px white circle. The handle expands to 28px while pressed.
- `skeleton` renders shimmer placeholder for label + track (sized per platform), ignores other props
- Use for settings that take effect immediately — not for one-time actions (use Button or Checkbox instead)
- Label names the setting/state, not the action ("Price alerts", not "Turn on price alerts")

### SegmentedControl

Horizontal tab-switcher. 36px tall, supports 2–4 segments. Platform-aware (iOS / Android).

```jsx
<SegmentedControl
  items={['Flights', 'Hotels', 'Cars']}   // array of label strings
  value={0}                                // selected index (0-based, controlled)
  onChange={(index) => setIndex(index)}
  platform="ios"                           // ios (default) | android
  dir="ltr"                                // ltr | rtl
/>
```

- All segments share equal width (`flex: 1`)
- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); the two platforms share the same DOM and differ only in styling:
  - **iOS** (default): floating pill on a tinted track. Active segment is a white pill (`--background-base-default`) with a subtle drop shadow + semibold label; inactive segments are transparent with a regular-weight label.
  - **Android**: Material outlined segmented buttons — no track; each segment is a 1px `--border-base-default` outlined cell with adjacent borders collapsed and the group's outer corners pill-rounded. Active segment fills with `--background-base-active` + semibold label.
- Inactive segment label color is `--text-base-default` on both platforms
- RTL is handled in CSS (logical `margin-inline` / `border-*-start/end-radius`), so the Android outer rounding and border-collapse flip automatically
- `value` is controlled — the component has no internal state; always wire up `onChange`

### Stepper

Numeric increment/decrement control — minus button, value display, plus button.

```jsx
<Stepper
  value={1}
  min={0}
  max={9}               // optional; omit for no upper bound
  onChange={(n) => setValue(n)}
  dir="ltr"             // ltr | rtl — swaps button order
/>
```

- Minus button is disabled when `value <= min`; plus button is disabled when `value >= max`
- Buttons swap sides in RTL: plus leads, minus trails

### ProgressStepper

Linear progress indicator made of pill-shaped step segments.

```jsx
<ProgressStepper
  steps={5}             // total number of steps
  currentStep={2}       // how many steps are completed (filled)
/>
```

- Completed segments (`index < currentStep`) use `--background-primary-default`; remaining use `--background-neutral-subtle`

### CircularProgressIndicator

Indeterminate circular loading spinner. Platform-aware (iOS / Android), SVG-based. There is no determinate / percentage mode — it is always a spinner.

```jsx
<CircularProgressIndicator
  platform="ios"             // ios (default) | android
  size="default"             // default | large
  label="Loading results…"   // optional — renders a status row (spinner + text)
  dir="ltr"                  // ltr | rtl
  aria-label="Loading"       // defaults to label, then "Loading"
/>
```

- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); both platforms share the same shell + `role="progressbar"` a11y contract and differ in the rendered SVG:
  - **iOS** (default): the `UIActivityIndicatorView` spinner that `UIRefreshControl` renders — **8 tapering capsule teeth** fading around a small hub (top tooth full opacity, ramping 12.5%→87.5% counter-clockwise), rotating in 8 discrete steps. Teeth are tinted via `currentColor` → `--icon-base-subtle` (native gray, adapts in dark mode). Sizes: `default` 24px, `large` 40px.
  - **Android** (Material 3): a `--background-primary-default` (aqua) active arc covering 80% of the circle and a complementary `--background-primary-subtle` track filling the rest, both round-capped and separated by a ~2px gap on each end, rotating at a constant speed. Sizes: `default` 40px / 4px stroke, `large` 48px / 8px stroke.
- `size` is platform-relative (iOS 24/40 px, Android 40/48 px) — pick `large` for full-screen / pull-to-refresh waits
- `label` renders `--text-base-subtext` status text and becomes the accessible name. Placement follows the platform + size: **iOS `default`** sits it inline beside the spinner (`--space-md` gap, reversed in RTL); **iOS `large`** and **all Android** stack it below the indicator (`--space-sm` / 8px gap)
- `aria-label` defaults to `label`, then `"Loading"`. There is no `state`/`mode`/`value` prop
- All animations are suppressed under `prefers-reduced-motion`

### LinearProgressIndicator

Determinate horizontal progress bar driven by a `value` (0–100 percentage). Platform-aware (iOS / Android). There is no indeterminate mode — for open-ended waits use `CircularProgressIndicator`.

```jsx
<LinearProgressIndicator
  value={40}                 // 0–100 (clamped); the completion percentage
  platform="ios"             // ios (default) | android
  dir="ltr"                  // ltr | rtl — flips the growth + stop-dot direction
  aria-label="Progress"      // defaults to "Progress"
/>
```

- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); both platforms share the same `role="progressbar"` shell (`aria-valuenow`/`min`/`max`) and differ in markup:
  - **iOS** (default): a flat 6px track (`--background-neutral-subtle`, full-radius) with a `--background-primary-default` (aqua) fill that grows from the leading edge. The fill keeps a 6px min-width so 0% shows a small dot.
  - **Android** (Material 3): a 12px-tall row holding a 4px `--background-primary-default` active bar, a `--space-xs` (4px) gap, and a flat 4px `--background-neutral-subtle` remaining track, with a 4px aqua **stop dot** pinned to the trailing end while incomplete. At 100% the active bar fills the width and the remaining track + stop dot are dropped; at 0% only the track + stop dot render.
- `value` is clamped to 0–100; the bar fills its container width, so let the consumer's layout set surrounding margins
- `dir="rtl"` grows the fill from the trailing (right) edge and moves the Android stop dot to the left, via logical CSS properties
- Width changes animate (0.3s); suppressed under `prefers-reduced-motion`

### Slider

Range input with optional tick marks and a filled track.

```jsx
<Slider
  value={40}
  min={0}
  max={100}
  step={1}              // optional; derived from ticks if >1, else falls back to 1
  ticks={5}             // optional; renders tick marks (only when >1) and computes step
  onChange={(n) => setValue(n)}
  dir="ltr"             // ltr | rtl
/>
```

- Track fill is driven by a CSS custom property `--slider-pct` set via inline style
- `ticks` renders evenly-spaced tick marks below the track (only when `ticks > 1`); step is auto-computed as `(max - min) / (ticks - 1)`
- Remaining props spread onto the inner `<input type="range">`, not the root element

### Banner

Inline promotional banner with a tinted background, optional icon visual, and a coupon code pill. For image-led campaign cards with a price bar, use **VisualCard**.

```jsx
<Banner
  color="neutral"         // neutral (default) | info | promo | featured
  title="Title"
  subtitle="Short description"
  codeLabel="Use code"
  codeText="CODE"         // defaults to "CODE"
  showAction={true}       // show/hide code pill
  showVisual={true}       // show/hide icon slot
  iconSrc="/icon.png"
  showDismiss={true}
  onClose={fn}
  dir="ltr"
/>
```

- Always renders the small inline layout — there is no `size` prop
- `color` selects the tinted gradient background via `--banner-{color}` (neutral/info/promo/featured)
- Title and body use the adaptive `--text-base-default` token (flips in dark mode); the code pill stays static (white pill, dark text)

### SystemBanner

Inline status/message banner — a tinted row with a status icon, a title + description, and an optional action. Two layouts via the `platform` prop: **mobile** (default — compact row, inline text-link action) and **desktop** (wide row with a leading icon column, an optional `Tag`, and a trailing Primary `Button`). Distinct from **Banner** (promotional, coupon code) and **VisualCard** (image-led campaign).

```jsx
<SystemBanner
  platform="mobile"      // mobile (default) | desktop — layout axis (NOT the ios/android platform concept)
  type="visual"          // visual | neutral | success | caution | error
  title="Title"
  description="Book with free cancellation and get full refund."
  icon={true}            // boolean (default true) — shows the built-in status icon for the type
  tag="Ends in 2 days"   // desktop only — a Tag in the content; string or Tag props object
  actionLabel="Label"    // optional action; omit to hide
  onAction={fn}
  skeleton={false}       // true renders a shimmer placeholder, ignores other props
  dir="ltr"              // ltr | rtl
/>
```

- **`platform`** is a layout axis (like `AdBanner`'s `layout`), **not** the iOS/Android `usePlatform` concept — it is a plain prop with no `DesignSystemProvider` resolution. `mobile` (default) is everything SystemBanner has always been; `desktop` is the wide row.
- `type` selects both the tinted background and the built-in icon + icon color (same on both layouts): `visual` (white + `--border-base-default`, info icon, `--icon-secondary-default`), `neutral` (`--background-primary-subtle`, info icon, secondary), `success` (`--background-success-subtle`, check-circle, `--icon-success-default`), `caution` (`--background-caution-subtle`, warning, `--icon-caution-default`), `error` (`--background-warning-subtle`, warning, `--icon-primary-default`)
- `title` and `description` are both optional; render either or both. Text uses adaptive `--text-base-default`. On desktop the title uses subtitle-bold (16px); on mobile it is body-bold (14px)
- **Action** — `actionLabel` + `onAction`: on **mobile** it is an inline text-link (`--text-link-default`); on **desktop** it is a Primary `Button` (medium) on the trailing edge. There is no `ghost`/`link` Button variant in this system, which is why mobile uses a text-link
- **`tag`** renders only on the **desktop** layout — a design-system `Tag` (defaults to the `neutral` tinted variant) inside the content, below the text. Pass a string for the label or a Tag props object (`{ label, variant, style, … }`) for full control; ignored on mobile
- `skeleton` renders shimmer bars and ignores all other props (same on both layouts)
- Full-width by default — let the consumer's layout constrain the width

### AdBanner

Sponsored-ad unit — an advertiser logo + title/sub-copy, a "Sponsored" `Tag`, and an optional image and CTA (the image renders as a trailing strip, a hero, or a faded side panel depending on layout). Two `layout`s cover the placements: **mobile** (a compact row at `size="small"`, or a hero-image card at `medium`/`large`) and a wide **desktop** strip with a side image. Distinct from **Banner** (own coupon promo), **SystemBanner** (status message), and **VisualCard** (first-party campaign card) — AdBanner always carries the "Sponsored" label because it is paid third-party inventory.

```jsx
<AdBanner
  layout="mobile"          // mobile | desktop
  size="small"             // mobile only: small (row) | medium | large (hero-card image height)
  title="Ad title"
  subtitle="Sub-copy"
  logoSrc="/advertiser.png"  // advertiser logo (image URL) …
  logo={<SvgNode />}         // … or a logo node
  imageSrc="/hero.jpg"       // hero (mobile medium/large) / trailing strip (mobile small) / side image (desktop)
  showSponsored={true}       // show/hide the "Sponsored" tag (default true)
  sponsoredLabel="Sponsored" // overrides the tag text; defaults to "Sponsored"/"ممول" by dir (empty → default)
  showAction={false}         // enable the outline CTA pill (all layouts)
  actionLabel="Label"        // outline CTA label (used when showAction); wire onAction
  onAction={fn}
  showImageAction={false}    // enable the coral CTA over the image — desktop only
  imageActionLabel="Book now"// coral image CTA label (used when showImageAction); wire onImageAction
  onImageAction={fn}
  chevron={true}             // show the trailing chevron on mobile layouts (default true); set false to hide
  onClick={fn}               // whole-card tap (the chevron signals it navigates)
  skeleton={false}
  dir="ltr"                  // ltr | rtl — mirrors layout + flips the chevron
/>
```

- **`layout`** is the layout/placement axis (Figma calls it "Platform: Mobile/Desktop"), **not** the iOS/Android `platform` concept — AdBanner is not platform-aware and does not use `usePlatform`.
  - **mobile + `size="small"`**: horizontal row — logo (48px) · title/sub-copy + "Sponsored" tag + optional CTA · trailing chevron. When `imageSrc` is set, an 80px full-height image strip sits on the trailing edge (hard edge — no fade, unlike desktop).
  - **mobile + `size="medium"` / `"large"`**: vertical hero card — image on top with the "Sponsored" tag overlaid top-start; below it logo (48px) · title/sub-copy + optional CTA · trailing chevron. `size` sets the image height (`medium` 80px, `large` 120px).
  - **desktop**: wide horizontal strip (one size) — logo (64px) · title/sub-copy + "Sponsored" tag + optional CTA on the leading side; a side image on the trailing side that fades into the card via a gradient. No chevron; a coral CTA (with trailing chevron) can sit over the image. `size` is ignored.
- **`chevron`** (default `true`) shows the trailing chevron on the mobile layouts (small + hero card); set `false` to hide it. Desktop has no chevron slot, so the prop is a no-op there.
- **CTAs are opt-in booleans** (not derived from label text): `showAction` enables the outline pill (all layouts), `showImageAction` enables the coral image pill (desktop only). `actionLabel` / `imageActionLabel` set the text and fall back to `"Label"` when the button is enabled without one
- Reuses the design-system **`Tag`** (neutral tinted) for the "Sponsored" label and **`Button`** (`primary-inverted`, medium) for the outline CTA; the coral image CTA is AdBanner-local (no matching Button variant, and it needs a trailing icon)
- Title uses subtitle (16px semibold), sub-copy uses body (14px regular), both `--text-base-default`. The row forms (mobile small + desktop) clamp each to 2 lines; the hero card clamps to 1 line
- The desktop side-image fade uses `--background-base-default` → transparent so it blends into the card in light **and** dark mode, and flips edge under `dir="rtl"`
- CTA clicks call `stopPropagation` so they don't also fire the card's `onClick`
- Full-width by default — let the consumer's layout constrain the width (mobile row ~360, hero card ~320, desktop wide). `skeleton` renders shimmer logo/text/tag placeholders per layout; it also renders a button-shaped placeholder for each enabled CTA (`showAction`, and `showImageAction` on desktop) so the loading shape matches the resolved content. Other content props are ignored

### VisualCard

Full-bleed image card with a gradient overlay and a price/CTA bar. Use for destination or campaign promotion with a hero image.

```jsx
<VisualCard
  size="medium"           // medium (default) | large
  title="Title"
  subtitle="Short description"
  imageSrc="/photo.jpg"
  accentColor="#008f8d"   // dominant color from the image — used as the gradient overlay behind title/CTA
  priceLabel="From"
  priceValue="SAR 499"
  actionLabel="Book now"
  showBottomBar={true}    // defaults to true
  onAction={fn}
  showDismiss={true}
  onClose={fn}
  dir="ltr"
/>
```

- `medium` is a compact card; `large` is a hero-style card (taller image area, display-size headline)
- `accentColor` sets the blurred gradient color behind the title/CTA — pass the image's dominant color so it blends
- `showBottomBar={false}` hides the price + CTA row
- The CTA is the shared **`Button`** (`variant="secondary-inverted"`, medium) so it inherits Button updates; it sits on the image overlay (transparent, bordered, white label)

### BottomActionBar

Sticky bottom bar for booking/payment flows.

```jsx
<BottomActionBar
  type="starting-price"         // starting-price | funnel | payment
  price="$1,215"
  originalPrice="$1,500"        // shown struck-through when type="starting-price"
  fromLabel="Starting from"
  actionLabel="Book now"
  onAction={fn}

  // funnel only
  bookingDetailsLabel="Booking details"
  onBack={fn}

  // payment only
  paymentMethod="Apple Pay"
  paymentLogo={<CustomLogo />}  // defaults to Apple Pay mark
/>
```

- The trailing CTA is the shared **`Button`** — `payment` type renders `Button variant="payment"` (green, lock-check icon), all other types render `variant="primary"`. It inherits every Button update (pressed push, disabled, tokens) automatically

### TextInput

Floating-label text field with helper/error text, optional leading/trailing icons, and dropdown / multiline / password variants.

```jsx
<TextInput
  label="Label"
  value={value}
  onChange={(e) => setValue(e.target.value)}
  disabled={false}           // boolean — mutes colors, blocks interaction
  required={false}           // boolean — appends " *" to label (in --text-link-default), sets native required
  skeleton={false}           // boolean — renders shimmer placeholder, ignores other props
  helperText="Helper text"   // shown below field when there is no error
  errorText="Error message"  // a non-empty value puts the field into the error state
  leadingIcon={<SvgIcon />}  // optional 24px icon on leading side
  trailingIcon={<SvgIcon />} // optional 24px icon on trailing side
  onClear={() => setValue('')} // optional — shows a filled X-circle clear button when value is non-empty
  dropdown={false}           // boolean — trailing chevron + a panel that drops below the field while focused
  multiline={false}          // boolean — renders an auto-growing <textarea> instead of <input>
  password={false}           // boolean — masks the value with an interactive eye reveal toggle
  dir="ltr"                  // ltr | rtl
>
  {/* dropdown only — slot content (Cell, Radio, Checkbox, …) rendered in the panel */}
</TextInput>
```

- There is no `state` prop. `disabled` and `skeleton` are independent booleans; the error state is **derived** from `errorText` being non-empty
- Floating label: acts as a centered placeholder (body-regular) when empty/unfocused; when focused or populated it shrinks to caption and floats **inside** the field at the top-left corner (16px from the side, 10px from the top), with the value stacked directly below it (field is 56px tall)
- Interactive states: hover → `--border-base-hover` + `--background-base-hover`; pressed → `--border-base-pressed` + `--background-base-pressed`; focus → 2px `--border-secondary-default` with the label in `--text-link-default`
- Trailing-side precedence: error icon (when `errorText`) → password reveal (when `password`) → clear button (when `onClear` + value) → `trailingIcon`; the `dropdown` chevron, when present, always sits rightmost
- `dropdown`: trailing chevron (down by default, up when focused, `--icon-secondary-default`); while focused a panel drops below the field holding `children` — `--background-base-default`, 1px `--border-base-default`, `--rounded` corners, `--elevation-raised`, 24px min-height, grows with content
- `multiline`: renders a `<textarea>` that auto-resizes to its content (no scrollbar); the label/icons top-align as the field grows
- `password`: input is `type="password"` (hidden) by default; the trailing eye-slash toggle (`--icon-secondary-default`) reveals (`type="text"`, eye icon) and re-hides it
- `disabled` state: subtle background, all text/icons muted (value + helper use `--text-base-disabled`); label is always floating
- `skeleton` renders shimmer placeholder bars, ignores all other props
- `forwardRef`; `onFocus`/`onBlur` are merged with internal handlers; `id` is respected (falls back to `useId()`)
- Always pass `value` + `onChange` (controlled); native `<input>`/`<textarea>` so all standard props are forwarded

### Search

Search bar with a leading magnifier and trailing microphone / clear control. Platform-aware (iOS / Android).

```jsx
<Search
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  label="Search Term"   // optional — seeds the field text (uncontrolled only; ignored if value is set)
  onClear={() => setQuery('')}
  onClose={fn}          // ios: close button tapped · android: back arrow tapped
  showClose={false}     // ios only — renders a liquid-glass × circle outside the pill (default: false)
  platform="ios"        // ios (default) | android
  placeholder="Search"  // defaults to "Search" (EN) or "بحث" (AR)
  dir="ltr"             // ltr | rtl
/>
```

- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); both platforms share the same `<input>` and differ only in chrome:
  - **iOS** (default): 44px liquid-glass pill, magnifier leading. Trailing swaps a mic (empty) for a filled clear-× circle (`value` non-empty). `showClose` adds a separate 44×44 tap-target with a 36px liquid-glass × circle outside the pill, wired to `onClose`.
  - **Android** (Material): 56px `--background-base-subtle` bar, `28px` radius, 48px icon slots. Resting (empty + unfocused) shows a leading magnifier + trailing mic; once focused or populated it swaps to a leading **back arrow** (calls `onClose` to collapse, mirrored in RTL) + a trailing **× clear** button (calls `onClear`). `showClose` is ignored on Android.
- Trailing control swaps automatically on the field's value/focus — there is no `state` prop
- **Controlled vs uncontrolled:** pass `value` + `onChange` for controlled use. Omit `value` to run uncontrolled — the field manages its own text, seeded once from `label` (handy for prefilled/demo searches); `onClear` still fires and the field resets itself. `label` is ignored when `value` is provided
- Icons are design-system line-icons (`maginfyingGlass`, `mic`, `x`, `arrowLeft`/`arrowRight`, `xCircleFill`), imported as `?raw` and tinted via `currentColor` — `--icon-base-subtle` for the magnifier/mic/clear-default, `--icon-base-default` when pressed
- Caret uses `--text-link-default` (aqua); the placeholder uses `--icon-base-subtle`
- Interactive states are **pressed-only** (`:active`), not hover — these are mobile-oriented search fields. The iOS glass shadow is a lighter, Search-scoped value rather than the shared `--liquid-glass-shadow` (which is too heavy for a small pill)

### Navbar

Top navigation bar, **composed from smaller pieces**: an internal status bar, a toolbar (a `variant` selects its layout), an optional chip row, and an optional `SegmentedControl`. Platform-aware (iOS glass / Android material) and surface-aware. Each section renders **only when its data prop is supplied** — no booleans to toggle empty sections.

```jsx
<Navbar
  platform="ios"          // ios (glass) | android (material) — via usePlatform (prop > provider > "ios")
  surface="default"       // default | gradient | overlay
  dir="ltr"               // ltr | rtl — via useDir

  // Toolbar — supply the object to render it; omit to hide. `variant` picks the layout.
  toolbar={{
    variant: 'default',         // default | large | flights | stays | segmented-control | search  (only on the default surface)
    onBack: fn,                 // back button — all variants except `search` (which uses the Search field's own controls)

    // default / large
    title: 'Title',
    subtitle: 'Subtitle',       // default only
    rightActions: [             // default & large — 0–2 trailing actions
      { icon: <Icon />, onClick: fn, 'aria-label': 'Share' },
    ],

    // flights — centred itinerary + currency action
    origin: 'DXB', destination: 'JED', tripType: 'Round-trip',
    travelers: 2, cabin: 'Premium Economy', dates: '11 - 28 Aug',
    onItinerary: fn, onCurrency: fn,

    // stays — location + currency action (Android also takes onSearch)
    location: 'Dubai', guests: 9, /* dates, onItinerary, onCurrency, onSearch (android) */

    // segmented-control — segmented control between back and trailing actions
    //   (iOS: a close × via onClose; Android: rightActions)
    segmentedControl: { items: ['Label', 'Label'], value: 0, onChange: fn }, onClose: fn,

    // search — a Search field; reuses the Search component (iOS: close ×; Android: built-in back)
    search: { value, onChange: fn, onClear: fn, placeholder: 'Search' }, /* onClose */
  }}

  // Chip row — supply a non-empty array to render it
  chips={[
    { icon: <Icon /> },                                  // icon-only
    { icon: <Icon />, label: 'Dates', dropdown: true,    // label + dropdown chevron
      selected: false, onClick: fn },
  ]}

  // Segmented control — supply the object to render it
  segmentedControl={{ items: ['Flights', 'Stays'], value: 0, onChange: fn }}
/>
```

- **`platform`** resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"`); `dir` through `useDir`. The two platforms share the same section structure and props but differ in chrome:
  - **iOS**: translucent `--overlay-navbar` blur surface; the back/right actions are `GlassButton`s; the chip row is built-in liquid-glass pills; status bar shows the time, dynamic island, and signal/wifi/battery.
  - **Android**: opaque `--background-base-default` surface with a 1px `--border-base-subtle` bottom border; back is a plain `arrowLeft` icon button, trailing actions are plain icon buttons, the chip row uses the `Chip` component; status bar is a right-aligned status cluster.
- **`surface`**: `default` (platform surface above), `gradient` (black→transparent overlay), `overlay` (50% black scrim). **`gradient`/`overlay` are Android-only** (for placing over imagery) — iOS always renders the `default` glass surface, so the component clamps `surface` to `default` on iOS. On `gradient`/`overlay` the title/subtitle and icons go inverted (white) and Android icons become white with no button background. Over imagery the toolbar **stands alone**: the chip row and segmented section are suppressed on Android `gradient`/`overlay`.
- **Platform / surface / variant constraints (enforced):** iOS ⇒ `default` surface only (gradient/overlay ignored); the toolbar `variant` only applies on the **default surface** (always so on iOS; on Android only when `surface="default"`, since gradient/overlay fall back to the default toolbar). So the rich variants pair exclusively with the default surface.
- **`toolbar.variant`** picks the toolbar layout — available on **both platforms** (default surface only), styled per platform (iOS = glass; Android = material): `default` (back · centered title/subtitle · actions), `large` (iOS: compact bar above an expanded headline; Android: back · headline title · actions in one row), `flights`/`stays` (a centered itinerary — route or location + pax/dates — with trailing currency/search actions; iOS renders it as a glass pill, Android as plain centered text with a dropdown caret), `segmented-control` (back · `SegmentedControl` · trailing — when this variant is used the standalone `segmentedControl` section below the chips is automatically suppressed so there aren't two), `search` (a full-width `Search` field). The route `⇄` uses the `arrowsLeftRight` icon, the trailing action the `currency` icon (Android stays adds a `magnifyingGlass` search action).
- The default-variant title stays optically centered regardless of how many side actions are present (absolutely positioned between the two action slots).
- `chips` and `segmentedControl` are **data-driven** — the consumer passes the items; the component renders the right chip/segment style per platform. The old `type="flights" | "stays" | "large-header" | "segmented-control"` API and the built-in search bar were removed in this redesign.

### Callout

Non-interactive label for time-sensitive or dynamic information. Built-in icon + text on a tinted background.

```jsx
<Callout
  label="Cheapest for your dates"
  size="regular"         // regular | small
  icon={true}            // boolean (default true) — shows the built-in icon; pass false to suppress
  dir="ltr"
/>
```

- Text is set via the `label` prop (not children)
- `icon` is a boolean toggle for the built-in icon — custom icon elements are not supported
- Text renders with a gradient fill (aqua-based)
- `small` size uses caption typography; `regular` uses body-emphasized

### Accolade

Non-interactive label for standout qualities based on data or awards. Built-in gradient icon + gradient text; optional background pill.

```jsx
<Accolade
  label="Top rated for cleanliness"
  size="regular"         // regular | small
  background={false}     // true adds a rounded pill background (--background-base-default)
  icon={true}            // boolean (default true) — shows the built-in icon; pass false to suppress
  dir="ltr"
/>
```

- Text is set via the `label` prop (not children)
- `icon` is a boolean toggle for the built-in icon — custom icon elements are not supported
- Label uses the purple→blue gradient (`--gradient-purple-blue`)
- `background` renders a `32px` tall pill (or auto-height for `small`)
- Use for verified, evidence-based claims — not for marketing copy (use MarketingCard for that)

### Badge

Notification indicator overlaid on an icon or standalone.

```jsx
// Standalone
<Badge variant="alert" count={5} max={99} />
<Badge variant="new" />

// Overlaid on an element
<Badge variant="alert" count={3}>
  <BellIcon />
</Badge>
```

- `variant="alert"` — shows numeric count; capped at `max` (displays `99+` by default)
- `variant="new"` — shows static "NEW" label
- When `children` are provided, wraps them in a `badge-anchor` span with the pip positioned top-right

### Tooltip

Text bubble anchored to a trigger element. Always visible (no JS show/hide built in — control visibility via `className` or wrapper state).

```jsx
<Tooltip
  content="Tooltip text"
  position="top"         // top | bottom
  arrowAlign="center"    // center | start | end
  dir="ltr"
>
  <button>Hover me</button>
</Tooltip>
```

- Arrow and bubble are rendered via CSS; `position` controls whether the arrow is above or below the bubble
- `arrowAlign` shifts the arrow toward the start or end of the bubble

### Snackbar

Temporary non-blocking notification. Auto-dismisses after `duration` ms.

```jsx
<Snackbar
  message="Seat preference saved"
  show={visible}
  duration={3000}        // ms before onClose fires; default 3000
  onClose={() => setVisible(false)}
  dir="ltr"
/>
```

- Renders with `role="status"` and `aria-live="polite"` — screen readers announce it automatically
- Slides in when `show` becomes `true`; caller must manage `show` state
- Use for lightweight confirmation/nudge copy only — not for errors or critical messages (use Banner)

### TabBar

Bottom navigation bar for switching between top-level destinations. Platform-aware (iOS liquid-glass / Android material).

```jsx
<TabBar
  platform="ios"         // ios | android — via usePlatform (prop > provider > "ios")
  items={[
    { icon: <HomeIcon />,    label: 'Home'    },
    { icon: <ExploreIcon />, label: 'Explore' },
    { icon: <TripsIcon />,   label: 'My Trips'},
  ]}
  value={0}              // active tab index (0-based, controlled)
  onChange={(i) => setTab(i)}
  dir="ltr"              // ltr | rtl — via useDir
/>
```

- `platform` resolves through `usePlatform` (prop > `DesignSystemProvider` > `"ios"` default); `dir` through `useDir`. Both platforms share the same `role="tablist"` / `role="tab"` markup and `{ icon, label }` item shape, differing only in chrome
- **iOS**: floating liquid-glass pill; the active tab sits on a subtle full-radius selection capsule (`--background-neutral-subtle`). Labels are native SF Pro 10px (`-apple-system` stack) — Medium (500) inactive, Semibold active
- **Android**: solid `--background-base-default` bar with a 1px `--border-base-subtle` top divider; the active icon gets an aqua-tinted pill (`--background-base-selected`). Labels are caption (12px), `--font-body`
- Inactive icon/label use `--icon-base-default` / `--text-base-default`; the active tab switches the icon to `--icon-secondary-default` and the label to `--text-link-default` (both aqua)
- `value` is controlled (0-based index) — the component holds no internal state; always wire `onChange`. `items` is the tab data (3–5 entries); `icon` is any node, `label` is the text below it
- Pass **filled** icon variants (e.g. `chaletFilled`, `compassFilled`, `calendarFilled`, `discountFilled`, `userCircleFilled`) — the glyph renders at 24px and tints via `currentColor`, so a filled shape reads more clearly than a line icon

### BottomSheet

Modal sheet that slides up from the bottom for contextual content, options, or input the user can browse and dismiss freely. Platform-aware (iOS liquid-glass / Android material) and size-aware: iOS has `small` / `medium` / `fullscreen`, Android has `medium` / `fullscreen` (`small` is iOS-only). For a blocking decision use `Dialog` instead.

```jsx
<BottomSheet
  open={isOpen}
  size="medium"          // medium | small | fullscreen (small is iOS-only; android small → medium)
  platform="ios"         // ios | android
  title="Select seat"
  subtitle="Optional subtitle"
  onClose={fn}           // renders the leading close button when provided
  onAction={fn}          // renders the trailing action button when provided
  actionIcon={<Icon />}  // icon inside the action button
  search={<Search />}    // injected below the toolbar in fullscreen (iOS or Android)
  dir="ltr"
>
  {/* sheet content */}
</BottomSheet>
```

- Animates in with `translateY(100%) → 0` when `open` becomes `true`
- **Positioning:** the overlay is `position: absolute`, so it fills the **nearest positioned ancestor** and can be contained inside a screen/preview container — mount it in a full-screen app root in production (it is not `fixed`)
- **Mobile-oriented width:** the overlay centres a phone-width frame (scrim + panel) capped at `--bottom-sheet-width` (default `390px`, matching the Navbar's mobile footprint). Override the `--bottom-sheet-width` custom property to change it
- **Sizes per platform:** iOS has `small` / `medium` / `fullscreen`; **Android has only `medium` + `fullscreen`** — `small` is iOS-only and the component clamps Android `small` → `medium`
- A **scrim** dims the presenting screen behind the sheet (tap it to fire `onClose`): iOS `rgba(0,0,0,0.2)` on every size; Android the darker Material `--overlay-default` (0.5) on `medium` only — **Android `fullscreen` has no scrim** (it's an opaque full page)
- `medium` / `small` — heights: `small` is `min-height: 200px`, `medium` is `min-height: 400px` (both capped by a vh max). The header differs by platform:
  - **iOS**: liquid-glass panel (6px margin, `--rounded-popover`) with the glass toolbar — `GlassButton` `type="x"` close (left), centred title/subtitle, aqua `bg="primary"` action (right). Each side renders only when its handler (`onClose` / `onAction`) is supplied
  - **Android** (`medium` only): solid panel, 28px Material top corners, a centred **drag handle** then a `gap`/`padding`-16 row of leading **× close** (`onClose`) · **left-aligned title** that fills (16px semibold, **no subtitle**) · trailing **action** (`onAction`) — aqua-tinted icons. This is a plain flex row, not the centred toolbar
- `fullscreen` — starts **below the host status bar** (offset by `--bottom-sheet-top-inset`: iOS `54px`, Android `28px`) so the status bar stays visible above the sheet; header is the toolbar + the `search` slot (both platforms). **iOS** keeps the glass toolbar (× close, aqua action) on a solid panel with rounded top corners and a dimming scrim; **Android** uses a material toolbar — a **back arrow** (`onClose`, RTL-mirrored) + centred title/subtitle + a trailing `onAction` icon, all aqua-tinted (`--icon-secondary-default`) — on a flat square-top page with **no scrim**
- The component does **not** render a device status bar — that belongs to the host screen. Override `--bottom-sheet-top-inset` to match the host's status-bar height
- The iOS title/subtitle stay optically centered — the title area is absolutely positioned (68px insets) so it ignores the side button widths

### Dialog

Modal window that appears in front of app content to provide critical information or ask for a decision. Interruptive and blocking — use sparingly; for non-blocking options use a BottomSheet or Snackbar.

```jsx
// iOS — role-named action props
<Dialog
  platform="ios"          // ios (default) | android
  title="A short title is best"
  description="A description should be a short, complete sentence."
  layout="stacked"        // stacked (default) | side-by-side — iOS button arrangement
  primaryAction={{ label: 'Primary', onClick: fn }}          // aqua-filled
  destructiveAction={{ label: 'Delete', onClick: fn }}       // coral text (stacked only)
  secondaryAction={{ label: 'Secondary', onClick: fn }}      // grey
  onClose={fn}            // called when the scrim is tapped
  dismissOnScrim={true}   // whether tapping the scrim calls onClose (default true)
  dir="ltr"               // ltr | rtl
>
  {/* optional iOS content slot between the text and the buttons */}
</Dialog>

// Android — action1 / action2
<Dialog
  platform="android"
  icon={<SvgIcon />}      // optional node above the title — android only
  title="A short title is best"
  description="A description should be a short, complete sentence."
  action1={{ label: 'Action 1', onClick: fn }}   // confirming action, trailing edge
  action2={{ label: 'Action 2', onClick: fn }}   // each is { label, onClick, destructive }
  onClose={fn}
  dir="ltr"
/>
```

- There is **no `open` prop** — control visibility by conditionally rendering the component (`{show && <Dialog … />}`); it renders a scrim + centered panel whenever mounted. Like `BottomSheet`/`ActionSheet`, the overlay is `position: absolute`, so it fills the **nearest positioned ancestor** (a screen/preview container) — mount it in a full-screen app root in production
- **Actions are role-named props, not an array** — each is `{ label, onClick }` (presence renders the button):
  - **iOS**: `primaryAction` (aqua-filled, white text), `destructiveAction` (coral text — stacked only), `secondaryAction` (grey). Stacked order is primary → destructive → secondary; side-by-side renders secondary + primary
  - **Android**: `action1` (the confirming action, sits at the trailing edge) and `action2`; each also accepts `destructive` to color the label coral (`--text-warning-default`). Reversed in RTL
- `layout` (iOS only): `"stacked"` (default) stacks full-width pill buttons; `"side-by-side"` lays two equal-width buttons in a row (Secondary + Primary). Ignored on Android
- `platform="android"`: rounded `--background-base-subtle` surface, optional `--icon-base-subtle` icon, title (`--type-headline`) + description (`--type-body`), both centered
- `platform="ios"`: native SF Pro text, start-aligned title + description; rendered by the shared liquid-glass `IOSDialogCard` (the same surface the iOS **ActionSheet** uses) — translucent `--background-base-default` (50% opacity) with a 40px backdrop blur as the HTML approximation of iOS glass. `children` render as a content slot between the text and the buttons
- `icon` is android-only — ignored on iOS

### ActionSheet

A contextual menu of actions presented over the current screen. Like `Dialog`, it has no `open` prop — render it conditionally — and a fixed tap-to-dismiss scrim (dark on iOS, transparent for the Android menu). Platform-aware (iOS / Android).

```jsx
// iOS — reuses the iOS Dialog's liquid-glass card (IOSDialogCard)
<ActionSheet
  platform="ios"          // ios (default) | android
  title="A Short Title Is Best"
  description="A description should be a short, complete sentence."
  actions={[              // stacked pill buttons; mark the cancel/delete one destructive
    { label: 'Action 3', onClick: fn },
    { label: 'Action 2', onClick: fn },
    { label: 'Action 1', onClick: fn, destructive: true },
  ]}
  onClose={fn}
  dismissOnScrim={true}   // default true
  dir="ltr"
>
  {/* optional iOS content slot between the text and the actions */}
</ActionSheet>

// Android — a Material menu list of rows
<ActionSheet
  platform="android"
  items={[                // [{ icon, label, shortcut, chevron, onClick, destructive, disabled }]
    { icon: <SvgIcon />, label: 'Label', shortcut: '⌘C', chevron: true, onClick: fn },
    { icon: <SvgIcon />, label: 'Delete', onClick: fn, destructive: true },
  ]}
  onClose={fn}
  dir="ltr"
/>
```

- **iOS** renders the exact same surface as the iOS `Dialog` (always `stacked`): a frosted-glass card with optional title/description and a column of grey pill buttons; `destructive` colors a button coral. Pass actions as `[{ label, onClick, destructive }]`
- **Android** renders a rounded, elevated (`--elevation-raised`) `--background-base-subtle` menu surface (208px min-width) of rows. Each item: optional 24px leading `icon`, a `--type-subtitle` `label`, optional trailing `shortcut` text and a `chevron` (mirrors in RTL); `destructive` colors the label/icon with warning tokens; `disabled` mutes and disables the row. Rows use `role="menuitem"` inside a `role="menu"` surface
- `platform`/`dir` resolve through `usePlatform`/`useDir` (prop > `DesignSystemProvider` > `"ios"`/`"ltr"`)
- **Positioning:** like `BottomSheet`, the overlay is `position: absolute`, so it fills the **nearest positioned ancestor** and can be contained inside a screen/preview container — mount it in a full-screen app root in production. The surface is centered with a transparent tap-to-dismiss scrim on both platforms — it captures the outside tap but does **not** dim the screen behind the sheet

### MarketingCard

Promotional card with image and optional content overlay. Supports three visual types.

```jsx
// Solid — image top, text+CTA below
<MarketingCard
  type="solid"           // solid | gradient-small | gradient-large
  skeleton={false}       // true replaces all content with shimmer bars
  title="Skip the taxi queue"
  subtitle="Book a transfer and arrive stress-free"
  imageSrc="/transfer.jpg"
  imageSize="small"      // sizes the image section (marketing-card--img-{size})
  tagCount={2}           // number of Tag chips to render over the image (0–4)
  tag1Label="Popular"    // per-tag text; tag1Variant / tag1Style also available
  tag2Label="New"
  partnerLogoSrc="/logo.png"     // optional partner logo over the image (solid only)
  actionLabel="Book a transfer"  // CTA button label (default "Action")
  buttonVariant="primary"        // forwarded to the inner Button
  buttonSize="small"             // forwarded to the inner Button
  buttonDisabled={false}
  buttonProps={{ onClick: fn }}  // spread onto the inner Button (wire the click here)
  dir="ltr"
/>

// Gradient — title overlaid on image with gradient
<MarketingCard
  type="gradient-large"
  title="Unforgettable stays"
  subtitle="Curated hotels just for you"
  centerTitle="Top picks"        // gradient-large only — centered title mid-image
  imageSrc="/hotel.jpg"
  dir="ltr"
/>
```

- `solid`: image section + separate content block below (title, subtitle, CTA button)
- `gradient-small` / `gradient-large`: gradient overlay at the bottom of the image; title + subtitle rendered on top
- There is no `state` prop (`skeleton` is a boolean) and no `display` type
- Tags: pass `tagCount` (0–4); each tag's text/variant/style is set via `tag{N}Label` / `tag{N}Variant` / `tag{N}Style`. Only the first `tagCount` render
- The CTA is an inner `Button` — wire the action via `buttonProps` (e.g. `onClick`); there is no `onAction` prop
- `skeleton` replaces all content with shimmer bars

### Expander

Inline "Show more / Show less" toggle for truncated lists.

```jsx
<Expander
  expanded={false}
  onChange={(next) => setExpanded(next)}
  dir="ltr"                    // ltr | rtl — changes default label language (EN/AR)
  collapsedLabel="See all 12"  // overrides default collapsed label
  expandedLabel="See less"     // overrides default expanded label
/>
```

- Default labels: "Show more" / "Show less" (LTR) or "عرض المزيد" / "عرض أقل" (RTL); override with `collapsedLabel` / `expandedLabel`
- Chevron rotates 180° with a spring easing when toggled
- `aria-expanded` is set automatically
- Place at the natural end of a truncated list; never render when there is nothing to expand

### Accordion

Single collapsible disclosure — a header button with a title and chevron that reveals a content panel below.

```jsx
<Accordion
  title="Accordion Item"
  expanded={false}           // initial open state — component manages its own state after mount
  skeleton={false}           // renders a shimmer placeholder, ignores other props
  dir="ltr"                  // ltr | rtl
>
  {/* panel content — string or any node */}
</Accordion>
```

- Panel content is passed as **`children`** (string or any node), not a prop
- **Self-managing** — the component owns its open/closed state. `expanded` only seeds the *initial* state; after mount, tapping the header toggles it. There is no `onChange` and no fully-controlled mode
- Header is a `<button>` with `aria-expanded` / `aria-controls`; the chevron (16px, `--icon-secondary-default`) rotates 180° when open; hover/pressed tints the header with `--background-base-hover`
- An optional `id` seeds the header/panel element ids that link `aria-controls` ↔ `aria-labelledby` (falls back to `"accordion"`); `className` and remaining props spread onto the root element
- Expand/collapse is height-animated via a `grid-template-rows: 0fr → 1fr` transition (0.3s), so it animates to the content's natural height with no JS measurement; collapsed content is `inert` and the transition is disabled under `prefers-reduced-motion`
- A 1px `--border-base-default` separator sits at the bottom (under the header when collapsed, under the panel when expanded); stack multiple `<Accordion>` instances to build a list
- `skeleton` renders a shimmer bar in place of the title and ignores all other props
- Title typography is body-semibold `--text-base-default`; panel is body-regular; panel padding flips for RTL

---

### AlmosaferLogo

Brand logo component with all eight Almosafer logo variants inlined as SVG. Scales proportionally from a single `width` prop.

```jsx
<AlmosaferLogo
  type="wordmark"    // wordmark | logomark | applogo
  variant="colour"   // colour | white
  lang="en"          // en | ar  — only affects wordmark; ignored for logomark and applogo
  width={132}        // optional px width; height is computed from the viewBox aspect ratio
/>
```

Natural dimensions (no `width` prop):
- `wordmark` — 132×24px (5.5:1)
- `logomark` — 24×24px (1:1)
- `applogo` — 40×40px (1:1)

Available combinations:
| type | variant | lang |
|---|---|---|
| wordmark | colour / white | en / ar |
| logomark | colour / white | — (lang ignored) |
| applogo | colour / white | — (lang ignored) |

Invalid combinations return `null`. No CSS file — all colors are encoded in the SVG paths and must not be overridden. Pass `className` or `style` only to control position and layout, not fill colors.

---

### Footer

Full site footer for Almosafer. It is a large composed block, not a small control. A **`platform`** prop selects the layout: **`desktop`** (default) is the full-width web footer — an app-promotion card (barcode + store stats/ratings + app-store badges) with a 24/7 contact panel, five link columns (Corporate, Support, Legal, Social media, Countries), and a brand strip (World Travel Awards logo, business taglines, accepted payment methods, licenses, copyright); **`pwa`** is the stacked mobile web-app layout — a gradient app card (Almosafer app logo + "Get the app" CTA + single-star ratings), then ghost-surface cards for contact and inline link groups and awards, with a social-icon row + copyright + licenses at the bottom. Every section is **data-driven with full Almosafer defaults**, so `<Footer />` renders the complete Figma footer out of the box and any section can be overridden.

```jsx
<Footer
  platform="desktop"                // desktop (default) | pwa — layout axis (NOT the ios/android platform concept)
  dir="ltr"                         // ltr | rtl — via useDir
  appTitle="Get the Almosafer app!"
  appDescription="Our app has all your hotel needs covered: …"   // desktop app-card body copy
  appTagline="Join 11M+ users across MENA"                       // pwa app-card short line
  appLogo={<AlmosaferLogo type="applogo" width={56} />}          // pwa app-card logo (any node)
  appCtaLabel="Get the app"                                      // pwa app-card CTA; onAppCta wires the click
  onAppCta={fn}
  barcodeSrc="/qr.png"              // desktop QR image; pass null/undefined to hide
  stats={[{ value: '11 Million+', label: 'App Downloads' }, { value: '400K+', label: 'Reviews' }]}
  ratings={[{ score: '4.7', store: 'App Store' }, { score: '4.8', store: 'Google Play' }]}
  badges={[{ src: '/appstore.png', alt: 'App Store', href: '#' }, /* … */]}   // desktop app-store badges
  contacts={[{ icon: rawSvgString, title: 'Our team is available 24/7:', value: '8000183803', href: 'tel:…' }]}
  contactHeading="Get in touch with us:"   // pwa contact-card heading
  columns={[
    { title: 'Corporate', links: [{ label: 'About us', href: '#' }, /* … */] },
    { title: 'Social media', links: [{ label: 'Facebook', href: '#', icon: <img … /> }] },
    { title: 'Countries', links: [{ label: 'Saudi Arabia', href: '#', icon: <img … /> }] },
  ]}
  awardsSrc="/awards.png"
  taglines={['Leading Online Travel Agency', /* … */]}
  paymentLogos={[{ src: '/mada.svg', alt: 'mada' }, /* … */]}   // desktop only — defaults to the logotypes/payment set
  licenses={[{ label: 'Tourism Services License', value: '432873354' }, /* … */]}
  copyright="Copyright © 2026 Almosafer"
/>
```

- **`platform`** is a **layout axis** (like `AdBanner`'s `layout` / `SystemBanner`'s `platform`), **not** the iOS/Android `usePlatform` concept — it is a plain prop with no `DesignSystemProvider` resolution. Internally it splits into non-exported `FooterDesktop` / `FooterPwa` sub-components sharing one `<footer>` shell and the same data props.
- **`desktop`** — a **web/desktop element**: renders full-width and stacks on narrow viewports (breakpoints at 900px / 560px); the horizontal gutter is fluid (`clamp(16px, 8.33vw, 120px)`). Not a mobile-screen component; let the page own its max-width. Uses `barcodeSrc`, `badges`, `appDescription`, `paymentLogos`, and the country-flag/social `icon`s on `columns`.
- **`pwa`** — a **mobile web-app element**: full-width stacked cards on a `--background-base-subtle` (ghost) surface, meant to sit at the bottom of a phone-width screen. The app card reuses `AlmosaferLogo` (applogo) + a `primary-inverted` `Button` CTA; ratings show a single gold star; contact values render as aqua links; the `columns` render as inline label + link-row groups (flags dropped), with the `Social media` column pulled out into an icon row at the bottom. It ignores `barcodeSrc`, `badges`, `appDescription`, and `paymentLogos`; it uses `appTagline`, `appLogo`, `appCtaLabel`/`onAppCta`, and `contactHeading`.
- **Data-driven, fully defaulted.** Omitting every prop reproduces the Figma for the chosen `platform`. Passing a section prop overrides it; passing `[]` / `null` for a section hides it (e.g. `badges={[]}`, `contacts={[]}`, `barcodeSrc={null}`).
- **dir-aware text defaults.** All default strings are bilingual: `dir="ltr"` renders English, `dir="rtl"` auto-swaps to Arabic (like `Separator`/`Search`/`Expander`) — no per-string props needed for an Arabic footer. An explicit text prop still wins (`prop ?? dir-default`). The asset defaults (flags, social, payment, badges, QR, awards) are language-independent and shared across both. The social column is identified by a `kind: 'social'` marker (not its title) so it's pulled into the PWA social row in any language.
- Self-contained box model: the component scopes its own `box-sizing: border-box` reset, so it lays out correctly in consumer apps without a global reset.
- **`columns`** is a generic `{ title, links: [{ label, href, icon }] }[]` — the social and country marks are just per-link `icon` nodes, so columns can be added, removed, or reordered freely. Corporate/Support/Legal links simply omit `icon`.
- **`contacts[].icon`** is a raw SVG **string** (rendered inline via `dangerouslySetInnerHTML` so it tints via `currentColor` — white on the dark desktop card, aqua in the PWA ghost card); the phone/whatsapp/store defaults come from the DS line-icons. Other image props (`barcodeSrc`, `badges[].src`, `awardsSrc`, `paymentLogos[].src`, link `icon`) are ordinary image sources/nodes.
- **App-promo card** is a fixed brand gradient — `--footer-app-gradient` composes `--color-almosafer` (navy) → `--color-aqua-100` (aqua) — that **does not flip in dark mode**, so its text/icons use the static-inverted tokens (`--text-base-inverted-static`, `--icon-base-inverted-static`) and its on-dark dividers use a static translucent white (`--footer-divider-on-dark`, a `color-mix` of `--color-white-static`). The card intentionally overlaps the section below (negative margin + compensating top padding).
- Reuses the DS where it owns the asset (`Separator`; the `phone`/`whatsapp`/`store`/`star`/`globe` line-icons — the rating star is the outline star painted filled gold via `--icon-caution-default`; and the shared **`src/icons/logotypes/`** set — `logotypes/flags/` for the country flags keyed by ISO code (with `globe` for "World Wide"), `logotypes/social/` colour variants for social links, and `logotypes/payment/` for the desktop payment-methods row via `paymentLogos`). The remaining Footer-specific brand marks (app-store badges, the awards logo, the QR) ship as **Footer-local assets in `src/icons/footer/`**. All of these are inlined into the bundle as data URIs (`assetsInlineLimit` is raised in `vite.config.js`).
- **Dark-mode caveat:** the payment-network and awards marks are transparent SVGs (dark-mode safe). The QR barcode carries its own white quiet-zone (a scannable QR needs it) and the black X/Twitter glyph is a fixed brand color — both are light-surface-first, matching the Figma spec.

---

## How to build components

Figma is the source of truth for **visual design** — spacing, color, typography, and shape. It is not a guide for component architecture. The variant/state structure Figma uses to preview a component is not the same as the prop API a developer should use.

### Figma variants → props translation

Figma models every visual permutation as a separate frame (Default, Focus, Error, Populated, Disabled, LTR, RTL, with-icon, without-icon …). In code, most of these are not props — they are either CSS states or derived from the data the developer is already passing.

| Figma variant | What it becomes in code |
|---|---|
| Default / Focus / Hover | CSS pseudo-class (`:focus-within`, `:hover`) — no prop |
| Populated (has value) | CSS `:placeholder-shown` or `value !== ''` — no prop |
| Error | Derived from `errorText` being non-empty — no prop |
| Disabled | Native `disabled` attribute — no prop, CSS `:disabled` |
| LTR / AR (language) | `dir="ltr"` \| `"rtl"` prop |
| with-icon / without-icon | Optional `leadingIcon` / `trailingIcon` props |
| Skeleton | `state="skeleton"` — the only case that truly needs a `state` prop because it renders completely different DOM |

The rule: **only add a prop when the developer controls something that CSS and native HTML cannot derive on their own.**

### State props — when to use and what to avoid

The `state` prop in this system is reserved for **skeleton only**. Resist the urge to add states that map to Figma variants:

```jsx
// ✗ Mirrors Figma variant list — developer has to coordinate multiple props
<Input state="error" errorText="Required" />

// ✓ Single source of truth — state is derived from the data
<Input errorText="Required" />
```

Disabled, error, and focus are not states the developer "sets" — they are conditions that exist because of other facts (field has an error message, element is not interactive, user is interacting). Model those facts instead.

### Prefer CSS pseudo-classes over JS state

Browser-managed states (focus, hover, disabled, populated) should stay in CSS:

```css
/* ✓ Handles focus from keyboard, mouse, programmatic .focus(), and form-library refs */
.field:focus-within { box-shadow: inset 0 0 0 2px var(--border-primary-default); }

/* ✗ Misses programmatic focus, autofill, and react-hook-form register() */
.field--focus { box-shadow: ... }
```

For floating labels specifically, `:placeholder-shown` + `:focus-within` with the input before the label in DOM order handles autofill, uncontrolled inputs, and all focus sources without any JS. Use a `placeholder=" "` (single space) on the input to give `:placeholder-shown` something to react to.

### Wrapping native form elements

Any component that wraps `<input>`, `<select>`, or `<textarea>` must:

1. **`forwardRef`** — form libraries (react-hook-form, Formik) need ref access to register the field.
2. **Merge event handlers** — extract `onFocus`, `onBlur`, `onChange` from props and call both the internal handler and the developer's handler. Never silently override.
3. **Respect `id`** — if the developer passes an `id`, use it for both the input and any associated `<label htmlFor>`. Fall back to `useId()` only when no `id` is provided.
4. **No forced controlled** — don't default `value=""`. Let the consumer choose controlled (`value` + `onChange`) or uncontrolled (`defaultValue`). Defaulting `value=""` silently breaks `register()` usage.

```jsx
// ✗ Intercepts and discards react-hook-form's onBlur
<input onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} {...props} />

// ✓ Merges both
function handleBlur(e) { setFocused(false); onBlurProp?.(e) }
<input onFocus={handleFocus} onBlur={handleBlur} {...props} />
```

### Converting Figma output to tokens

The Figma MCP generates Tailwind with hardcoded values. Always translate to tokens and BEM classes before committing:

- Hardcoded hex (`#0BA0B7`) → semantic token (`--border-primary-default`)
- Hardcoded pixels (`12px`, `16px`) → spacing/type tokens (`--space-md`, `--type-caption-size`)
- Tailwind utility classes → BEM classes in the component's `.css` file
- Inline `style={{}}` → only acceptable for values that genuinely can't be CSS (dynamic angles, JS-computed transforms)

### RTL

Figma shows LTR and RTL as separate frames. In code it is one component with `dir="ltr" | "rtl"`. The pattern per concern:

- **Text direction and alignment** — CSS `direction: rtl` + `text-align: right` scoped to `[dir='rtl']`
- **Icon/content order reversal** — flex row reversal via `dir="rtl"` on the container is free (no JS needed)
- **Physically mirrored icons** (chevrons, arrows) — swap the icon in JSX based on the `dir` prop
- **Never** use `transform: scaleX(-1)` on the whole component

---

## Conventions

### File structure per component
```
src/components/
  ComponentName.jsx   — React component
  ComponentName.css   — scoped BEM-ish classes, tokens only (no raw hex)
```

### CSS class naming
BEM-style: `.block`, `.block__element`, `.block--modifier`. Modifier classes are composed by the component via template literals:
```js
const cls = ['btn', `btn--${variant}`, `btn--size-${size}`, className].filter(Boolean).join(' ')
```

### No raw colors in component CSS
Always reference semantic tokens (`--background-primary-default`) or, when unavoidable, raw palette tokens (`--color-aqua-100`). Never hardcode hex values except for static brand-specific colors (e.g. Apple Pay black).

### RTL support
Every component accepts a `dir` prop (`"ltr"` | `"rtl"`). RTL changes are handled in JSX (swapped chevron icons, reordered layout nodes) rather than CSS `transform`. Pass `dir="rtl"` for Arabic content.

### Platform variants (iOS / Android)

Some components render structurally different markup for iOS vs Android (`Dialog`, `ActionSheet`, `BottomSheet`, `TabBar` today). **Any new component with an iOS/Android split MUST follow this exact model** — do not create separate `Component.ios` / `Component.android` components or files. One component, one public name, one prop contract; the platform is a single input.

**1. `platform` is a prop, resolved through context — never a separate component.**
The component takes an optional `platform` prop but resolves the effective value with the shared hook, so a global `DesignSystemProvider` can set it once. Same pattern for `dir`:

```jsx
import { usePlatform, useDir } from '../context/DesignSystemContext'

export const Thing = ({ platform, dir, ...rest }) => {
  const p = usePlatform(platform)   // prop > provider > "ios"
  const d = useDir(dir)             // prop > provider > "ltr"
  …
}
```
Never read `platform`/`dir` straight from props for rendering — always pass them through the hooks so the provider works. An explicit prop still wins (the hook returns `prop ?? context`).

**2. Split internals into a shared shell + per-platform render — not one branchy function.**
Factor the parts that are identical across platforms (overlay, scrim, a11y roles, wrapper class, shared toolbars) into a `<ThingShell>` sub-component, and put each platform's unique markup in its own non-exported `ThingIOS` / `ThingAndroid` sub-component. The exported component resolves the platform and picks the render:

```jsx
const ThingShell = ({ platform, children, ... }) => ( /* overlay, scrim, role, cls */ )
const ThingIOS = (props) => ( /* iOS-only markup */ )
const ThingAndroid = (props) => ( /* Android-only markup */ )

export const Thing = ({ platform, ...rest }) => {
  const p = usePlatform(platform)
  return (
    <ThingShell platform={p} {...shellProps}>
      {p === 'ios' ? <ThingIOS {...rest} /> : <ThingAndroid {...rest} />}
    </ThingShell>
  )
}
```
These sub-components stay in the **same file** and are **not exported** — the file still exposes exactly one public component. Lift any markup the two platforms share verbatim (e.g. a toolbar) into its own shared sub-component rather than duplicating it in both renders.

**3. Default platform is `"ios"`, default dir is `"ltr"`.** These live in `DesignSystemContext` defaults — don't hardcode a different fallback per component.

**4. Document platform-specific props as such.** If a prop only applies on one platform (e.g. Dialog's `icon` and `children` are android-only), say so explicitly in the component's CLAUDE.md entry so it isn't applied cross-platform.

### Dark mode
Tokens automatically flip via `@media (prefers-color-scheme: dark)`. Force a theme by setting `data-theme="light"` or `data-theme="dark"` on `:root` / the wrapper element.

### Icons

Components use inline SVG icons (self-contained, no icon font dependency). The `public/icons.svg` sprite is available but not used by components — it's for consumer app use. Icon sizes are controlled by the parent component's CSS, not the SVG itself.

The design system defines three distinct icon types. These are **not interchangeable** — select based on intent, not visual preference.

**1. Product Icons** (`src/icons/product-icons/`) — represent top-level product categories (Flights, Stays, Activities).
- Use for: entry points on homepages/dashboards, primary product vertical navigation, high-level category selection.
- One product = one consistent icon. Never use for secondary features, UI controls, or decoration. Use sparingly (grids, primary nav). Do not mix with other icon types in the same component.

**2. Visual Icons** (`src/icons/visual-icons/`) — expressive, colorful icons for commercial/marketing content.
- Use for: add-ons and upsells, promotional banners, empty states and feature callouts where emotion or attention is needed.
- Do not use in core navigation or system actions. Avoid overuse. Can mix with illustrations, but not with product icons in the same context.

**3. Standard System Icons** (`src/icons/line-icons/`) — simple, functional, single-color icons for UI clarity.
- Use for: buttons, inputs, labels, controls, status indicators, secondary/supporting actions.
- The default choice for all UI elements. Always single-color and minimal. Prioritize clarity over decoration.

**Airline Logos** (`src/icons/airline-logos/`) — full-color brand marks for carriers, used in flight results, itineraries, and price breakdowns. These are **brand assets, not intent-based UI icons**, so they sit outside the three-type decision logic above.
- **Filename = the carrier's two-character IATA code** (e.g. `EK.svg` = Emirates, `QR.svg` = Qatar Airways, `6E.svg` = IndiGo). Look up the airline by its IATA code rather than its display name.
- Multi-color SVGs with baked-in brand colors — do **not** recolor them with `currentColor` or token overrides. Pass `className`/`style` for sizing and layout only.
- Use only to identify a specific airline. Never use as a generic "flights" icon (that's the Flights Product Icon) or for decoration.
- Currently covers 22 carriers: `6E` `EK` `EY` `F3` `FZ` `G9` `GF` `J9` `KL` `KU` `LH` `MS` `NP` `OV` `QR` `RJ` `RX` `SM` `SV` `TK` `WY` `XY`.

**Logotypes** (`src/icons/logotypes/`) — brand marks that sit **outside** the three intent-based icon types (like airline logos): payment networks, social platforms, and country flags. Multi-color, **brand-locked** SVGs — do **not** recolor with `currentColor` or tokens; pass `className`/`style` for sizing/layout only. Use them to identify a specific brand/country, never as generic UI icons. In the docs they live on the **Logotypes** Foundation page (not the Icons page). Three subfolders:
- **`logotypes/payment/`** — payment-network, wallet, BNPL, and loyalty marks (24×24 square). Filename = brand slug. Covers 22: `alfursan` `alfursan-ar` `almosafer` `alrajhi` `amex` `amwal` `applepay` `applewallet` `benefit` `emkan` `gpay` `hassad` `knet` `mada` `mastercard` `mokafaa` `qitaf` `stcpay` `tabby` `tamara` `urpay` `visa`.
- **`logotypes/social/`** — social-platform marks, each in a full-color **colour** variant (`facebook.svg`) and a monochrome **black** variant (`facebook-black.svg`; a fixed `#1C1C1C` monochrome, not a tintable line-icon). Covers 7 platforms × 2: `facebook` `instagram` `x` `linkedin` `whatsapp` `youtube` `snapchat` (+ each `-black`). WhatsApp also exists as a tintable `line-icons/whatsapp.svg` for functional UI — the `social/whatsapp.svg` here is the green brand mark.
- **`logotypes/flags/`** — full-color country flags (24×24 `viewBox`, flag centered). **Filename = ISO 3166-1 alpha-2 code, lowercase** (`sa` = Saudi Arabia, `ae` = UAE). Covers 34: `ad` `ae` `af` `ag` `ai` `al` `am` `ao` `aq` `ar` `as` `au` `ax` `az` `bh` `cn` `cu` `dz` `eg` `et` `eu` `gb` `in` `jp` `kr` `kw` `lk` `om` `qa` `ru` `sa` `sg` `tr` `us`. For a generic "worldwide" glyph use the `globe` line-icon, not a flag. The `Footer` uses the GCC + Egypt subset.

**Decision rules (strict):**
1. Core product category → Product Icon
2. Functional UI element → Standard System Icon
3. Promotion, upsell, or visual emphasis → Visual Icon
4. Multiple interpretations possible → default to Standard System Icon

**Anti-patterns:**
- Do NOT use Visual Icons in navigation menus or buttons.
- Do NOT use Product Icons for features, filters, or UI controls.
- Do NOT replace Standard System Icons with decorative alternatives.
- Do NOT mix all three types within a single small UI component.

### Skeleton states

Components that support loading placeholders:

| Component | How to trigger |
|---|---|
| Button | `variant="skeleton"` |
| Toggle | `state="skeleton"` |
| ListItem | `skeleton={true}` |
| Checkbox | `skeleton={true}` |
| Radio | `skeleton={true}` |
| TextInput | `skeleton={true}` |
| MarketingCard | `skeleton={true}` |
| Tag | `skeleton={true}` |
| Chip | `skeleton={true}` |
| AdBanner | `skeleton={true}` |

All shimmer animations use `--color-gainsboro` / `--color-alice` with a `background-size: 200%` keyframe sweep.

---

## Dev / build

```bash
npm run dev      # Vite dev server with App.jsx component showcase
npm run build    # outputs dist/index.js + dist/index.css
```

The App.jsx file is a spec-table showcase of all components — not part of the library output. Add new components to `src/index.js` exports and `App.jsx` for visual review.
