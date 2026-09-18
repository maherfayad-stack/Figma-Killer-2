# ALM 2.0 Design System — Content & Pattern Specifications

This file documents design patterns, content guidelines, and usage rules for the ALM 2.0 design system. It complements `CLAUDE.md` (which covers the technical API, props, and tokens) by capturing the *intent, tone, and decision logic* behind how components are used.

---

## Table of Contents

**Patterns**
- [Component Decision Map](#component-decision-map)
- [Text Alignment](#text-alignment)
- [Section Heading](#section-heading)

**Foundations**
- [Colors](#colors)

**Navigation & Structure**
- [Navbar](#navbar)
- [Footer](#footer)
- [TabBar](#tabbar)
- [SegmentedControl](#segmentedcontrol)
- [BottomSheet](#bottomsheet)
- [Dialog](#dialog)
- [ActionSheet](#actionsheet)
- [ProgressStepper](#progressstepper)
- [CircularProgressIndicator](#circularprogressindicator)
- [LinearProgressIndicator](#linearprogressindicator)

**Content & Lists**
- [Separator](#separator)
- [Cell](#cell)
- [List / ListItem](#list--listitem)
- [Expander](#expander)
- [Accordion](#accordion)
- [System Banner](#system-banner)

**Promotional**
- [Banner](#banner)
- [VisualCard](#visualcard)
- [AdBanner](#adbanner)
- [Marketing Card](#marketing-card)

**Actions**
- [Button](#button)
- [IconButton](#iconbutton)
- [GlassButton](#glassbutton)
- [BottomActionBar](#bottomactionbar)

**Inputs & Controls**
- [Checkbox](#checkbox)
- [Radio](#radio)
- [Toggle](#toggle)
- [TextInput](#textinput)
- [Search](#search)
- [Chip](#chip)
- [Stepper](#stepper)
- [Slider](#slider)

**Labels & Indicators**
- [Tag](#tag)
- [Callout](#callout)
- [Accolade](#accolade)
- [Badge](#badge)
- [Tooltip](#tooltip)
- [Snackbar](#snackbar)

**Patterns**
- [Select Pattern](#select-pattern)

**Planned — not yet implemented**
- [Hero](#hero-planned)
- [Card](#card-planned)
- [Price](#price-planned)
- [Empty State](#empty-state-planned)

---

## Component Decision Map

Use this table when you know the *intent* but aren't sure which component to use.

| I want to… | Use |
|---|---|
| Show a factual, static property of an item ("Economy", "Non-refundable") | `Tag` |
| Let user tap to filter or toggle a choice ("Direct", "Free cancellation") | `Chip` |
| Show time-sensitive or dynamic data ("4 seats left", "Price dropped 18%") | `Callout` |
| Show a data-backed achievement ("Top rated for cleanliness") | `Accolade` |
| Show a notification count or "NEW" pip on an icon | `Badge` |
| Show temporary feedback after an action ("Saved") | `Snackbar` |
| Show a persistent operational/status message (info, success, caution, error) | `SystemBanner` |
| Show a persistent, contextual offer with a coupon code | `Banner` |
| Show an image-led campaign card with a hero image and price/CTA bar | `VisualCard` |
| Show a paid third-party ad marked "Sponsored" | `AdBanner` |
| Show marketing/promotional content with image and CTA | `MarketingCard` |
| Trigger the main action in a booking flow | `BottomActionBar` |
| Navigate between top-level product verticals | `TabBar` |
| Switch between views on the same screen | `SegmentedControl` |
| Give a screen its top bar — title/back, flight or stay summary, or search | `Navbar` |
| Close a web page with brand links, contact, app promo, payments, and legal | `Footer` |
| Present a bottom overlay for contextual content or actions | `BottomSheet` |
| Block the user with a critical decision or confirmation | `Dialog` |
| Offer a short menu of actions on the current item or screen | `ActionSheet` |
| Trigger a labelled action — primary CTA, supporting, destructive, or payment | `Button` |
| Trigger an icon-only action (close, share, back) | `IconButton` |
| Trigger a floating action over imagery or a glass navbar | `GlassButton` |
| Collapse titled sections of content the user opens selectively | `Accordion` |
| Present a row of structured information (label + value) | `Cell` |
| Present a selectable list item (radio, checkbox, icon) | `ListItem` |
| Show a long list with a "Show more" control | `Expander` |
| Let user select one option from a visible set (card layout) | Select Pattern + `Radio` |
| Let user select one option from a compact list | `Radio` |
| Let user select multiple options | `Checkbox` |
| Let user toggle a persistent setting on/off immediately | `Toggle` |
| Let user type text | `TextInput` |
| Let user search | `Search` |
| Let user pick a quantity (travelers, bags) | `Stepper` |
| Let user pick a value on a continuous range (price, distance) | `Slider` |
| Show progress through a multi-step flow | `ProgressStepper` |
| Show a single operation is loading (open-ended spinner) | `CircularProgressIndicator` |
| Show measurable progress of one operation (upload, download) | `LinearProgressIndicator` |
| Show a contextual hint anchored to an element | `Tooltip` |
| Show the Almosafer brand logo, wordmark, or app icon | `AlmosaferLogo` |
| Identify a specific airline (flight results, itinerary, fare breakdown) | Airline logo SVG (`src/icons/airline-logos/`, keyed by IATA code) |
| Apply a color in component CSS | Semantic tokens ([Colors](#colors)) — `--background-*` / `--text-*` / `--border-*` / `--icon-*` |

---

## Text Alignment

Default to leading-aligned text across all content. Use `text-align: start` — it resolves to left in LTR and right in RTL automatically, so no per-direction override is needed.

**Center only when all three conditions are true:**
1. The text is short (1–5 words)
2. It sits on a symmetric, full-bleed layout (no leading visual, no trailing action)
3. It is decorative or editorial — not instructional or interactive

The only component where centering is built into the layout by platform convention: `Navbar` title (iOS/Android toolbar standard).

**Never center:**
- Section headings and content labels
- Body text or multi-line copy
- Form labels, helper text, error messages
- List rows (`Cell`, `ListItem`)
- Button labels (centered within their own container — do not also center the button block)

---

## Section Heading

Section headings label and contextualize distinct content blocks within a screen or module. They help users scan, navigate, and understand structure at a glance. The correct heading type depends on the **intent of the section**, not its visual appearance.

> **Section headings are a content pattern, not a component.** Apply typography tokens directly — no wrapper component exists.
>
> | Context | Token scale |
> |---|---|
> | Top-level screen section | `--type-headline-*` |
> | Standard content section | `--type-title-*` |
> | Supporting or paired subheading | `--type-subtitle-*` |
> | Minor label or category tag | `--type-eyebrow-*` |
>
> When in doubt, default to `--type-title-*`. Reach for `--type-headline-*` only when the section anchors the full screen — not for every prominent section.

### Types

| Type | Intent | Tone | Phrasing pattern | Typical contexts |
|---|---|---|---|---|
| **Functional** | Identify and navigate distinct content areas | Neutral, informative | Noun-based | Forms, flows, data sections |
| **Action** | Direct users toward an optional, goal-oriented action | Directive, goal-oriented | Verb-based (imperatives) | Add-ons, upsells, interactive modules |
| **Marketing** | Promote, inspire, or engage by highlighting value or trends | Expressive, persuasive | Phrase-based, benefit-driven | Carousels, offers, recommendations |

### Functional Section Heading

**Use when:**
- Introducing a distinct content area (e.g. payment options, traveler info)
- The user needs to scan multiple sections at a glance
- Establishing information hierarchy and clarity

**Do not use when:**
- The section is already clear from a tab, card, or other heading
- The screen has only one task or section (use a page title instead)
- You want to direct the user toward an action (use an action heading or microcopy/button)

**Content rules:**
- Noun-based labels or functional descriptions
- 2–4 words; no instructions, questions, or punctuation
- Sentence case (English)
- Clear, direct, neutral — not promotional or cute

**Examples:**

| ✅ Do | ❌ Don't |
|---|---|
| Traveler details | Who's going on this trip? |
| Payment method | Please select your payment method |
| Contact info | Let's get in touch |
| Booking summary | Here's a summary of your trip |
| بيانات المسافر | من المسافر في هذه الرحلة؟ |
| طريقة الدفع | الرجاء اختيار طريقة الدفع |
| معلومات التواصل | خلّنا نتواصل |
| ملخص الحجز | هذا ملخص رحلتك |

### Action Section Heading

**Use when:**
- The section contains optional, user-initiated actions (add-ons, upgrades, personalization)
- The action supports a goal-based decision (e.g. save money, skip queues, personalize trip)
- The section competes with adjacent sections and deserves extra motivation

**Do not use when:**
- The action is mandatory or part of a required flow (use a functional heading)
- The same action is already described by a button, card, or microcopy
- The interaction is too simple (e.g. a single dropdown) — keep it neutral

**Content rules:**
- Imperative or verb-based phrases
- Clear, concise, and goal-oriented
- Avoid urgency clutter or filler words
- Should match the action users will take in the section

**Examples:**

| ✅ Do | ❌ Don't |
|---|---|
| Add extras | Extras |
| Upgrade your room | Room options |
| Customize your trip | Trip customization |
| أضف خدمات إضافية | خدمات إضافية |
| قم بترقية غرفتك | خيارات الغرف |
| تخصيص رحلتك | تخصيص الرحلة |

### Marketing Section Heading

**Use when:**
- The section promotes, inspires, or engages — it is not task-completion content
- Introducing a carousel or offer block
- The goal is to highlight value, trends, or personalized recommendations

**Do not use when:**
- The section involves forms, inputs, or structured flows
- Clarity is more important than tone (system-critical flows)
- The tone is too clever, vague, or off-brand — creativity must not replace clarity

**Content rules:**
- Expressive or benefit-led phrases
- Allow creativity, but prioritize clarity
- Imperatives are acceptable; questions are not

**Examples:**

| ✅ Do | ❌ Don't |
|---|---|
| Beach stays under AED 200 | Beach deals |
| Unforgettable places to stay | Top hotels |
| Things to do in London | London activities |
| إقامات على الشاطئ بأقل من 200 AED | عروض الشاطئ |
| أماكن إقامة لا تُنسى | أفضل الفنادق |

### Decision Guide

| Scenario | Heading type |
|---|---|
| Section is part of a structured flow (form, settings, booking steps) | Functional |
| Section contains required inputs or selections | Functional |
| Section includes optional actions — upgrades, add-ons, personalization | Action |
| Section exists to promote, inspire, or encourage browsing | Marketing |
| Section is tied to offers, deals, or urgency-based CTAs | Marketing |
| Section groups content for scanability only | Functional |
| Section introduces a list of peer items (travelers, bookings, cards) | Functional |
| Section already has a nearby button or instruction | Functional or none |
| Heading would duplicate what the CTA says | None |

---

## Colors

The color system has **two layers**: a **raw palette** (`--color-*` — the actual hex values, gradients, and the named stops gradients are built from) and **semantic tokens** (`--background-*`, `--text-*`, `--border-*`, `--icon-*`, plus `--overlay-*`, `--gradient-*`, `--banner-*`, `--highlight-*`, `--button-*`) that map *intent* onto those raw values. Semantic tokens are the interface; the raw palette is the implementation.

> **Colors are a foundation, not a component.** Apply tokens directly in CSS via `var(--token)`. `CLAUDE.md` holds the full catalog and values — this section is about *which* token to reach for.

### Raw vs. semantic

| Use… | When |
|---|---|
| Semantic token (`--background-primary-default`, `--text-base-subtext`, …) | **Almost always** — any color in component CSS. It encodes intent and flips correctly in dark mode. |
| Raw token (`--color-aqua-100`, `--color-metal`, …) | Only when no semantic alias fits, or when defining a *new* semantic token. |
| Hardcoded hex | **Never** — except brand-locked assets (logos, Apple Pay black) where the color *is* the identity. |

### Which family

| Need | Family |
|---|---|
| Fill behind content (surfaces, cards) | `--background-*` |
| Text and inline labels | `--text-*` |
| Strokes, dividers, focus rings | `--border-*` |
| Icon glyphs | `--icon-*` |
| Scrim / glass tint over imagery or modals | `--overlay-*` |
| Dark→transparent gradient over a photo | `--gradient-*` |

Within a family the **intent suffix** picks the color: `base` (neutral), `primary` (brand), `warning` / `success` / `caution` (status), `ai` (assistant surfaces).

### ⚠️ `primary` means different things across families

The intent names are **not** consistent between backgrounds and borders/icons — a common source of miscolored UI:

| Token | Resolves to | Meaning |
|---|---|---|
| `--background-primary-*` | aqua | Brand primary fill |
| `--border-primary-*` / `--icon-primary-*` | coral | **Warning / destructive** |
| `--border-secondary-*` / `--icon-secondary-*` | aqua | Brand / interactive |

For a brand-colored border or icon, reach for **`secondary`** — `primary` on a border/icon is the destructive (coral) color.

### Adaptive vs. static

- **Adaptive (default):** nearly every token flips automatically in dark mode. Use these everywhere.
- **Static (`-static`, `--color-white-static`, `--color-black-50`):** never flip. Use **only** when a color must hold regardless of theme — text or icons over a fixed photo or a permanently-dark surface. Grabbing a static token just to freeze a light-mode look is a mistake; let the adaptive token flip.

Never gate color on a JS dark-mode check — tokens already respond to `prefers-color-scheme` (or a forced `data-theme`).

### Gradients & scrims

- **Image scrims** — `--gradient-horizontal` / `-vertical-bottom` / `-vertical-top` darken one edge of a photo so overlaid text stays legible; pick the edge the text sits on.
- **Accent gradients** — prefer the semantic `--highlight-*` (accolade/benefit labels) and `--banner-*` (banner tints) aliases over the raw `--gradient-neon-green` / `-aqua-green` / `-purple-blue` / `*-leading` names.
- Gradient tokens are **background-image values, not colors** — apply via `background`, `background-clip: text` (gradient text/icon), or `border-image` (gradient border). They do nothing in `color:` or `border-color:`.

### Gradient stop primitives

Every gradient token is assembled from **named stop primitives**, not inline hex, so each stop is addressable by name. Two naming rules:

- **Opaque stop → one evocative word** (`--color-sulu`, `--color-dodger`, `--color-glacier`), matching the palette's `metal` / `iris` style.
- **One hue at several opacities → hue word + opacity number** (`--color-grey-10` / `-30`, `--color-black-70`), matching `--color-black-50`.

They exist so **native (iOS/Android) code and Figma can reference a single stop** by name instead of a bare hex, keeping each gradient's definition in sync across code and design — a cross-platform contract, **not** a web styling API. In CSS keep composing with the whole gradient token (or its `--highlight-*` / `--banner-*` alias); touch a bare stop only when authoring a *new* gradient in `colors.css`.

### AI tokens

The `--ai-*` group styles AI/assistant surfaces: `--ai-background` (lavender), the solid `--ai-text-default` (amethyst) and `--ai-border-default` (iris), plus the PurpleBlue-gradient `--ai-text-highlight` / `--ai-border-highlight` / `--ai-icon`. Reserve them for genuinely AI-driven features — not as a decorative purple accent. The `-highlight` pair and `--ai-icon` are gradients, so apply them per the gradient rule above; the `-default` pair and `--ai-background` are solid colors usable in `color:` / `border-color:`. One catch: `--ai-text-default` (amethyst) is **static** while `--ai-background` and `--ai-border-default` are adaptive — AI text holds its value in dark mode instead of flipping with the surface around it, so verify its contrast on the dark AI surface.

### Usage

**Do:**
- Default to semantic tokens and let them handle dark mode.
- Use `secondary` for brand-colored borders/icons; `warning` (or border/icon `primary`) for destructive ones.
- Check every screen in both light and dark mode.

**Don't:**
- Hardcode hex, or reach for a raw `--color-*` when a semantic token already fits.
- Use a `-static` token to suppress a dark-mode flip you didn't want — fix the token choice instead.
- Put a gradient token in `color:` / `border-color:`.

---

## Navbar

Top navigation bar that provides context and wayfinding. It is **composed** of a status bar, a toolbar (whose `variant` sets the layout — plain title, large header, flight/stay summary, segmented switcher, or search), an optional chip row, and an optional segmented control — each section appears only when you supply its data. Platform-aware (iOS glass / Android material) and surface-aware.

### Surface decision guide

| Screen context | Use surface |
|---|---|
| Standard page on an opaque background (settings, details, results) | `default` |
| Android navbar sitting over a hero image, with a soft top scrim | `gradient` |
| Android navbar over imagery that needs a stronger dim for legibility | `overlay` |

- `gradient` / `overlay` are **Android-only** — iOS always uses the `default` glass surface (whose own scroll-edge gradient lets content show through). The component enforces this: on iOS, `surface` is clamped to `default`.
- The toolbar `variant` (large / flights / stays / segmented-control / search) applies **only on the default surface** — on both platforms (always so on iOS; on Android only when `surface="default"`, since gradient/overlay fall back to the default toolbar).
- On `gradient` / `overlay` the title/subtitle and icons go white. Only use these when the bar genuinely sits over imagery — never as decoration on a plain screen.

### Section rules

- **Toolbar** is the only required-feeling section. Title: 1–4 words, noun-based, describes the screen — not an action. Keep subtitle short (route, dates, count); drop it if it competes with a right action on small screens.
- **Chips** filter or jump within the screen — pass them only when they act on *this* screen's content. iOS renders glass pills, Android renders `Chip`s; same data either way.
- **Segmented control** switches sub-views of the current screen. If the segments belong deeper in the page, use `SegmentedControl` inline instead of in the navbar.
- Wire `onBack` on every screen that is not a root-level tab destination.

### Usage

**Do:**
- Set `platform` / `dir` once via `DesignSystemProvider` rather than on every navbar.
- Use noun-based titles ("Seat selection"); let buttons carry the verbs.
- Reach for `gradient` / `overlay` only over real imagery.

**Don't:**
- Use verb-based titles ("Select a seat").
- Crowd the toolbar with more than two trailing actions.
- Toggle empty sections — simply omit `chips` / `segmentedControl` when there's nothing to show.

### Toolbar variant

`toolbar.variant` picks the toolbar layout — match it to the screen's job. It works on **both platforms** (iOS glass / Android material), but only on the **default surface**:

| Screen | Variant |
|---|---|
| Standard page | `default` |
| Content-first / editorial page (title sets context) | `large` |
| Flight results (show the route so users verify without scrolling) | `flights` |
| Stay results (show location + dates) | `stays` |
| A screen whose sub-views switch in place | `segmented-control` |
| A search-first screen | `search` |

On Android `gradient`/`overlay` surfaces the toolbar falls back to the `default` layout (variants are default-surface only). Keep route summaries to IATA codes (RUH, DXB); don't spell out city names where a code is expected.

---

## TabBar

Persistent bottom navigation for switching between a product's top-level destinations. The active tab tints aqua; the job is identical on both platforms and only the chrome differs — iOS renders a floating liquid-glass pill with a subtle selection capsule behind the active tab, Android a flat material bar with an aqua-tinted pill behind the active icon. Set the platform once via `DesignSystemProvider` (or per-instance with `platform`); it defaults to iOS. For switching between parallel *views* of a single screen, use [SegmentedControl](#segmentedcontrol).

### TabBar vs. SegmentedControl

| Use… | When |
|---|---|
| `TabBar` | Moving between 3–5 *top-level destinations* (separate screens/verticals) — always reachable, persists at the bottom of the app |
| `SegmentedControl` | Toggling 2–4 *views of the same content* on one screen (e.g. Departure / Return) — scoped to that screen |

### Use when

- Navigating between 3–5 top-level destinations that are always reachable
- Each destination is a distinct vertical (Flights, Hotels, Trips, Account)

### Do not use when

- The user is mid-flow (booking steps, form screens) — hide the TabBar in deep flows
- The choices are parallel views of one screen rather than separate destinations — use `SegmentedControl`
- The destinations are not peer-level (one is a sub-section of another)

### Content rules — item labels

- 1 word per tab; noun, not verb
- Matches the product vertical name exactly — do not abbreviate or reframe
- Consistent casing with the rest of the app (sentence case)

**Examples:**

| ✅ Do | ❌ Don't |
|---|---|
| Flights | Fly |
| Stays | Book hotels |
| Trips | My trips |
| Account | Profile settings |

### Usage

**Do:**
- Keep icon and label in sync — the icon should be recognizable without the label
- Use **filled** icon variants — the glyph sits at 24px and tints aqua when active, so a filled shape reads more clearly than a line icon at that size
- Use the same icons across platforms; only the visual treatment (glass vs flat) differs

**Don't:**
- Add more than 5 items — use a secondary menu for overflow destinations
- Change the active tab in response to scroll position

---

## SegmentedControl

Horizontal tab-switcher for toggling between 2–4 views of the same content. 36px tall, always controlled. Platform-aware: iOS shows a floating pill indicator on a tinted track; Android shows joined, outlined Material segmented buttons. Set the platform once via `DesignSystemProvider` (or per-instance with the `platform` prop); it defaults to iOS.

### Use when

- The user needs to switch between 2–4 parallel views on the same screen (e.g. Departure / Return, One way / Round trip / Multi-city)
- The views share the same underlying data or context

### Do not use when

- There are more than 4 segments — use `TabBar` or a `BottomSheet` picker instead
- The segments represent top-level navigation destinations — use `TabBar`
- Only one option exists — show the content directly without a switcher

### Content rules

- 1–3 words per segment; noun-based labels
- All labels in a group must follow the same grammatical pattern
- Avoid verbs — segments describe the *view*, not an action to take

**Examples:**

| ✅ Do | ❌ Don't |
|---|---|
| Departure / Return | Go / Come back |
| Flights / Hotels / Cars | Fly / Stay / Drive |
| One way / Round trip | Select one way / Select round trip |

### Usage

**Do:**
- Always wire `onChange` — the component has no internal state
- Place directly below the `Navbar` or at the top of the content area, not mid-page

**Don't:**
- Use more than 4 segments; labels truncate and the interaction becomes unreliable
- Use as a filter when checkboxes or a filter sheet would be more appropriate

---

## BottomSheet

Modal sheet that slides up from the bottom for contextual content, options, or input the user can browse and dismiss freely. Platform-aware — set `platform` to match the host: iOS renders a liquid-glass panel, Android a material surface. For a blocking decision the user *must* answer, use [Dialog](#dialog) instead.

### Size decision guide

| Content | Use size |
|---|---|
| Long list, filter panel, full form | `fullscreen` |
| Decision prompt, option picker (4–8 items) | `medium` |
| Quick confirm, single action, short tip | `small` |

`small` is **iOS-only** — Android has just `medium` and `fullscreen`, and falls back to `medium` if asked for `small`.

### Use when

- Presenting a contextual decision or selection without leaving the current screen
- The content is a sub-task within a larger flow (e.g. selecting a seat, choosing a date)
- The amount of content doesn't justify a full screen transition

### Do not use when

- The task requires sustained focus and should not show the previous screen behind it — use a full-screen page transition instead
- The content is purely informational with no action required — use an inline expanded section or `Expander`
- You're stacking sheets — only one `BottomSheet` should be visible at a time

### Content rules — title

- 2–5 words; noun-based, describes what the user is selecting or reviewing
- Never use a question as a title ("Are you sure?" → use a confirmation dialog pattern)
- Subtitle adds brief context; optional; max 1 line (not shown on Android `medium`, which is title-only)

**Examples:**

| ✅ Title | ❌ Don't |
|---|---|
| Select seat | Please choose your preferred seat |
| Cancellation policy | Here's what you need to know |
| Baggage options | Baggage |

### Usage

**Do:**
- Provide an `onClose` handler so the user can always dismiss — never trap them in a sheet
- Use the `search` slot (fullscreen) for sheets where the user will filter a long list
- Use the trailing `onAction` button for the single primary action on the sheet; leave it off when there's nothing to confirm

**Don't:**
- Open a `BottomSheet` from inside another `BottomSheet` — only one should be visible at a time
- Use `fullscreen` for fewer than ~8 items — use `medium` instead
- Rely on the title's subtitle to carry essential info on Android `medium` (it isn't rendered)

---

## Dialog

A modal window that interrupts the user to deliver critical information or ask for a single decision. It demands a response before the user can continue — so it is the heaviest interruption in the system. Reach for it only when the cost of *not* interrupting is high.

### Dialog vs. BottomSheet

| Use… | When |
|---|---|
| `Dialog` | A decision is blocking and consequential — confirm/cancel, destructive action, error that halts the flow. Short text + 1–2 actions. |
| `BottomSheet` | Presenting options, content, or non-blocking input the user can browse or dismiss freely (pickers, filters, detail panels). |

If the user can reasonably ignore it and keep going, it is not a Dialog.

### Platform decision guide

| `platform` | Presentation |
|---|---|
| `ios` | Frosted liquid-glass card, start-aligned title + description, pill buttons (stacked, or `layout="side-by-side"` for two) |
| `android` | Material surface, optional leading icon, centered title + description, text actions row |

Follow the platform of the host app; the prop falls back to the `DesignSystemProvider`, then `ios`. The iOS card is the same surface as [ActionSheet](#actionsheet).

On iOS, the affirmative action goes in `primaryAction` for the aqua fill that draws the eye; keep the dismiss action as `secondaryAction`. Use `layout="side-by-side"` only for two short, balanced labels — stack them when either label is long or one action is destructive.

### Use when
- Confirming an irreversible or high-cost action (cancel a non-refundable booking, delete an account)
- Surfacing an error that stops the flow and needs acknowledgement
- Asking a single, focused yes/no or this-or-that question

### Do not use when
- The choice is low-stakes or easily reversible — use a `Snackbar` with an undo, or inline UI
- You are presenting more than two actions or any scrollable content — use a `BottomSheet`
- The message is purely informational and non-blocking — use a `Banner` or `Snackbar`

### Content rules — title
- State the decision or outcome, not a vague heading: "Cancel this booking?" not "Are you sure?"
- One line, no terminal period (it's a heading)
- Phrase as a question when asking for a decision

### Content rules — description
- One or two sentences naming the consequence the user is accepting
- Spell out anything irreversible or costly ("This booking is non-refundable.")

### Content rules — actions
- Actions are role-named props, not an array: iOS uses `primaryAction` / `destructiveAction` / `secondaryAction`; Android uses `action1` / `action2`. Each is `{ label, onClick }`
- The confirming action names the verb ("Cancel booking", "Delete"), never "Yes/OK"
- Put the irreversible action in `destructiveAction` (iOS) so it reads in warning color; the dismiss action is a plain verb that returns the user to safety ("Keep booking", "Back")
- Two actions is the norm; reserve a third (iOS adds `secondaryAction` below the destructive one) for a genuine extra path

| ✅ Do | ❌ Don't |
|---|---|
| Cancel non-refundable booking | Yes |
| Keep my booking | No |
| Delete account | OK |

### Usage
```jsx
<Dialog
  platform="ios"
  title="Cancel this booking?"
  description="This fare is non-refundable. You won't be charged again, but you also won't get a refund."
  destructiveAction={{ label: 'Cancel booking', onClick: confirmCancel }}
  secondaryAction={{ label: 'Keep booking', onClick: dismiss }}
  onClose={dismiss}
/>
```

### Self-check
- Does this genuinely need to block the user, or am I just making sure they noticed?
- Does the confirming button say *what* will happen if tapped?
- If the action is destructive, is that visually and verbally clear?

---

## ActionSheet

A short menu of actions tied to the current item or screen, presented over the content. Unlike a [Dialog](#dialog) it does not pose a question or block on a decision — it offers a small set of *choices*, any of which (including dismissing) is a valid outcome.

### ActionSheet vs. Dialog vs. BottomSheet

| Use… | When |
|---|---|
| `ActionSheet` | The user picks one action from a short list acting on a thing they tapped — "Share", "Edit", "Delete", "Cancel". No blocking question. |
| `Dialog` | A single blocking, consequential decision the user *must* answer before continuing (confirm/cancel). |
| `BottomSheet` | Browsable content, pickers, filters, or input the user explores and dismisses freely — not a flat action list. |

### Platform decision guide

| `platform` | Presentation |
|---|---|
| `ios` | The same frosted liquid-glass card as the iOS Dialog — optional title/description above a stacked column of pill buttons |
| `android` | A Material menu list — an elevated surface of rows, each with an optional leading icon, label, and trailing shortcut/chevron |

Follow the platform of the host app; the prop falls back to the `DesignSystemProvider`, then `ios`. Because the iOS surface is shared with `Dialog`, the two stay visually consistent.

### Use when
- Offering 2–5 actions that operate on the item or screen the user just engaged (a row, a card, a "more" button)
- Surfacing a destructive option alongside safe ones (mark it `destructive` so it reads coral, and place it last)

### Do not use when
- You need a yes/no answer to a blocking question — use a `Dialog`
- The list is long, scrollable, or has selection state, sections, or input — use a `BottomSheet`
- There is a single action — trigger it directly (a `Button` or `IconButton`)

### Content rules
- Labels are verb-first and name the action, not the object's state: "Share trip", "Delete photo" — not "Sharing" or "Photo"
- Sentence case, no terminal period
- Keep the set short and non-overlapping; order by likelihood, with any destructive action last (iOS) so it sits nearest the user's thumb and reads as the exception
- iOS: a title/description is optional — add it only when the actions need framing ("This can't be undone")

| ✅ Do | ❌ Don't |
|---|---|
| Share trip | Sharing options |
| Delete photo | Remove this item from your library? |

### Usage
```jsx
// iOS
<ActionSheet
  platform="ios"
  title="Manage booking"
  actions={[
    { label: 'Share trip', onClick: share },
    { label: 'Edit travelers', onClick: edit },
    { label: 'Cancel booking', onClick: cancel, destructive: true },
  ]}
  onClose={dismiss}
/>

// Android
<ActionSheet
  platform="android"
  items={[
    { icon: <ShareIcon />, label: 'Share trip', onClick: share },
    { icon: <TrashIcon />, label: 'Cancel booking', onClick: cancel, destructive: true },
  ]}
  onClose={dismiss}
/>
```
**Do:** render it conditionally (no `open` prop) and dismiss on scrim tap — selecting nothing is always a valid exit.
**Don't:** use it for a decision the user must not skip, or pile in more than ~5 actions.

---

## ProgressStepper

Linear progress indicator that shows how many steps in a flow are complete. Pill-shaped segments; completed segments fill with primary color.

### Use when

- A multi-step flow has 3–7 clearly distinct steps (booking funnel, onboarding, form wizard)
- The user benefits from knowing how far along they are

### Do not use when

- The flow has fewer than 3 steps — it adds visual weight without meaningful orientation
- Steps are non-linear or can be revisited in any order — use a different navigation pattern
- The step count is unknown or dynamic

### Usage

**Do:**
- Keep `steps` between 3 and 7 — beyond 7 the segments become too narrow on mobile
- Place below the `Navbar`, visible at all times during the flow (not hidden in the toolbar)
- Increment `currentStep` only when the user has successfully completed the step, not when they navigate forward

**Don't:**
- Use as a loading indicator — use a spinner or skeleton instead
- Change `steps` count mid-flow

---

## CircularProgressIndicator

Indeterminate circular loading spinner. Renders the platform-native shape from a single component — a rotating Material 3 aqua arc on Android, the native UIActivityIndicatorView tooth spinner (gray) on iOS — so set `platform` once (via `DesignSystemProvider`) to match the target OS. There is no percentage / determinate mode; it is always an open-ended spinner.

### CircularProgressIndicator vs. ProgressStepper

| Use | When |
|---|---|
| `CircularProgressIndicator` | Open-ended waiting on a *single* operation — loading, fetching, submitting |
| `ProgressStepper` | Orientation through a *multi-step flow* (booking funnel, wizard) — not a wait |

### Use when

- A single operation is in flight and the user must wait for it (fetching results, submitting a form, refreshing a list)
- You want a lightweight "this region is busy" signal

### Do not use when

- The wait replaces page or list content on first load — use a skeleton state so the layout doesn't jump
- You're showing position in a multi-step flow — use `ProgressStepper`
- The action is instant — a spinner that flashes for <300ms reads as a glitch; show nothing

### Content rules — label

- Keep it short and present-progressive: "Loading results…", "Submitting…" — name what is happening, not an instruction
- Use a trailing ellipsis to signal an ongoing process
- Omit the label for inline/in-button waits where the context already explains the wait

| ✅ Do | ❌ Don't |
|---|---|
| Loading results… | Please wait |
| Processing payment… | Click to load |
| Submitting… | Loading… (50%) |

### Usage

```jsx
<CircularProgressIndicator />                          {/* inherits platform */}
<CircularProgressIndicator label="Loading results…" /> {/* status row */}
```

**Do:**
- Center the spinner in the area whose content is loading, so it reads as "this region is busy"
- Use `size="large"` only for full-screen / pull-to-refresh waits; default size for inline and in-component loading
- Use the built-in `label` for a status row instead of placing a separate caption next to the spinner

**Don't:**
- Stack a spinner on top of stale content without dimming or replacing it — it's ambiguous
- Run several spinners on one screen — consolidate to a single loading state

---

## LinearProgressIndicator

Determinate horizontal progress bar driven by a 0–100 `value`. Renders the platform-native shape from a single component — a flat aqua fill on a 6px track on iOS, the Material 3 active bar + gap + remaining track with a trailing stop dot on Android — so set `platform` once (via `DesignSystemProvider`) to match the target OS. Use only when the completion rate can actually be measured.

### LinearProgressIndicator vs. siblings

| Use | When |
|---|---|
| `LinearProgressIndicator` | A *single* operation has a knowable completion percentage — upload, download, multi-page form fill, video buffering |
| `CircularProgressIndicator` | The same wait but the duration/percentage is *unknown* (open-ended spinner) |
| `ProgressStepper` | Orientation through a *multi-step flow* (booking funnel, wizard) — discrete steps, not a continuous percentage |

### Use when

- A process exposes a real, monotonically advancing completion rate (bytes uploaded, pages completed, seconds buffered)
- The user benefits from seeing *how much is left*, not just that something is busy

### Do not use when

- You can't measure progress — use `CircularProgressIndicator` instead of faking a percentage
- The progress is through named, discrete stages the user navigates — use `ProgressStepper`
- The operation is instant — a bar that flashes to 100% reads as a glitch; show nothing

### Usage

```jsx
<LinearProgressIndicator value={uploaded} />               {/* inherits platform */}
<LinearProgressIndicator value={40} platform="android" />
```

**Do:**
- Drive `value` from the real progress signal and let it advance monotonically (0 → 100)
- Keep the same instance configuration for every occurrence of the same process
- Let the consumer's layout set the surrounding margins — the bar fills its container width

**Don't:**
- Animate `value` backward or jump it around to "feel busy" — it breaks the contract that the bar reflects real progress
- Reuse it as an indeterminate spinner by looping it — use `CircularProgressIndicator`

---

## Separator

Full-width 1px horizontal rule. Renders as an `<hr>`. No built-in spacing — control margin via parent layout or `className`.

### Types in practice

The component has a single visual style. Two uses differ only in how they're positioned:

| Use | Spacing above/below | Applied via |
|---|---|---|
| **Between cells** (within a group) | 0 px — built into `Cell`'s `separator` prop | `<Cell separator={true} />` |
| **Between modules** (between content sections) | 16 px — add via parent margin | `<Separator className="my-4" />` |

> Prefer `separator` prop on `Cell` for in-list separators. Use `<Separator />` standalone only between distinct content modules.

### Placement rules

- Never place a separator after the last item in a group
- Do not stack two separators back-to-back
- Avoid when adjacent modules already have visible card borders (double separation)

---

## Cell

Flexible row-based building block for presenting structured information. Carries label, value, leading visual, and a trailing action in a single scannable row.

### Visual hierarchy

Each Cell has a **label** (context) and a **value** (detail). Decide which carries more informational weight and emphasize accordingly — the component renders label as subtext color and value as default color by default.

- **Label-led** (default): label anchors understanding; value delivers the detail. Use when the user needs the label to interpret the value. Example: "Departure · Riyadh — Dubai"
- **Value-led**: value is the primary fact; label is secondary metadata. Use when the value is self-evident. Example: "Saudia · SV401"

Do not treat both as equal weight — one should always lead.

### Trailing indicator rules

- `trailing="chevron"` — use only for navigation to a sub-screen or deeper selection. Do not use merely to signal that the row is tappable.
- `trailing="toggle"` — use for a binary setting that takes effect immediately (the [Toggle](#toggle) _is_ the row's control).
- `trailing="stepper"` — use to adjust a small bounded count in place, without leaving the row (e.g. travelers, rooms, quantity). The [Stepper](#stepper) _is_ the row's control; keep the row's `label`/`subtext` for the unit ("Adults", "Age 12+").
- No trailing — use for display-only rows with no associated action. The trailing `value` text stands on its own.
- `chevron` / `toggle` / `stepper` are **mutually exclusive** — a row carries at most one. `value`, `sideIcon`, and `tag` may still sit before it.

### Selected state

`selected` marks a row as the current choice within a set of mutually exclusive options — tints the row with `--background-base-selected` and draws a `--border-base-selected` outline (the bottom separator adopts the same selected color so the row reads as one enclosed unit).

- Use for picker-style lists where the row itself is the selection target (e.g. choosing a fare class, payment method, or saved address) and the chosen row should stay visibly marked.
- Do **not** use `selected` to imply a checkbox/radio choice — if the row needs an explicit selection control, use `ListItem` instead.
- Only one Cell in a group should be `selected` at a time.

### Anatomy

| Element | Role |
|---|---|
| Label | Context — describes what the value represents |
| Value | Detail — the actual information being presented |
| Visual (`icon` / `3d-icon` / `image`) | Leading visual for category or type |
| Trailing | Action affordance — chevron, toggle, or stepper |
| Selected | Marks the active row in a mutually-exclusive set |

### Truncation

| Element | Limit |
|---|---|
| Label | Max 1 line; truncate with ellipsis |
| Value | Max 2 lines; truncate with ellipsis |

### Usage

**Do:**
- Choose visual size consistently within a screen (`icon` / `3d-icon` / `image` — pick one per list)
- Use chevrons only for navigation to a deeper level
- Use `showSeparator={false}` on the last item in a group

**Don't:**
- Mix visual sizes within the same list
- Use checkboxes or radio buttons inside a `Cell` — use `ListItem` instead
- Group `Cell` and `ListItem` in the same section
- Use `trailing="stepper"` for large or open-ended numbers — for free-form numeric entry use [TextInput](#textinput); for a quantity outside a list row use the standalone [Stepper](#stepper)

---

## List / ListItem

The selectable, scannable list row. `ListItem` renders one row in three types — `icon`, `radio`, `checkbox` — that share the same layout, label, and trailing area; only the **leading marker** differs. The `radio` / `checkbox` types compose the bare [Radio](#radio) / [Checkbox](#checkbox) atoms and own the label, so reach for those atoms directly only when you need a standalone marker without a row.

### ListItem vs. Cell

| Use… | When |
|---|---|
| `ListItem` | The row is a **selection** (radio/checkbox) or a scannable option/policy line — a short one-line label with an optional trailing tag/value, uniform within its section. |
| `Cell` | The row **presents structured information** (label + value, leading visual, navigation chevron) or is a picker whose whole row is the tap target — richer content, up to 2-line values. |

### Variant decision

| Variant (`type`) | Use for |
|---|---|
| `icon` | Policies, key information, non-selectable categorized content |
| `radio` | Form selections where exactly one option can be chosen |
| `checkbox` | Form selections where multiple options can be chosen |

> For a checklist style (included features/benefits), use `type="icon"` with a checkmark SVG as the icon.

### Trailing content — `tag` vs. `keyValue`

Both sit at the trailing edge (tag first, then value). Pick by meaning:

- `keyValue` — the **value half** of the row: a data point paired with the label (price difference, duration, code). Use when the number/detail is what the user compares across rows.
- `tag` — a short **static categorical marker** on the row ("Popular", "Cheapest", "New"). Use to flag or categorize, not to carry a value. Defaults to the neutral tinted `Tag`; pass a `Tag` props object for a colored one.

### Behavior rules

- All items within a section must use the same `type` — no mixing
- For long lists, pair with `Expander` to hide items beyond a threshold
- `skeleton` renders shimmer placeholders — use while data is loading

### Usage

**Do:**
- Use `type="radio"` / `type="checkbox"` for interactive selections that are part of a form
- Use `keyValue` when a trailing value adds critical context (price difference, duration)
- Keep labels to a single line — these are one-line rows

**Don't:**
- Mix `type="radio"` and `type="checkbox"` items in the same list
- Use for long-form paragraphs — these are one-line rows
- Group `Cell` and `ListItem` in the same section
- Use a `tag` to carry a value that belongs in `keyValue` (or vice versa)

---

## Expander

Inline "Show more / Show less" toggle for revealing additional items in a truncated list. Controlled — caller manages `expanded` state.

### Use when

- A list has more items than should be visible by default (e.g. more than 5 filter options)
- The hidden items are of equal importance to the visible ones (not secondary/supplementary)
- Collapsing back ("Show less") would also be useful

### Do not use when

- There are no additional items to reveal — do not render `Expander` at all
- The items load from the server and paginate — use a dedicated "Load more" pattern instead
- The content below is not a list (use a collapsible panel pattern)

### Default labels

The component provides built-in labels. Override via the parent if needed:

| `dir` | Collapsed | Expanded |
|---|---|---|
| `ltr` | Show more | Show less |
| `rtl` | عرض المزيد | عرض أقل |

### Usage

**Do:**
- Place at the natural end of the truncated list, aligned with the list content
- Preserve scroll position when expanding — content must appear inline

**Don't:**
- Use alongside other pagination controls (infinite scroll, page numbers) in the same section
- Scroll the user to the top of the list after expanding

---

## Accordion

A titled section that expands to reveal its content on tap. Use it to let users scan a list of topics and open only the one they care about — managing density on a screen that has more content than fits comfortably.

### Accordion vs. Expander

| Use… | When |
|---|---|
| `Accordion` | Collapsing a *labeled section* of arbitrary content (FAQ answer, fare rules, baggage details). The title stands on its own. |
| `Expander` | Revealing *more of the same list* inline ("Show all 12"). No section title — it continues existing content. |

### Use when
- Grouping content into titled sections the user opens selectively (FAQs, policy details, "What's included")
- The screen has several optional detail blocks and showing them all at once would overwhelm
- Each section's title alone tells the user whether it's worth opening

### Do not use when
- There are only one or two short blocks — just show them
- The content is essential to the task and shouldn't be hidden behind a tap
- You're truncating a single list — use `Expander`
- Sections must be read in order — use a flat layout or `ProgressStepper` flow

### Content rules — title
- Name the content inside so the user can decide whether to open it: "Baggage allowance", not "More info"
- Keep it to a short phrase; sentence case, no terminal period
- For Q&A, phrase the title as the question the user is asking

### Content rules — panel
- Front-load the answer; users open an accordion expecting a direct response
- Keep each panel focused on the one topic its title names

| ✅ Do | ❌ Don't |
|---|---|
| Cancellation & refunds | Details |
| What's included in this fare? | Read more |
| Baggage allowance | Section 2 |

### Usage
```jsx
<Accordion title="Cancellation & refunds">
  <p>Free cancellation up to 24 hours before check-in. After that, the first night is charged.</p>
</Accordion>
```

### Self-check
- Does each title tell the user what they'll get before they tap?
- Am I hiding something the user actually needs to see by default?
- Would a plain, always-visible layout be simpler here?

---

## System Banner

Inline status/message banner — a tinted row with a status icon, a title and description, and an optional action. Comes in two layouts via `platform`: a compact **mobile** row (inline text-link action) and a wide **desktop** row (with an optional `Tag` and a Primary `Button` action). Use for operational or transactional messages that stay visible until the user acts or the issue resolves. Distinct from the promotional [Banner](#banner) (offers, coupon codes) and [VisualCard](#visualcard) (image-led campaigns).

### System Banner vs. Snackbar vs. Dialog

| Use… | When |
|---|---|
| `SystemBanner` | Persistent, contextual status the user should keep seeing while it's relevant — non-blocking. Stays until resolved or dismissed. |
| `Snackbar` | Transient confirmation of an action just completed ("Saved"). Auto-dismisses; no action required. |
| `Dialog` | The message is critical and must block the flow until the user decides. |

### Layout decision

`platform` picks the layout — a viewport axis, not the iOS/Android platform concept. It's the same message and intent either way; only the arrangement and action styling differ.

| Context | Use |
|---|---|
| Mobile products (full-viewport screens) | `mobile` (default) |
| Web / desktop layouts with room for a wide row | `desktop` |

- **Mobile** — compact row: leading status icon, stacked title + description, inline text-link action.
- **Desktop** — wide row: leading icon column, the message, an optional `tag` (e.g. "Ends in 2 days"), and a trailing Primary `Button`. The stronger button and the tag suit the extra width and pointer-driven target.

### Type decision

The `type` selects both the tint and the built-in status icon. Match it to the *nature* of the message, not to grab attention.

| Need / Intent | Use |
|---|---|
| Neutral, factual info on a white surface (low emphasis) | `visual` |
| Neutral, contextual info that should read as a tinted callout | `neutral` |
| Confirmation that a state or action completed | `success` |
| A potential issue the user should be aware of | `caution` |
| A critical problem requiring attention | `error` |

### Use when
- An operational message is tied to the current task ("Your card on file expires before this trip")
- The information should persist while it remains relevant, not flash and vanish
- You need at most one inline follow-up action ("Update card")

### Do not use when
- Confirming a just-completed action with no follow-up — use [Snackbar](#snackbar)
- The decision is critical and must block the user — use [Dialog](#dialog)
- The content is a marketing offer or coupon — use [Banner](#banner)

### Content rules
- Lead with the key fact so users can decide quickly whether they need to act
- **Title** (optional): 3–6 words; the headline of the message
- **Description**: 1–2 short sentences; target ≤ 120 characters
- Name entities explicitly ("Flight SV402", "Hilton Downtown Dubai")
- One action maximum; label it specifically ("Update card", not "Learn more")

| ✅ Do | ❌ Don't |
|---|---|
| Update card | Learn more |
| Flight SV402 is delayed by 2 hours | Something went wrong with your flight |

### Usage

```jsx
<SystemBanner
  type="caution"
  title="Card expiring soon"
  description="The card on file expires before your trip. Update it to avoid issues."
  actionLabel="Update card"
  onAction={openPayment}
/>
```

**Do:**
- Use `visual` / `neutral` for low-stakes info; reserve `error` for genuine problems
- On `desktop`, use `tag` for a short qualifier (expiry, count) — not a second message

**Don't:**
- Stack multiple system banners at the same scroll position
- Use color type as decoration — `success` / `error` carry semantic weight
- Reach for `desktop` inside a mobile product — the compact `mobile` row is the default there

---

## Banner

Inline promotional banner with a tinted background, optional icon visual, and a coupon code pill. Used for contextual offers and coupons. For image-led campaign cards with a price bar, use [VisualCard](#visualcard).

> **Note:** This is the *promotional* Banner. For operational/status messaging (info, success, caution, error), use the separate [System Banner](#system-banner).

### Color decision

The `color` prop selects the tinted gradient background. There is no `size` prop — Banner always renders the small inline layout.

| Intent | Use color |
|---|---|
| Default, no specific category | `neutral` |
| Informational offer | `info` |
| Promotional / discount | `promo` |
| Premium or highlighted campaign | `featured` |

### Content rules

- **Title**: 3–6 words; the hook — benefit-led or curiosity-driven
- **Description**: 1 short sentence; adds detail without repeating the title
- **Code text**: uppercase, max 12 characters

### Usage

**Do:**
- Match the `color` to the brand context (partner colors, seasonal campaigns)
- Wire `onClose` whenever `showDismiss={true}` so users can actually close it

**Don't:**
- Use for system alerts or operational messages — use [System Banner](#system-banner)
- Stack multiple banners at the same scroll position
- Use for image-led campaigns — use VisualCard

---

## VisualCard

Full-bleed image card with a gradient overlay and a price/CTA bar. Used for destination or campaign promotion anchored by a hero image.

### Size decision

| Need | Use size |
|---|---|
| Destination or campaign image with price | `medium` |
| Full hero-style campaign card | `large` |

### Content rules

- **Title**: 3–8 words; expressive, matched to the image
- **Description**: optional; 1 sentence max
- **Price label**: use a standard label ("From", "Starting at") — not custom phrasing
- **Action label**: 2–4 words, verb-first ("Book now", "Explore deals")

### Usage

**Do:**
- Provide a real image — placeholder images make the card look broken
- Set `accentColor` to the image's dominant color so the gradient overlay blends
- Wire `onClose` whenever `showDismiss={true}` so users can actually close it

**Don't:**
- Use for system alerts or operational messages — use [System Banner](#system-banner)
- Stack multiple cards at the same scroll position
- Use vague action labels ("Learn more", "Click here")

---

## AdBanner

A paid, third-party advertising unit — an advertiser's logo and copy, always marked "Sponsored". It is the only promotional component that represents *bought* inventory, so the sponsored disclosure is intrinsic to it, not optional decoration. Distinct from first-party promotion: use it when an external advertiser paid for the placement.

### AdBanner vs. other promotional components

| Use… | When |
|---|---|
| `AdBanner` | A third-party advertiser paid for the placement — must read as "Sponsored" |
| [VisualCard](#visualcard) | First-party, image-led destination/campaign card with a price/CTA |
| [Banner](#banner) | Your own contextual offer with a coupon code |
| [MarketingCard](#marketing-card) | Your own feature/campaign awareness, non-time-critical |

### Layout decision

`layout` chooses the placement shape — pick by where the ad sits, not by device OS (it is **not** the iOS/Android `platform` concept).

| Placement | Use |
|---|---|
| Compact in-feed row on mobile (optional 80px trailing image) | `layout="mobile"` `size="small"` |
| Hero-image card on mobile (in a feed or carousel) | `layout="mobile"` `size="medium"`/`"large"` (image height) |
| Wide strip on a roomy layout, image bleeding off the side | `layout="desktop"` |

### Use when

- An external advertiser has paid to appear in the product
- The placement legally/ethically must be disclosed as sponsored

### Do not use when

- The content is your own (first-party) — use [VisualCard](#visualcard), [Banner](#banner), or [MarketingCard](#marketing-card)
- You want to hide that it's an ad — never suppress the "Sponsored" label to make paid content look editorial

### Content rules

- **Title**: the advertiser's hook, 3–6 words; don't rewrite it into Almosafer's voice — it's their message
- **Sub-copy**: 1 short line of supporting detail
- **Logo**: the advertiser's brand mark, not an Almosafer product/visual icon
- **Image**: the advertiser's creative — it fills a fixed slot cropped to cover (an 80px strip on mobile small, a full-width hero on medium/large, a faded side panel on desktop), so supply a focal-safe asset that survives tight cropping
- **Sponsored label**: keep it — it defaults to "Sponsored"/"ممول". Only override the wording (e.g. "Ad", "Promoted"), never remove it
- **Action label**: 2–4 words, verb-first ("Book now", "View offer")

### Usage

```jsx
<AdBanner
  layout="mobile"
  size="medium"
  logoSrc="/advertiser.png"
  imageSrc="/hero.jpg"
  title="Ad title"
  subtitle="Sub-copy"
  showAction
  actionLabel="Book now"
  onClick={goToAdvertiser}
/>
```

**Do:**
- Provide a real advertiser logo and (for the hero card / desktop) a real image — empty slots make the unit look broken
- On mobile small, add the trailing image only when the advertiser's creative earns the space; omit it (`imageSrc` unset) for a leaner, text-first row
- Turn a CTA on explicitly with `showAction` (outline pill) or `showImageAction` (coral, desktop) — they don't appear just because a label is set
- Reserve the coral `showImageAction` CTA (desktop) for a single, strong advertiser call-to-action
- Keep the chevron when the whole card is tappable; set `chevron={false}` if the card doesn't navigate (e.g. only the CTA acts)

**Don't:**
- Set `showSponsored={false}` to disguise paid content as organic
- Mix an ad into a list of first-party results without the placement clearly reading as an ad

---

## Marketing Card

Raises awareness about a feature, campaign, offer, or opportunity. Friendly, informative, non-intrusive — encourages exploration without demanding immediate action.

### Type decision

| Visual intent | Use type |
|---|---|
| Clean card with image top + text content below | `solid` |
| Compact card with gradient overlay on image | `gradient-small` |
| Tall card with gradient overlay + centered title | `gradient-large` |
| Full-bleed editorial card with display-size title | `display` |

### Use when

- Upselling or cross-selling relevant products in a non-intrusive way
- Highlighting a feature the user may not know about
- Running a campaign or promotion that adds value but is not time-critical
- Introducing something new without interrupting the flow

### Do not use when

- Communicating urgent, critical, or system-level information → use [System Banner](#system-banner)
- The message requires immediate confirmation or dismissal → use `BottomSheet`
- Showing multiple offers at once → arrange as a horizontally-scrollable row of `MarketingCard`s

### Content rules

**Structure (strict hierarchy):**
1. **Title** — the hook; 3–6 words; easy to scan
2. **Subtitle** — adds detail to the title, does not repeat it; 1–2 short sentences
3. **CTA** — specific to the action; 2–4 words

**Writing principles:**
- Lead with value: state the benefit first, then the detail
- Use exact numbers or facts; avoid vague claims ("up to SAR 1,000", not "big savings")
- Show both percentage and absolute value when relevant ("5% off, up to SAR 1,000")
- Include qualifiers where needed ("up to", "per stay")
- Make CTAs specific ("Copy code: ALMBIZ", not "Learn more")
- Stay positive, factual, and confident — avoid hype
- Avoid exclamation marks unless campaign tone explicitly demands it
- One core message per card; never combine multiple offers
- Frontload the most important words for mobile readability

### Examples

| ✅ Do | ❌ Don't | Why |
|---|---|---|
| Plan smarter with the new Fare Calendar | "You're missing out by not using Trip Calendar!" | Fear-based framing; name inconsistency |
| Earn double points when you book a stay this week | "Only a few hours left! Book now or lose your points." | False urgency; loss framing |
| Skip the taxi queue · Arrive stress-free with a driver waiting when you land · [Book a transfer] | Skip the taxi queue and avoid delays · Pre-book your airport transfer today so you can relax knowing a driver will meet you right after you land | Body repeats and over-explains the title; too long |
| Fly Business. Pay Less. · Enjoy 5% off and save up to SAR 1,000 · [Copy code: ALMBIZ] | Up to SAR 1000 off · Save when you fly on Business Class | Weak title; value incomplete; body adds no new information |

### Usage

**Do:**
- Keep titles to 3–6 words; lead with the benefit or hook
- Make subtitle add new detail, not restate the title
- Use specific, action-oriented CTAs
- Use `state="skeleton"` while card data is loading

**Don't:**
- Use fear-based, urgent, or loss-framing language
- Repeat the title in the subtitle
- Combine multiple offers in a single card
- Use exclamation marks as a substitute for a compelling message

---

## Button

Buttons trigger actions. The variant signals the relative importance and risk of the action — choosing the wrong variant misleads users about what they're about to do.

### Variant decision

| Variant | Role | Appears per screen |
|---|---|---|
| `primary` | Drives the most important action; guides the user toward the next meaningful step | Once (ideally) |
| `primary-inverted` | Primary action on a dark or image surface | Once |
| `secondary` | Supports the primary action with a less important or optional path | As needed |
| `secondary-inverted` | Secondary action on a dark or image surface — transparent with a subtle border and white label | As needed |
| `destructive` | Signals risk for actions that delete, cancel, or permanently alter data | When action is irreversible |
| `payment` | Confirms a payment action | Once, in payment flows only |
| `apple-pay` | Apple Pay payment confirmation — official Apple Pay mark + the selected card (no label text) | Once, in payment flows only |
| `gpay-card` · `gpay-personalized` · `gpay-pay-with` · `gpay-checkout-with` | Google Pay payment confirmation — the four lockups Google sanctions (with card / with masked number / "Pay with" / "Checkout with") | Once, in payment flows only |
| `skeleton` | Loading placeholder — no children needed | While loading |

**Icon slots.** The text variants (`primary`, `primary-inverted`, `secondary`, `secondary-inverted`, `destructive`) can carry a `leadingIcon` and/or `trailingIcon`. Use an icon only when it clarifies the action (a chevron for "next", a lock for security) — never for decoration. Icons inherit the label color, so keep them in the Standard System (line) icon set; never place a colorful Visual/Product icon in a button.

**Brand-pay marks are locked.** Never recolor, restretch, or relabel the Apple mark or Google Pay lockup. Apple Pay's surface adapts to the theme automatically (dark button in light mode, light button in dark mode); Google Pay stays dark in both. The card thumbnail (`cardArt`) is the user's real selected funding card — supply it from account data, don't fake it.

### Size guide

| Need | Use |
|---|---|
| Primary CTA of a screen or flow; sticky bottom bars | `default` |
| Compact context — inside cards, dense rows, secondary areas | `medium` |
| Tight inline space — chips-adjacent, table rows | `small` |

Brand-pay variants (`apple-pay`, `gpay-*`) are a single fixed size — `size` doesn't apply. Keep one button size within a single action group.

### Primary Button

**Use when:**
- There is a single key action the user needs to take
- The action leads to progression in a flow or critical task

**Do not use when:**
- Multiple primary actions would appear on the same screen
- The action is minor or optional (use `secondary`)

**Content rules:**
- Start with a verb that reflects the user's goal
- Everyday language — no jargon or system labels
- 1–3 words; structure: `[Verb] + [Object or goal]`

| ✅ Do | ❌ Don't |
|---|---|
| Continue to payment | Proceed |
| Check availability | Next |
| Add to trip | Add |
| متابعة إلى الدفع | المتابعة |
| التحقق من التوفر | التالي |

**Self-check:**
- What is the main thing the user wants to do here?
- If this button stood alone, would it still make sense?
- Can I cut any word without losing meaning?

### Secondary Button

**Use when:**
- There is a non-blocking, optional action (e.g. edit, add, change)
- Multiple peer actions exist with no single dominant one

**Do not use when:**
- The action is destructive or final (use `destructive`)

**Content rules:**
- Strong, direct verbs; reflect the user's optional goal, not a system label
- When shown alongside a primary button: keep labels parallel in tone, tense, and length

| Structure | Pattern | Example |
|---|---|---|
| Explicit action | `[Verb] + [Object]` | "Add return flight" |
| Context-aware (button is next to the object it affects) | `[Verb only]` | "Edit" |

| ✅ Do | ❌ Don't |
|---|---|
| Add return flight | Add |
| Update payment method | Update |
| View cancellation policy | View |
| إضافة رحلة العودة | إضافة |

### Destructive Button

**Use when:**
- The action will delete, cancel, or remove data permanently
- Caution must be visually signaled

**Do not use when:**
- The action can be easily reversed without cost or loss
- The action is a generic opt-out or dismissal (use `secondary-inverted`)

**Content rules:**
- Start with a clear, specific verb ("Cancel", "Delete", "Remove")
- Explicitly name the object being affected — never rely on context alone
- Avoid euphemisms; be direct

| ✅ Do | ❌ Don't | Why |
|---|---|---|
| Delete account | Delete | Clarifies exactly what will be removed |
| Cancel check-in | Undo | Avoids vague or technical terms |
| Remove payment method | Clear | "Clear" is less direct and causes ambiguity |
| Cancel non-refundable booking | Cancel reservation | "Non-refundable" adds critical consequence context |

### Payment buttons

The confirm-payment control comes in three flavours. Show the one that matches the method the user is paying with — never stack all three.

| Use… | When |
|---|---|
| `payment` | In-house checkout confirmation (card, wallet balance, pay-later) — the generic green confirm button |
| `apple-pay` | The user is paying with Apple Pay (typically iOS with a provisioned card) |
| `gpay-*` | The user is paying with Google Pay — pick the lockup that fits the context (`gpay-card` / `gpay-personalized` show the selected card; `gpay-pay-with` / `gpay-checkout-with` are label-led) |

**Content rules:**
- `payment` — state the action and, where it adds confidence, the amount: "Pay now", "Pay SAR 499". Verb-first, no jargon.
- `apple-pay` / `gpay-*` carry **no editable label** — the Apple mark and the Google "Pay with" / "Checkout with" copy are brand-mandated. Don't try to pass your own text.
- Reserve all three for the actual payment step — never as a generic "continue" or on non-payment screens.

### Usage
```jsx
<Button variant="primary" label="Continue to payment" onClick={pay} />
<Button variant="secondary" label="Add return flight" leadingIcon={<PlusIcon />} />
<Button variant="destructive" label="Cancel booking" onClick={cancel} />
<Button variant="payment" label="Pay SAR 499" onClick={confirm} />
<Button variant="apple-pay" cardArt={selectedCard} onClick={applePay} />
```
**Do:** keep one primary action per screen; make brand-pay buttons match the wallet actually being used.
**Don't:** put a colourful icon in a text button, or show a wallet button for a method the user can't use here.

---

## IconButton

A square, pill-radius button whose entire label is a single icon. Use it only when the icon's meaning is unambiguous on its own — a wordless control trades clarity for compactness, so the saving has to be worth it.

### Variant decision

| `variant` | Role |
|---|---|
| `primary` | The main icon action in its context (coral fill) |
| `secondary` | A supporting icon action — outlined, neutral surface |
| `overlay` | Icon action sitting on top of an image or media (semi-transparent dark scrim, light icon) |
| `grey` | A muted, low-emphasis action on a subtle grey surface |

### Use when
- The action is universally understood from its icon alone (close ✕, back ‹, share, favourite)
- Space is tight — toolbars, navbars, over images, card corners
- The icon repeats across many items and a text label would be redundant

### Do not use when
- The icon's meaning is even slightly ambiguous — use a `Button` with a label
- It's the primary action of a flow or screen — use a labelled `Button`
- The icon represents a product category (Flights, Stays) — that's a product icon in navigation, not a control

### Content rules
- There is no visible label, so an **`aria-label` is required** — describe the action as a verb phrase ("Share trip", "Close", "Add to favourites")
- Use a Standard System (line) icon, single-color — never a visual or product icon
- One icon, one action; don't overload with state the icon can't convey

| ✅ aria-label | ❌ aria-label |
|---|---|
| Share trip | Share icon |
| Close | Button |
| Add to favourites | ❤️ |

### Usage
```jsx
<IconButton variant="secondary" icon={<ShareIcon />} aria-label="Share trip" />
<IconButton variant="overlay" icon={<CloseIcon />} aria-label="Close" />
```

### Self-check
- Would a first-time user know what this does without a label?
- Does it have an `aria-label` that names the action?
- Is the icon a single-color system icon, not a decorative one?

---

## GlassButton

A translucent "liquid glass" action button for floating controls — primarily the back and trailing actions inside `Navbar`, and any control that sits over imagery or a blurred surface. Where `IconButton` is an opaque control for solid backgrounds, `GlassButton` is the over-content counterpart.

### Surface (`bg`) decision

| `bg` | Role |
|---|---|
| `default` | Light liquid glass over a light/blurred surface (dark glyphs) |
| `primary` | Emphasised action — solid aqua fill, white glyphs |
| `dim` | Dark liquid glass over photography/dark imagery (white glyphs) |

### Type decision

| `type` | Content |
|---|---|
| `back` | Back chevron (mirrors in RTL) — 44×44 circle |
| `x` | Close ✕ — 44×44 circle |
| `1-icon` | A single consumer icon |
| `2-icons` | Two consumer icons in one pill |
| `label` | Text only |
| `back-label` | Back chevron + text (e.g. "‹ Flights") |

### Use when
- A control needs to float over an image, map, or blurred navbar without an opaque background.
- You're building the back / share / close actions of a glass (iOS) navigation bar.

### Do not use when
- The button sits on a plain opaque surface — use `Button` or `IconButton` (glass over a flat color reads as muddy).
- It's the primary CTA of a flow — use a labelled `Button`.

### Content rules
- Icon-only types (`back`, `x`, `1-icon`, `2-icons`) need an **`aria-label`** naming the action.
- Use Standard System (line) icons for `icon1` / `icon2`, single-color.
- Pick `dim` over photography and `default` over light/blurred chrome — matching the surface is what keeps the glass legible.

### Usage
```jsx
<GlassButton bg="default" type="back" onClick={goBack} aria-label="Back" />
<GlassButton bg="dim" type="1-icon" icon1={<ShareIcon />} aria-label="Share" />
<GlassButton bg="primary" type="back-label" label="Flights" onClick={goBack} />
```

---

## BottomActionBar

Sticky bottom bar for booking and payment flows. Controls the primary forward action throughout a funnel.

### Type decision

| Flow context | Use type |
|---|---|
| Entry point — first CTA showing starting price | `starting-price` |
| Mid-funnel step — user sees booking details + continue | `funnel` |
| Final payment confirmation | `payment` |

### Content rules

- **`actionLabel`**: verb-first, 2–4 words — matches the step's goal ("Book now", "Continue", "Pay SAR 1,215")
- **`fromLabel`**: short, standard label ("Starting from", "From") — not custom marketing copy
- **`bookingDetailsLabel`** (`funnel`): "Booking details" or equivalent — always shows what the back link reveals

### Usage

**Do:**
- Show original price struck-through (`originalPrice`) only when there is a genuine discount
- Use `type="payment"` with the actual payment method name — don't use generic "Pay now" when you know it's Apple Pay

**Don't:**
- Change `actionLabel` to something passive ("See options") — it must confirm the action the bar triggers
- Show `originalPrice` without a corresponding offer or promotion visible on the screen

---

## Checkbox

Control that lets users select one or multiple independent options.

> `Checkbox` is the bare tick-box atom (the 20×20 marker only). For a labeled selection row use `ListItem type="checkbox"`, which pairs the box with the label + key-value; for a standalone labeled checkbox, wrap the atom in your own `<label>`. The content rules below govern that label text wherever it lives.

### Use when

- Allowing multiple selections from a list of independent options
- The user can opt into or out of a setting or feature
- The selection state can be reviewed or edited later

### Do not use when

- The action should be immediate → use a `Button`
- The user must choose exactly one option → use `Radio`
- Asking for a final commitment or confirmation → use a `Button`
- The selection would trigger a new flow → use a `Button` or `Toggle`

### Content rules

#### Header (required above any checkbox group)

- Always introduce a group with a clear, standalone header or label
- Questions are allowed as headers
- Do not end the header with punctuation unless it is a question
- Add helper text below the header when needed

#### Group options

- Use a noun, short phrase, or full sentence — no ending punctuation
- All options in a group must follow the same grammatical pattern — do not mix types

| Pattern | When to use | Examples |
|---|---|---|
| Verb-led | Option represents an action | "Receive flight updates" · "Add trip insurance" |
| Noun | Option represents a feature or selection | "Extra legroom" · "Window seat" · "Priority boarding" |
| First-person | Option represents a preference or acknowledgment | "My dates are flexible" · "I want a vegetarian meal" |

- Do not use negation in the label — the unchecked state represents "no" (✅ "Send me updates" / ❌ "Don't send me updates")

#### Single checkbox

- Use first-person perspective when the label reflects the user's choice ("I agree to the terms", "Use my loyalty points")
- Do not use second-person phrasing ("You agree...", "Use your...")
- No ending punctuation

### Examples

| ✅ Do | ❌ Don't | Why |
|---|---|---|
| Select your special requests · اختر طلباتك الخاصة | Please include · يرجى الإضافة | Header must be standalone |
| Use my saved traveler details · استخدِم بيانات المسافر المحفوظة | Use your saved traveler details | First-person keeps focus on the user's decision |
| I agree to receive emails · أوافق على استلام الرسائل الإلكترونية | I agree to receive emails. | No ending punctuation |
| Extra legroom / Window seat / Priority boarding (all nouns) | Add legroom / I want a window seat / Priority boarding (mixed) | Mixing patterns breaks parallelism |
| Receive updates by SMS | Don't send me SMS updates | Negative phrasing confuses what the checked state means |

### Self-check

- Is it clear what selecting this checkbox actually does?
- Is the phrasing positive, not negative?
- Are all options in a group structured the same way?

---

## Radio

Control that lets users select exactly one option from a set. Selecting one option automatically deselects the others.

> `Radio` is the bare radio-button atom (the 20×20 marker only). For a labeled selection row use `ListItem type="radio"`, which pairs the marker with the label + key-value (pass the same `name` to group); for a standalone labeled radio, wrap the atom in your own `<label>`. The content rules below govern that label text wherever it lives.

### Radio vs. Checkbox

| Use… | When |
|---|---|
| `Radio` | Options are *mutually exclusive* — exactly one can be chosen (fare type, cabin class, payment timing). Picking one clears the rest. |
| `Checkbox` | Options are *independent* — zero, one, or many can be chosen (add-ons, preferences), or a single opt-in/acknowledgment. |

### Use when

- The user must choose exactly one option from a list
- All options are mutually exclusive
- The user must make a decision to continue

### Do not use when

- The user can select multiple options → use `Checkbox`
- You want to trigger an action immediately → use a `Button` or `Toggle`
- Only one option exists → use a `Checkbox` or a label instead

### Content rules

#### Header (required above any radio group)

- Always introduce the group with a clear, standalone header or label
- Questions are allowed as headers
- Add helper text below when needed (e.g. "Subject to availability")

#### Options

- Short, clear labels — no ending punctuation
- All options must follow the same grammatical pattern — no mixing
- Prefer nouns for categories; avoid action verbs ("Add", "Choose")
- When the selection impacts cost or refundability, add a qualifier inline (e.g. "+AED 50", "non-refundable")
- Negation is acceptable only when it is a natural part of the mutually exclusive set (e.g. "None", "Non-refundable")

### Examples

| ✅ Do | ❌ Don't | Why |
|---|---|---|
| Refundable / Non-refundable | Refundable / Don't refund | Use domain-standard terms |
| Room only / With breakfast | Include breakfast / No breakfast | Single opt-in phrasing belongs to Checkbox |
| Cabin bag only / 1 checked bag / 2 checked bags | Add 1 bag / Add 2 bags | "Add" is an action verb — belongs to Button/Checkbox |
| Pay now / Pay later | Now / Later | Shortened labels lose clarity |
| Window / Aisle / No preference | Window seat / Aisle seat / Middle seat | "Middle seat" implies negative experience |
| Sea view / Garden view | With sea view / Without sea view | "With/without" framing is unequal |

### Self-check

- Are these options mutually exclusive?
- Is the list complete so the user always has a valid choice?
- Are all labels parallel in structure?

---

## Toggle

Binary on/off switch. For settings that take effect immediately — no confirmation step required. Wraps `<input type="checkbox">` via `forwardRef`. Platform-aware: iOS shows a 64×28 track with a wide white pill knob; Android shows a Material 3 52×32 switch — an outlined track with a small handle when off, filling to aqua with a larger white handle when on. Set the platform once via `DesignSystemProvider` (or per-instance with the `platform` prop); it defaults to iOS.

### Use when

- The user is turning a persistent setting on or off
- The change applies instantly without a "Save" button
- The choice is binary and independent from other settings

### Do not use when

- The change triggers a one-time action → use a `Button` or `Checkbox`
- The setting depends on other settings → use `Checkbox` or `Radio`
- The change has serious or irreversible consequences → use a `destructive` Button
- The state change is not immediate → use a `Checkbox` with a save/confirm step

### Content rules

- Label the **state or setting**, not the action — the label names what is being toggled
- Keep labels short; noun-based where possible
- Use helper text below the label if the impact is not immediately obvious

| ✅ Do | ❌ Don't | Why |
|---|---|---|
| Price alerts | Turn on price alerts | "Turn on" implies a one-time action |
| Flight updates | Receive flight updates | Verb-led phrasing implies an action, not a state |
| Dark mode | Enable dark mode | Label the setting, not the act of enabling it |

### Self-check

- Does the change happen immediately without extra steps?
- Would the label make sense with "on / off" placed next to it?

---

## TextInput

Floating-label text field with helper/error text and optional leading/trailing icons.

### Anatomy

| Element | Role |
|---|---|
| Label | Concise, always-visible field name that floats above the input when focused or populated |
| Input | Native `<input>`; receives all standard input props |
| Helper text (`helperText`) | Short clarification or example; visible in active state |
| Error text (`errorText`) | Specific, actionable validation message; shown when non-empty (drives error styling) |
| Leading icon | Optional 24px icon on leading side |
| Trailing icon | Optional 24px icon on trailing side; hidden in error state (replaced by error circle icon) |

### Content rules — labels

- 1–4 words; noun-based, describes the field's purpose
- Sentence case; no punctuation
- Avoid redundant words ("Enter your", "Type the") — label names the field, not the action

| ✅ Do | ❌ Don't |
|---|---|
| Email address | Enter your email address |
| Date of birth | DOB |
| Passport number | Please type your passport number |

### Content rules — helper text

- Use only when the format or constraint is non-obvious
- Max 1 sentence; example or clarification only
- Do not restate the label

### Content rules — error messages

- Specific and fixable — tell the user what went wrong and what to do
- Plain language — no error codes or system terms
- Do not use generic messages ("Invalid input", "Error")

| ✅ Do | ❌ Don't |
|---|---|
| Enter a valid email address | Invalid email |
| Passport number must be 9 characters | Field is required |
| Date must be in the future | Error |

### Validation

- Mark required fields with `*`
- Trigger `errorText` at the right moment — on blur for format validation, on submit for business rules
- Do not block submission for non-critical optional fields

### Usage

**Do:**
- Always pass both `value` and `onChange` (controlled)
- Use `helperText` for format hints, `errorText` for validation failures — not both at once

**Don't:**
- Rely on placeholder text to communicate the label — the floating label handles this
- Show `errorText` before the user has interacted with the field

---

## Search

Platform-aware search bar — an iOS liquid-glass pill or an Android Material docked bar. Used as a standalone search input or embedded in a `Navbar`. Set `platform` (or a `DesignSystemProvider`) to match the surrounding UI.

On Android, focusing or typing collapses the leading magnifier into a back arrow (which fires `onClose`) and shows a trailing × to clear — mirror this with `onClose`/`onClear` so the field can both reset and dismiss. On iOS the field stays a pill; add a separate close affordance with `showClose` only where search is dismissible.

### Use when

- The screen's primary purpose is search (search results page, filter screen)
- Embedded in `Navbar` via `search={true}` for persistent search access at the top of a screen

### Do not use when

- The input is for structured data entry → use `TextInput`
- There is only one item to find and no filtering is needed

### Content rules — placeholder

- Generic default ("Search") is correct when the scope is clear from context
- Add a specific placeholder when the scope could be ambiguous ("Search hotels in Dubai", "Search by destination")
- Keep placeholder short — it disappears when the user starts typing

### Usage

```jsx
<Search
  platform="ios"
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  onClear={() => setQuery('')}
/>
```

**Do:**
- Drive the field with `value` + `onChange` for real search; for a static/prefilled demo, omit `value` and seed the text with `label`
- Wire `onClear` to reset the query — the component fires it when the × is tapped (and resets itself when uncontrolled)
- Use `showClose` + `onClose` when an iOS search bar can be dismissed (e.g. a search overlay); on Android the leading back arrow already plays this role via `onClose`

**Don't:**
- Use for filtering a short list (fewer than ~10 items) — use `SegmentedControl` or checkboxes
- Show a dismiss affordance when search is always visible — it implies search can be closed when it can't

---

## Chip

An interactive pill the user taps to filter, select, or open a picker. Unlike a `Tag` (which is a static, read-only label), a Chip is always actionable and carries a selected/unselected state.

### Chip vs. Tag

| Use… | When |
|---|---|
| `Chip` | The element is *tappable* — applying a filter, toggling a choice, or opening a picker. Has a selected state. |
| `Tag` | The element is *read-only* — labelling a factual property ("Non-refundable", "Economy"). Never interactive. |

### Use when
- Filtering a list by tappable criteria ("Direct", "Free cancellation", "5★")
- Letting the user toggle one or several quick choices inline
- Triggering a filter or picker — use `dropdown` so the trailing chevron signals it opens a panel

### Do not use when
- The label is purely informational and not tappable — use a `Tag`
- There is a single binary setting that takes effect immediately — use a `Toggle`
- Options are mutually exclusive and few (2–4) and you want a segmented look — use `SegmentedControl`
- The choice is part of a long-form list — use `Radio` / `Checkbox` rows

### Content rules
- One or two words naming the filter value or choice, not an instruction: "Direct", not "Show direct"
- Sentence case; no terminal punctuation
- Keep labels parallel across a chip group (all nouns, or all the same shape)
- A `dropdown` chip's label names the category it filters ("Stops", "Price"), updating to the chosen value once set ("1 stop")

| ✅ Do | ❌ Don't |
|---|---|
| Direct | Show only direct flights |
| Free cancellation | Cancellation |
| Under SAR 500 | Cheap |

### Self-check
- Is this element actually tappable? If not, it should be a `Tag`.
- Does the label read as a value/choice rather than a command?
- If it opens a picker, did I set `dropdown` so the affordance is visible?

---

## Stepper

Numeric increment/decrement control — minus button, count display, plus button. Used for choosing quantities.

### Use when

- The user needs to pick a count from a small range (travelers, bags, rooms, nights)
- The range is bounded and the user benefits from seeing the current value at all times
- Increments are fixed (always +1 / -1)

### Do not use when

- The range is large or continuous → use `Slider`
- The options have labels or prices attached → use `Radio` or Select Pattern
- The user needs to type a specific number → use `TextInput`

### Usage

**Do:**
- Always set `min` (typically 0 or 1) and `max` when an upper bound applies
- Show the label or context for what is being counted adjacent to the component ("Adults", "Checked bags")
- Default to 0 for optional quantities, 1 for required ones (e.g. at least 1 adult)

**Don't:**
- Use `Stepper` without visible context — the number alone is meaningless
- Allow `value` below the meaningful minimum (e.g. -1 travelers)

---

## Slider

Continuous range input. Used for selecting a value within a defined range.

### Use when

- The user needs to filter or select within a continuous range (max price, max distance, minimum rating)
- Exact values matter less than the relative position (budget range, distance filter)
- Using `ticks` to define discrete snap points is acceptable

### Do not use when

- The options are discrete and labeled → use `Radio` or `SegmentedControl`
- The range is very narrow (3–5 values) → use `Radio`
- The user needs to set two endpoints → two `Slider`s (min/max range pattern, not one component)

### Usage

**Do:**
- Always show the current value and range boundaries in the adjacent UI (the component itself only shows the track)
- Set `ticks` when snapping to a small set of meaningful values (e.g. star ratings 1–5)
- Label the axis ends clearly ("SAR 0" / "SAR 5,000+")

**Don't:**
- Use without visible min/max labels — the user can't interpret the value without scale context
- Set a `max` significantly higher than what users would realistically choose — compress the useful range

---

## Tag

Static, non-interactive label that communicates a fixed property, category, or status.

### Use when

- Displaying a permanent or factual property ("Economy", "Breakfast included")
- Communicating categorical information that helps users compare items
- Improving scannability in lists or detail pages without requiring interaction

### Do not use when

- The label is dynamic or time-bound → use `Callout`
- The label is comparative or data-backed → use `Accolade`
- Showing numeric counts or live activity → use `Badge`
- The user needs to take an action → use a `Button`

### Content rules

- 1–3 words; short and scannable
- Sentence case ("Family friendly", not "FAMILY FRIENDLY")
- Nouns or noun phrases; avoid verbs unless part of a fixed category name
- Objective and factual — no subjective or promotional language

**Examples:** Family friendly · Economy · Ocean view · Cancelled · Non-refundable

### Self-check

- Is this a fixed fact that will still be true next week?
- Should this be a `Callout` or `Accolade` instead?

---

## Callout

Non-interactive label for time-sensitive or dynamic information. Gradient sparkle icon + text.

### Use when

- The information is temporary and may change quickly (price changes, limited availability, time-bound deals)
- The message is directly tied to the user's current context (specific flight or property)

### Do not use when

- The information is static or permanent → use `Tag`
- The label is data-backed and comparative → use `Accolade`
- Showing a count or notification → use `Badge`
- The message requires user action → use a `Button`

### Content rules

- Factual and time-bound — no speculation or vague claims
- Under 6 words; noun-based phrases preferred
- Specific over ambiguous: "3 hours left" not "ending soon", "Price dropped 25%" not "great deal"

**Examples:** Cheapest for your dates · 4 seats remaining · Price likely to increase · Most booked this week

### Self-check

- Is this fact true right now and likely to change soon?
- Does it help the user decide, or is it just creating pressure?

---

## Accolade

Non-interactive label for standout qualities based on verifiable data, reviews, or awards. Gradient sparkle icon + gradient text.

### Use when

- The label is based on credible metrics (review scores, category rankings, guest feedback)
- Highlighting a genuine, competitive strength ("Top rated for cleanliness")
- Showcasing an award or ranking from a verified source

### Do not use when

- The claim is subjective, unverified, or purely marketing-driven
- It duplicates an existing factual property ("Breakfast included" is a `Tag`, not an `Accolade`)
- It depends on dynamic conditions or communicates urgency → use `Callout`

### Content rules

- 1–6 words; short enough to scan at a glance
- Factual, evidence-based, and positive — no hype
- No punctuation at the end
- Parallel phrasing when multiple accolades appear together

**Examples:** Top rated for cleanliness · Guests loved the location · Award-winning spa · Family favourite

### Self-check

- Is this verifiable from a credible source?
- If a user asked "Says who?", could you point to the source?
- Does it add decision-making value, or is it marketing fluff?

---

## Badge

Notification indicator. Overlaid on an icon when children are provided; standalone otherwise.

### Type decision

| Need | Use type |
|---|---|
| Numeric count (notifications, items in cart) | `alert` with `count` |
| "New" label on a feature or item | `new` |

### Use when

- Indicating unread notifications, unseen items, or pending actions on a navigation icon
- Flagging a new feature, tab, or item with a "NEW" marker

### Do not use when

- Communicating status of an item (use `Tag` or `Callout` inline)
- The count is not meaningful to the user (e.g. internal IDs)

### Usage

**Do:**
- Set `max={99}` (default) to cap large counts — display as `99+`
- Wrap the target icon as `children` for automatic positioning

**Don't:**
- Show a `Badge` with `count={0}` — hide it when there's nothing to indicate
- Use `type="new"` for more than a few weeks after launch — remove once the feature is established

---

## Tooltip

Text bubble anchored to a trigger element. Always visible when rendered — control visibility externally via state or CSS.

### Use when

- Providing a brief clarification for an icon, abbreviation, or non-obvious UI element
- The explanation is short enough to fit on one line (under ~60 characters)

### Do not use when

- The content is essential to completing a task — put it in the UI directly
- More than one line of explanation is needed — use a `BottomSheet` or inline helper text
- On touch-only devices where hover isn't available — use `Snackbar` or inline text instead

### Content rules

- 1 short sentence or phrase; no punctuation unless grammatically required
- Plain language — no jargon
- Should answer "What is this?" or "Why is this disabled?"

### Usage

**Do:**
- Use `position="top"` (default) unless the tooltip would be clipped at the top of the screen
- Use `arrowAlign="start"` or `"end"` when the trigger is near an edge and the bubble would overflow

**Don't:**
- Use for primary content — tooltips are supplemental
- Wrap interactive content (buttons, links) inside the tooltip bubble

---

## Snackbar

Temporary, non-blocking notification for short feedback after a user action. Auto-dismisses after `duration` ms (default: 3 seconds).

### Types (conceptual — no `type` prop on component)

| Intent | Example |
|---|---|
| **Confirmation** | "Seat preference saved" |
| **Nudge** | "You can change this later in settings" |
| **Tip** | "Tap and hold to reorder" |

### Use when

- Providing lightweight, temporary feedback about a recent action
- The user does not need to take further action

### Do not use when

- The message is a warning, error, or critical → use `Banner` (or [System Banner](#system-banner))
- The content requires user action
- The user must read the message before proceeding

### Content rules

- Under 80 characters; most important words first
- Self-contained — must make sense without additional context
- No punctuation unless grammatically required

### Self-check

- Will the message still make sense if it auto-dismisses without interaction?
- Could this be critical or blocking? → If yes, use `Banner` instead

---

## Select Pattern

A layout pattern for single-choice selection using card-based rows rather than a plain `Radio` list. Used when options need contextual detail (icons, prices, policies) to support the decision.

> This is a pattern, not a single component. Compose it with `ListItem type="radio"` or a card wrapper + `Radio`.

### Use when

- Choosing between meaningful options that each require supporting detail (payment methods, fare types, transport options)
- The difference between options is in their content, not just their label (ALM Fly vs Flex vs Premium)

### Do not use when

- Options are simple labels with no supporting detail → use `Radio` in a `ListItem`
- The decision is binary → use `Toggle`
- Options need to be compared side-by-side → use a table layout

### States

| State | Description |
|---|---|
| Default (unselected) | Neutral border (`--border-base-default`) |
| Selected | Primary border (`--border-primary-default`); radio filled |

### Usage

**Do:**
- Display key differentiators upfront (refundability, baggage, price difference)
- Keep each card concise; use `Expander` to reveal additional detail on demand
- Make full-card tap trigger selection (not just the radio button)

**Don't:**
- Use for binary decisions → use `Toggle`
- Overload cards with secondary information — move detail into expandable areas

---

## Hero *(planned — not yet implemented)*

Large visual header showcasing a product or place. Full-bleed image with optional gallery swipe, gradient overlay, and overlaid controls.

### Planned variants: Single image · Gallery

### Planned behavior

- Swipe left/right to navigate (touch); arrows on desktop
- Infinite loop with per-image snapping
- Video auto-play off by default

### Planned content rules

- No text overlaid directly on images
- All gallery slides must use the same aspect ratio
- Preferred ratios: 3:2, 9:16

---

## Card *(planned — not yet implemented)*

Container that groups related product information (hotel, flight, activity) into a scannable block for list views and comparison. Internal structure uses `Cell` and `ListItem` components.

### Planned anatomy: Eyebrow · Header · Hero image · Content (Cell/List) · CTA

### Planned content rules

- One primary CTA per card
- Never truncate price, dates, or critical figures
- Skeleton: image block + 1–2 header lines + 2 body lines + CTA bar

---

## Price *(planned — not yet implemented)*

Standardized price display with optional promo label, strikethrough original price, and context label.

### Planned anatomy

| Element | Role |
|---|---|
| Promo label | Optional `Callout` describing the offer ("Price drop 26%") |
| Primary price | Bold, prominent; the key figure |
| Strikethrough price | Original price when a discount applies |
| Context label | Scope clarification ("Total for 4 nights incl. VAT") |

### Planned content rules

- Always use `--color-metal` for price values — no other color
- Never show a strikethrough price without a corresponding promo context

---

## AlmosaferLogo

The brand identity component. Covers all official logo formats — wordmark (text + mark), logomark (mark only), and app logo (rounded square with mark).

### Type decision

| Type | When to use |
|---|---|
| `wordmark` | Primary brand placement — splash screens, onboarding, marketing headers, footers. Use when there is enough horizontal space. |
| `logomark` | Compact contexts — app headers, favicons, inline brand references where the wordmark would be too wide. |
| `applogo` | App store assets, home screen icons, notification thumbnails, contexts that require the rounded-square container. |

### Variant decision

| Variant | When to use |
|---|---|
| `colour` | Default. Use on white or light neutral backgrounds. |
| `white` | Use on dark brand backgrounds (`--color-almosafer`, deep navy, photography). Never on white. |

### Language (`lang` prop — wordmark only)

| Value | Use |
|---|---|
| `en` | English wordmark — left-to-right layouts |
| `ar` | Arabic wordmark — right-to-left layouts |

The `lang` prop has no effect on `logomark` or `applogo` — both are language-neutral.

### Usage

- Never recolor or apply CSS filters to the logo — all colors are brand-locked in the SVG.
- Do not place the colour wordmark on a colored background unless contrast has been verified.
- The white variant requires a sufficiently dark background; the minimum recommended background is `--color-almosafer` (`#003143`).
- Scale only with the `width` prop — the component maintains the correct aspect ratio automatically.
- Do not crop or partially obscure the logo.
- Minimum recommended widths: wordmark 88px · logomark 16px · applogo 24px.

---

## Airline Logos

Full-color carrier brand marks (`src/icons/airline-logos/`) for identifying a specific airline in flight results, itineraries, boarding info, and fare breakdowns. They are brand assets, not UI icons — use them only to name a carrier, never as a generic "flights" symbol (use the Flights product icon for that).

### Naming

Each file is named by the carrier's **two-character IATA code** — the same code that appears on the ticket and in flight data. Resolve the airline from its IATA code, not its display name:

| Code | Airline | Code | Airline | Code | Airline |
|---|---|---|---|---|---|
| `6E` | IndiGo | `G9` | Air Arabia | `OV` | SalamAir |
| `EK` | Emirates | `GF` | Gulf Air | `QR` | Qatar Airways |
| `EY` | Etihad Airways | `J9` | Jazeera Airways | `RJ` | Royal Jordanian |
| `F3` | flyadeal | `KL` | KLM | `RX` | Riyadh Air |
| `FZ` | flydubai | `KU` | Kuwait Airways | `SM` | Air Cairo |
| `LH` | Lufthansa | `MS` | EgyptAir | `SV` | Saudia |
| `NP` | Nile Air | `TK` | Turkish Airlines | `WY` | Oman Air |
| `XY` | flynas | | | | |

### Usage

- Never recolor or apply CSS filters — brand colors are baked into each SVG. Use `className`/`style` for sizing and layout only.
- Pair with the airline name in text; the logo alone is not an accessible label.
- When a logo for a carrier is missing, fall back to text (airline name) — do not substitute a different airline's mark or a generic icon.

---

## Footer

The closing block of a page. It bundles everything a visitor reaches for at the end of a session — app download, 24/7 contact, site links (Corporate, Support, Legal, Social media, Countries), and the trust/legal strip (awards, business taglines, accepted payments, licenses, copyright). It is data-driven with full Almosafer defaults, so `<Footer />` is the complete footer; override individual sections for other markets or surfaces. Reuses the shared brand-mark sets ([AlmosaferLogo](#almosaferlogo) for the app logo, and the Logotypes payment/social/flag marks) and [Separator](#separator) between the brand rows — don't inline one-off logos.

### Platform guide

A `platform` prop picks the layout (a layout axis, not the iOS/Android platform concept). Same content, two shapes — set it to match the surface, not per use.

| `platform` | When |
|---|---|
| `desktop` (default) | A **web / desktop** page. Full-width, multi-column, with app-store badges, a QR barcode, and a payment-methods row. |
| `pwa` | A **mobile web-app** screen. Stacked ghost cards, a single "Get the app" CTA (no badges/QR), single-star ratings, inline link groups, and a bottom social-icon row. No payment methods. |

### Use when
- You need a page's standing footer — `desktop` for web, `pwa` for a mobile web-app screen.
- You want one consistent place for legal links, licenses, payment trust marks, and app-download prompts.

### Do not use when
- You're inside a **native mobile app** screen — native apps carry navigation in [TabBar](#tabbar) and their own chrome. (`pwa` is for mobile *web* apps, not native.)
- You only need a bottom action for a flow — use [BottomActionBar](#bottomactionbar).
- You only need a short row of legal/copyright text — render it directly; the Footer is a full multi-section block, not a one-liner.

### Content rules
- **App promo:** title is a short prompt ("Get the Almosafer app!"); on `desktop` the description is one benefit-led sentence (≤ ~160 chars), on `pwa` it's a one-line tagline ("Join 11M+ users across MENA"). The CTA is verb-first ("Get the app"). `stats` / `ratings` must be real, current figures — never placeholder or aspirational numbers.
- **Link labels:** 1–3 words, sentence case, no terminal period ("About us", "Terms & conditions"). Group under a clear column title.
- **Contact values must be actionable:** wire `href` to `tel:`, `wa.me`, or a branch-locator URL — a phone number that isn't tappable is a dead end.
- **Countries / Social:** trim the lists to the deployment market; don't ship links to markets you don't serve.
- **Licenses:** use the shortest accurate official label + number; these are legal, so don't paraphrase.
- **Taglines** are short brand claims ("Leading Online Travel Agency"), not marketing sentences — keep them to a few words.

### Language
Text defaults are **dir-aware** — `dir="ltr"` renders English, `dir="rtl"` auto-translates every default string to Arabic (and mirrors the layout). You only pass text props to override a specific string; a fully Arabic footer needs just `dir="rtl"`.

### Usage
```jsx
<Footer />                              {/* full Almosafer desktop footer (English) */}
<Footer dir="rtl" />                    {/* same footer, auto-translated to Arabic */}
<Footer platform="pwa" />              {/* stacked mobile web-app footer */}

<Footer                                 {/* trimmed for another surface */}
  contacts={[]}
  columns={corporateColumnsOnly}
  copyright="Copyright © 2026 Almosafer"
/>
```
**Do:** place once, at the very end of the page; let the page own its max-width (the Footer manages its own fluid gutter).
**Don't:** squash it inside a narrow container, or reach into the dark app-promo card with light-on-light content — that card is a fixed dark gradient by design.

---

## Empty State *(planned — not yet implemented)*

Shown when there is no content yet or an action is required (e.g. opt-in to notifications). Tone is always positive and forward-looking.

### Planned anatomy: Illustration · Title · Body · Primary action · Secondary action (optional)

### Planned content rules

- Title: short, positive headline; 3–7 words
- Body: 1–2 sentences; explain what will happen and what to do
- Primary CTA: verb-first ("Stay updated", "Start exploring")
- Secondary CTA: decline or defer ("Not now")
- If the action requires a permission, briefly explain why in the body — not in the button label
- Avoid alarming or negative language; never blame the user
