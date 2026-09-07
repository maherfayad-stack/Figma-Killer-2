# @alm-design/design-system — component API

Generated from the package's own docs on every chat turn. Do not hand-edit.

Every component below is a real named export of `@alm-design/design-system`. Import it — do not re-implement it, and do not substitute a raw HTML element, an emoji, or a text glyph for one.

## Importing

```jsx
import { Button, IconButton, GlassButton, Tag, Chip, Separator, Cell, ListItem } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'  // required once — loads all tokens + component CSS
```

`@alm-design/design-system` is the exact specifier. Import components by name from the package root; never deep-import a component file, and never use any other spelling of the package name.

## Components (39)

### Button

Buttons trigger actions. The variant signals the relative importance and risk of the action — choosing the wrong variant misleads users about what they're about to do.

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

### IconButton

A square, pill-radius button whose entire label is a single icon. Use it only when the icon's meaning is unambiguous on its own — a wordless control trades clarity for compactness, so the saving has to be worth it.

```jsx
<IconButton
  variant="primary"   // primary | secondary | overlay | grey
  size="default"      // default (48px) | medium (40px) | small (32px)
  icon={<SvgIcon />}
  aria-label="action"
/>
```

### GlassButton

A translucent "liquid glass" action button for floating controls — primarily the back and trailing actions inside `Navbar`, and any control that sits over imagery or a blurred surface. Where `IconButton` is an opaque control for solid backgrounds, `GlassButton` is the over-content counterpart.

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

### Tag

Static, non-interactive label that communicates a fixed property, category, or status.

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

### Chip

An interactive pill the user taps to filter, select, or open a picker. Unlike a `Tag` (which is a static, read-only label), a Chip is always actionable and carries a selected/unselected state.

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

### Separator

Full-width 1px horizontal rule. Renders as an `<hr>`. No built-in spacing — control margin via parent layout or `className`.

```jsx
<Separator
  type="cell separator"   // cell separator (default) | section separator
  variant="simple"        // simple (default) | or | dashed
  label="OR"              // overrides the OR label (variant="or" only); defaults to "OR"/"أو" by dir
  dir="ltr"               // ltr | rtl — only affects the OR label
/>
```

### Cell

Flexible row-based building block for presenting structured information. Carries label, value, leading visual, and a trailing action in a single scannable row.

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

### Checkbox

Control that lets users select one or multiple independent options.

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

### Radio

Control that lets users select exactly one option from a set. Selecting one option automatically deselects the others.

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

### Toggle

Binary on/off switch. For settings that take effect immediately — no confirmation step required. Wraps `<input type="checkbox">` via `forwardRef`. Platform-aware: iOS shows a 64×28 track with a wide white pill knob; Android shows a Material 3 52×32 switch — an outlined track with a small handle when off, filling to aqua with a larger white handle when on. Set the platform once via `DesignSystemProvider` (or per-instance with the `platform` prop); it defaults to iOS.

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

### SegmentedControl

Horizontal tab-switcher for toggling between 2–4 views of the same content. 36px tall, always controlled. Platform-aware: iOS shows a floating pill indicator on a tinted track; Android shows joined, outlined Material segmented buttons. Set the platform once via `DesignSystemProvider` (or per-instance with the `platform` prop); it defaults to iOS.

```jsx
<SegmentedControl
  items={['Flights', 'Hotels', 'Cars']}   // array of label strings
  value={0}                                // selected index (0-based, controlled)
  onChange={(index) => setIndex(index)}
  platform="ios"                           // ios (default) | android
  dir="ltr"                                // ltr | rtl
/>
```

### Stepper

Numeric increment/decrement control — minus button, count display, plus button. Used for choosing quantities.

```jsx
<Stepper
  value={1}
  min={0}
  max={9}               // optional; omit for no upper bound
  onChange={(n) => setValue(n)}
  dir="ltr"             // ltr | rtl — swaps button order
/>
```

### ProgressStepper

Linear progress indicator that shows how many steps in a flow are complete. Pill-shaped segments; completed segments fill with primary color.

```jsx
<ProgressStepper
  steps={5}             // total number of steps
  currentStep={2}       // how many steps are completed (filled)
/>
```

### CircularProgressIndicator

Indeterminate circular loading spinner. Renders the platform-native shape from a single component — a rotating Material 3 aqua arc on Android, the native UIActivityIndicatorView tooth spinner (gray) on iOS — so set `platform` once (via `DesignSystemProvider`) to match the target OS. There is no percentage / determinate mode; it is always an open-ended spinner.

```jsx
<CircularProgressIndicator
  platform="ios"             // ios (default) | android
  size="default"             // default | large
  label="Loading results…"   // optional — renders a status row (spinner + text)
  dir="ltr"                  // ltr | rtl
  aria-label="Loading"       // defaults to label, then "Loading"
/>
```

### LinearProgressIndicator

Determinate horizontal progress bar driven by a 0–100 `value`. Renders the platform-native shape from a single component — a flat aqua fill on a 6px track on iOS, the Material 3 active bar + gap + remaining track with a trailing stop dot on Android — so set `platform` once (via `DesignSystemProvider`) to match the target OS. Use only when the completion rate can actually be measured.

```jsx
<LinearProgressIndicator
  value={40}                 // 0–100 (clamped); the completion percentage
  platform="ios"             // ios (default) | android
  dir="ltr"                  // ltr | rtl — flips the growth + stop-dot direction
  aria-label="Progress"      // defaults to "Progress"
/>
```

### Slider

Continuous range input. Used for selecting a value within a defined range.

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

### Banner

Inline promotional banner with a tinted background, optional icon visual, and a coupon code pill. Used for contextual offers and coupons. For image-led campaign cards with a price bar, use [VisualCard](#visualcard).

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

### AdBanner

A paid, third-party advertising unit — an advertiser's logo and copy, always marked "Sponsored". It is the only promotional component that represents *bought* inventory, so the sponsored disclosure is intrinsic to it, not optional decoration. Distinct from first-party promotion: use it when an external advertiser paid for the placement.

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

### VisualCard

Full-bleed image card with a gradient overlay and a price/CTA bar. Used for destination or campaign promotion anchored by a hero image.

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

### BottomActionBar

Sticky bottom bar for booking and payment flows. Controls the primary forward action throughout a funnel.

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

### TextInput

Floating-label text field with helper/error text and optional leading/trailing icons.

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

### Search

Platform-aware search bar — an iOS liquid-glass pill or an Android Material docked bar. Used as a standalone search input or embedded in a `Navbar`. Set `platform` (or a `DesignSystemProvider`) to match the surrounding UI.

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

### Navbar

Top navigation bar that provides context and wayfinding. It is **composed** of a status bar, a toolbar (whose `variant` sets the layout — plain title, large header, flight/stay summary, segmented switcher, or search), an optional chip row, and an optional segmented control — each section appears only when you supply its data. Platform-aware (iOS glass / Android material) and surface-aware.

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

### Callout

Non-interactive label for time-sensitive or dynamic information. Gradient sparkle icon + text.

```jsx
<Callout
  label="Cheapest for your dates"
  size="regular"         // regular | small
  icon={true}            // boolean (default true) — shows the built-in icon; pass false to suppress
  dir="ltr"
/>
```

### Accolade

Non-interactive label for standout qualities based on verifiable data, reviews, or awards. Gradient sparkle icon + gradient text.

```jsx
<Accolade
  label="Top rated for cleanliness"
  size="regular"         // regular | small
  background={false}     // true adds a rounded pill background (--background-base-default)
  icon={true}            // boolean (default true) — shows the built-in icon; pass false to suppress
  dir="ltr"
/>
```

### Badge

Notification indicator. Overlaid on an icon when children are provided; standalone otherwise.

```jsx
// Standalone
<Badge variant="alert" count={5} max={99} />
<Badge variant="new" />

// Overlaid on an element
<Badge variant="alert" count={3}>
  <BellIcon />
</Badge>
```

### Tooltip

Text bubble anchored to a trigger element. Always visible when rendered — control visibility externally via state or CSS.

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

### Snackbar

Temporary, non-blocking notification for short feedback after a user action. Auto-dismisses after `duration` ms (default: 3 seconds).

```jsx
<Snackbar
  message="Seat preference saved"
  show={visible}
  duration={3000}        // ms before onClose fires; default 3000
  onClose={() => setVisible(false)}
  dir="ltr"
/>
```

### TabBar

Persistent bottom navigation for switching between a product's top-level destinations. The active tab tints aqua; the job is identical on both platforms and only the chrome differs — iOS renders a floating liquid-glass pill with a subtle selection capsule behind the active tab, Android a flat material bar with an aqua-tinted pill behind the active icon. Set the platform once via `DesignSystemProvider` (or per-instance with `platform`); it defaults to iOS. For switching between parallel *views* of a single screen, use [SegmentedControl](#segmentedcontrol).

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

### BottomSheet

Modal sheet that slides up from the bottom for contextual content, options, or input the user can browse and dismiss freely. Platform-aware — set `platform` to match the host: iOS renders a liquid-glass panel, Android a material surface. For a blocking decision the user *must* answer, use [Dialog](#dialog) instead.

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

### Dialog

A modal window that interrupts the user to deliver critical information or ask for a single decision. It demands a response before the user can continue — so it is the heaviest interruption in the system. Reach for it only when the cost of *not* interrupting is high.

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

### ActionSheet

A short menu of actions tied to the current item or screen, presented over the content. Unlike a [Dialog](#dialog) it does not pose a question or block on a decision — it offers a small set of *choices*, any of which (including dismissing) is a valid outcome.

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

### Expander

Inline "Show more / Show less" toggle for revealing additional items in a truncated list. Controlled — caller manages `expanded` state.

```jsx
<Expander
  expanded={false}
  onChange={(next) => setExpanded(next)}
  dir="ltr"                    // ltr | rtl — changes default label language (EN/AR)
  collapsedLabel="See all 12"  // overrides default collapsed label
  expandedLabel="See less"     // overrides default expanded label
/>
```

### Accordion

A titled section that expands to reveal its content on tap. Use it to let users scan a list of topics and open only the one they care about — managing density on a screen that has more content than fits comfortably.

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

### AlmosaferLogo

The brand identity component. Covers all official logo formats — wordmark (text + mark), logomark (mark only), and app logo (rounded square with mark).

```jsx
<AlmosaferLogo
  type="wordmark"    // wordmark | logomark | applogo
  variant="colour"   // colour | white
  lang="en"          // en | ar  — only affects wordmark; ignored for logomark and applogo
  width={132}        // optional px width; height is computed from the viewBox aspect ratio
/>
```

### Footer

The closing block of a page. It bundles everything a visitor reaches for at the end of a session — app download, 24/7 contact, site links (Corporate, Support, Legal, Social media, Countries), and the trust/legal strip (awards, business taglines, accepted payments, licenses, copyright). It is data-driven with full Almosafer defaults, so `<Footer />` is the complete footer; override individual sections for other markets or surfaces. Reuses the shared brand-mark sets ([AlmosaferLogo](#almosaferlogo) for the app logo, and the Logotypes payment/social/flag marks) and [Separator](#separator) between the brand rows — don't inline one-off logos.

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
