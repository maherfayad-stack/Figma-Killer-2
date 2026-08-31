/**
 * pageTemplates — the starter files written for each {@link PageKind}, in the
 * dialect the project itself is written in.
 *
 * **This is the single most copied code in any Studio project.** An agent asked
 * to build a screen reads an existing page first and continues whatever pattern
 * it finds, so a starter that used inline `style={{…}}`, a hardcoded `#666` and
 * fixed pixel padding taught exactly those three habits to every screen
 * generated afterwards — observed directly: a generated screen came back with
 * `width: 375px` hardcoded on its root and not one media query in 233 lines.
 *
 * ## Two kits, because a hand-rolled sheet is never as good as the real one
 *
 * A project with `@alm-design/design-system` installed gets `BottomSheet` and
 * `Dialog` themselves ({@link PageTemplateKit} `'alm'`). This is not a
 * convenience — it is the difference between a sheet that IS a sheet and a
 * drawing of one:
 *
 *   - The package's CSS reaches the canvas as raw `vendorCss`, never through
 *     Studio's happy-dom CSSOM, so its glass, grabber, radii and bottom
 *     anchoring render exactly as shipped and stay correct when the package
 *     updates. See the CSSOM trap below for why that matters so much.
 *   - The package draws everything EXCEPT the content slot. `Dialog` needs no
 *     stylesheet at all; the sheet gets a two-rule one, because
 *     `.bottom-sheet__content` ships unpadded by design — see
 *     {@link ALM_SHEET_CONTENT_CSS}.
 *   - `alm.BottomSheet`/`alm.Dialog` are registered canvas modules with real
 *     prop manifests, so `size`, `platform` and `title` are editable in the
 *     Properties panel — an enum dropdown, not a wall of CSS. They are hidden
 *     from the INSERT palette only (awkward to place by hand), which
 *     `register.tsx` is explicit is not a reason to refuse to render existing
 *     usage — and a scaffolded page IS existing usage.
 *
 * Every other project gets `'plain'`: dependency-free JSX + a CSS module. A
 * starter that imported a package the project does not have would be a broken
 * file the moment it landed.
 *
 * ## The CSSOM trap — read before touching any colour here
 *
 * Studio parses a project's own stylesheets through happy-dom's CSSOM, and it
 * **silently drops declarations it cannot parse — the declaration vanishes with
 * no error anywhere**. Measured against the real pipeline:
 *
 * | Written | Survives? |
 * |---|---|
 * | `Canvas`, `CanvasText` (CSS system colours) | **no — drops the whole rule** |
 * | `rgb(0 0 0 / 0.2)` (space + slash-alpha) | **no** |
 * | `color-mix(in srgb, …)` | **no** |
 * | `rgba(0, 0, 0, 0.2)`, `#fff`, `#0003`, `white` | yes |
 * | `var(--x)`, a `--x:` declaration, `@media (prefers-color-scheme: dark)` | yes |
 *
 * The first version of the overlay templates used `Canvas`/`CanvasText` and
 * slash-alpha `rgb()` for exactly the reason they look right on paper — they
 * follow light/dark with no project setup. Every one of those declarations was
 * dropped, so the sheets rendered with no panel background, no scrim and no
 * grabber. **The plain kit therefore uses `rgba()` plus a `var(--…)` custom
 * property with a `prefers-color-scheme` override** — the syntax the table
 * above proves round-trips — and gets real dark-mode support out of it.
 *
 * ## Why the overlays are drawn, not animated
 *
 * A popup or a sheet in a running app is a presentation: it slides, it dims, it
 * can be dismissed. A Studio frame is a still of ONE state, and every canonical
 * rule points the same way — literal text, one `return`, no state, no branch.
 * So each overlay template draws the presented state directly. The motion
 * belongs to the app that presents it, not to the design of what is presented.
 *
 * ## Where the plain kit's numbers come from
 *
 * The design system's own iOS geometry — 34px popover radius, a 36×5 grabber,
 * a 44px toolbar, `200px`–`50vh` for a small sheet, a 54px top inset for a
 * full-screen one, a 300px dialog — so a project without the package still
 * gets a sheet the same size as one with it.
 *
 * ## The 16px spacing floor
 *
 * **No margin, padding or gap here is smaller than 16px (`1rem`), and zero
 * stays zero.** Gated by `pageTemplates.test.ts`, over both kits. Sizes are not
 * spacing and are exempt: the 36×5 grabber, the 44px toolbar and the 300px
 * dialog are quoted geometry, not a scale anyone is meant to continue.
 *
 * The floor covers what these templates AUTHOR. It is not applied to the
 * package's own internals — the alm `Dialog` puts an 8px `--space-sm` gap
 * between its two buttons, and a scaffold reaching in to override that would
 * be a starter fighting the design system it is supposed to demonstrate.
 *
 * This is a floor on what gets COPIED, not a claim that 6px is wrong. The
 * design system floats its small sheet on a 6px inset and that is right for a
 * shipped sheet; but this file is the pattern every later screen is written
 * from (see the top of this doc), and a starter carrying 5px, 8px and 10px
 * teaches a scale with no floor at all. One value, above the noise, is the
 * thing worth continuing.
 */
import { pageKindPreset, type PageKind } from '@core/studio-board'
import { ALM_DESIGN_PACKAGE_SPECIFIER } from './designSystemDetect'
import { hasDependency, readPackageJson } from './packageJsonRead'

/**
 * The `.tsx`/`.jsx` source and its co-located CSS module.
 *
 * `styles` is optional because a template can genuinely have nothing to say:
 * the alm `Dialog` takes its whole shape — copy, buttons, spacing — through
 * props, so an empty module beside it would teach the opposite habit to the
 * next thing that reads the project. The alm sheet DOES ship one, for the one
 * thing the package hands to the consumer: see {@link ALM_SHEET_CONTENT_CSS}.
 */
export interface StarterPageFiles {
  readonly component: string
  readonly styles?: string
  readonly stylesFileName?: string
}

/** Which vocabulary a project's pages are written in. See the module doc. */
export type PageTemplateKit = 'alm' | 'plain'

/**
 * The kit `dir` should be scaffolded in. Matches the project's own convention,
 * the same posture `detectPageFileExtension` takes for `.tsx` vs `.jsx`:
 * Studio continues what it finds rather than imposing a house style.
 *
 * `appRoot` is where the `package.json` lives (a nested app has its own), which
 * the caller resolves — this module does no path discovery of its own.
 */
export function detectPageTemplateKit(appRoot: string): PageTemplateKit {
  const pkg = readPackageJson(appRoot)
  if (!pkg) return 'plain'
  return hasDependency(pkg, ALM_DESIGN_PACKAGE_SPECIFIER) ? 'alm' : 'plain'
}

/**
 * Starter files for a freshly-scaffolded page. `componentName` is both the
 * default-export function name and the page's own title text, so a scaffolded
 * page names itself on the board without a second naming step.
 */
export function starterPage(componentName: string, kind: PageKind, kit: PageTemplateKit): StarterPageFiles {
  const template = kit === 'alm' ? ALM_TEMPLATES[kind] : PLAIN_TEMPLATES[kind]
  if (!template.css) return { component: template.jsx(componentName) }
  const stylesFileName = `${componentName}.module.css`
  return {
    component: withStylesImport(template.jsx(componentName), `import styles from './${stylesFileName}'`),
    styles: template.css,
    stylesFileName,
  }
}

/**
 * Adds the stylesheet import at the END of the file's import block — packages
 * first, local files after, the order a hand-written React file uses.
 *
 * Prepending it blindly was fine only while no template had an import of its
 * own. The alm sheet does, and the result was the local import sitting above
 * the package import with a blank line wedged between them — the first thing
 * anyone reading a scaffolded page would copy.
 */
function withStylesImport(source: string, statement: string): string {
  const lines = source.split('\n')
  let afterImports = 0
  while (afterImports < lines.length && lines[afterImports]!.startsWith('import ')) afterImports += 1
  if (afterImports === 0) return `${statement}\n\n${source}`
  lines.splice(afterImports, 0, statement)
  return lines.join('\n')
}

interface Template {
  /** The complete component source, minus the stylesheet import when `css` is set. */
  jsx: (componentName: string) => string
  /** The co-located CSS module, when this template needs one at all. */
  css?: string
}

/** Wraps a JSX body in the default export every page file is. */
function component(componentName: string, body: string): string {
  return `export default function ${componentName}() {\n  return (\n${body}\n  )\n}\n`
}

// ---------------------------------------------------------------------------
// The `alm` kit — the design system's own components
// ---------------------------------------------------------------------------

/**
 * `open` is the bare JSX shorthand on purpose: it parses to the literal `true`,
 * which keeps it a plain editable prop. `.bottom-sheet` is `opacity: 0` until
 * `.bottom-sheet--open`, so a sheet scaffolded without it renders invisible.
 *
 * `onClose` is what draws the leading glass ✕ — the package's own docs are
 * explicit that it "renders the leading close button when provided", and with
 * no handler the toolbar's leading slot renders empty. A no-op is the honest
 * value here: a Studio frame is a still, there is nothing to close. It is the
 * one code-valued prop in this template, and it buys an affordance the design
 * genuinely has.
 */
function almSheet(size: 'small' | 'fullscreen', blurb: string): Template {
  return {
    jsx: (componentName) =>
      `import { BottomSheet } from '${ALM_DESIGN_PACKAGE_SPECIFIER}'\n\n` +
      component(
        componentName,
        `    <BottomSheet open platform="ios" size="${size}" title="${componentName}" onClose={() => {}}>\n` +
          `      <div className={styles.content}>\n` +
          `        <p className={styles.blurb}>${blurb}</p>\n` +
          `      </div>\n` +
          `    </BottomSheet>`,
      ),
    css: ALM_SHEET_CONTENT_CSS,
  }
}

/**
 * The one thing the package does NOT draw for a sheet.
 *
 * `.bottom-sheet__content` is `flex: 1; min-height: 0; overflow-y: auto` and
 * **no padding at all** — deliberately: the package's own reference is
 * `<BottomSheet …>{/* sheet content *\/}</BottomSheet>`, so the content slot
 * belongs to the consumer and padding it is the consumer's job. A bare `<p>`
 * dropped straight in therefore sits flush against the panel edge, which is
 * exactly how the first version of this template rendered.
 *
 * `var(--space)` rather than a literal `16px`: it is the design system's own
 * base step, defined on `:root` in the package's stylesheet, so the sheet stays
 * in step with the package instead of pinning a copy of today's value.
 */
const ALM_SHEET_CONTENT_CSS = `/* The package leaves \`.bottom-sheet__content\` unpadded on purpose — its own
   docs hand the content slot to the consumer — so the inset is this file's job.
   \`--space\` is the design system's own 16px base step, defined on \`:root\` by
   the package, so this follows the package rather than pinning its value. */
.content {
  padding: var(--space);
}

/* The browser's default \`1em\` block margin would stack on top of the padding
   above and make the first line sit 32px down. */
.blurb {
  margin: 0;
}
`

/**
 * `Dialog` needs no `open` — it renders whenever it is mounted.
 *
 * `primaryAction`/`secondaryAction` take `{ label, onClick }` objects, so those
 * two props are code-valued and NOT editable in the Properties panel (the
 * label is still editable in the code editor). That is a real cost, accepted
 * deliberately: a popup with no buttons is not a popup, and `title` +
 * `description` — the copy that actually gets rewritten — stay literal.
 */
const almPopup: Template = {
  jsx: (componentName) =>
    `import { Dialog } from '${ALM_DESIGN_PACKAGE_SPECIFIER}'\n\n` +
    component(
      componentName,
      `    <Dialog\n` +
        `      platform="ios"\n` +
        `      title="${componentName}"\n` +
        `      description="One question, asked once. Replace this with the decision this popup exists to ask for."\n` +
        `      primaryAction={{ label: 'Confirm' }}\n` +
        `      secondaryAction={{ label: 'Not now' }}\n` +
        `    />`,
    ),
}

// ---------------------------------------------------------------------------
// The `plain` kit — dependency-free JSX + a CSS module
// ---------------------------------------------------------------------------

/**
 * Fluid by default, and deliberately NOT token-based: a brand-new project has
 * no token scale yet, and referencing `var(--…)` names that don't exist would
 * teach a habit that renders wrong. `clamp()` needs no project setup.
 */
const plainScreen: Template = {
  jsx: (componentName) =>
    component(
      componentName,
      `    <main className={styles.page}>\n` +
        `      <h1 className={styles.title}>${componentName}</h1>\n` +
        `      <p className={styles.subtitle}>Start editing this page in Studio.</p>\n` +
        `    </main>`,
    ),
  css: `/* Fluid by default: fills the frame it is placed in and caps for
   readability on wide viewports. Never a fixed width — a screen pinned to one
   device size stops being a design and becomes a screenshot. */
.page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  width: 100%;
  max-width: 60rem;
  margin-inline: auto;
  padding: clamp(1.5rem, 5vw, 4rem);
}

.title {
  margin: 0;
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 700;
}

/* currentColor rather than a literal: inherits whatever the project already
   uses, so the starter never introduces an off-palette hex. */
.subtitle {
  margin: 0;
  color: currentColor;
  opacity: 0.65;
}
`,
}

/**
 * The overlay root.
 *
 * `position: absolute; inset: 0` rather than a `min-height` — an overlay root
 * anchored to its positioned ancestor is the shape Studio's canvas is built
 * around (`iframeBodyReset.ts` pins `body` to `position: relative` and a
 * definite device height for exactly this), and it is what the design system's
 * own `.bottom-sheet` does. A height derived from the viewport instead feeds
 * into the frame's own grow-to-content measurement, which is the loop
 * `resolveViewportUnits.ts` exists to break.
 */
const OVERLAY_ROOT_CSS = `/* Anchored to the frame, not sized from it: \`inset: 0\` resolves against the
   positioned ancestor Studio's canvas gives every document, which is also what
   the design system's own sheet does. A viewport-derived height would feed the
   frame's grow-to-content measurement and fight it. */
.page {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  display: flex;`

/**
 * Colour, in the only syntax that survives Studio's CSSOM — see the module
 * doc's table. The custom property plus a `prefers-color-scheme` override is
 * what buys back the light/dark adaptation the (dropped) system colours were
 * reached for in the first place.
 */
const OVERLAY_TOKENS_CSS = `/* Studio parses a project's CSS through a CSSOM that silently DROPS
   \`Canvas\`/\`CanvasText\`, \`color-mix()\` and slash-alpha \`rgb(0 0 0 / .2)\`.
   A custom property with a \`prefers-color-scheme\` override survives, and
   gives the panel real dark-mode support rather than a fixed white. */
.page {
  --panel-surface: #ffffff;
  --panel-text: #1c1c1e;
  --panel-grabber: rgba(120, 120, 128, 0.4);
  --panel-muted: rgba(120, 120, 128, 0.16);
}

@media (prefers-color-scheme: dark) {
  .page {
    --panel-surface: #1c1c1e;
    --panel-text: #ffffff;
  }
}

/* The scrim is how much of the presenting screen the overlay leaves showing —
   a low-alpha black wash in light and dark alike, so it has nothing to adapt. */
.scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.2);
}`

const plainPopup: Template = {
  jsx: (componentName) =>
    component(
      componentName,
      `    <main className={styles.page}>\n` +
        `      <div className={styles.scrim} />\n` +
        `      <section className={styles.dialog}>\n` +
        `        <div className={styles.copy}>\n` +
        `          <h1 className={styles.title}>${componentName}</h1>\n` +
        `          <p className={styles.body}>One question, asked once. Replace this with the decision this popup exists to ask for.</p>\n` +
        `        </div>\n` +
        `        <div className={styles.actions}>\n` +
        `          <button type="button" className={styles.confirm}>Confirm</button>\n` +
        `          <button type="button" className={styles.dismiss}>Not now</button>\n` +
        `        </div>\n` +
        `      </section>\n` +
        `    </main>`,
    ),
  css: `${OVERLAY_ROOT_CSS}
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

${OVERLAY_TOKENS_CSS}

.dialog {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  /* The one fixed number here, because iOS is explicit about it: a dialog is
     300px wide and does not grow with the screen. */
  max-width: 300px;
  padding: 1rem;
  border-radius: 34px;
  background: var(--panel-surface);
  color: var(--panel-text);
  box-shadow: 0 15px 75px rgba(0, 0, 0, 0.18);
}

/* No padding of its own: the dialog's own 1rem is already the floor, and a
   second inset stacked inside it would take a 300px-wide alert down to a
   column of text too narrow to read. */
.copy {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.title {
  margin: 0;
  font-size: 1.0625rem;
  line-height: 1.375rem;
  font-weight: 600;
  text-align: center;
}

.body {
  margin: 0;
  font-size: 1.0625rem;
  line-height: 1.375rem;
  text-align: center;
}

/* Stacked, not side by side: two full-width actions read as a choice, and the
   pair stays legible when the copy on either is longer than one word. */
.actions {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm,
.dismiss {
  box-sizing: border-box;
  width: 100%;
  height: 3rem;
  border: none;
  border-radius: 999px;
  font: inherit;
  font-size: 1.0625rem;
  font-weight: 500;
  cursor: pointer;
}

.confirm {
  background: var(--panel-text);
  color: var(--panel-surface);
}

.dismiss {
  background: var(--panel-muted);
  color: var(--panel-text);
}
`,
}

/**
 * Both bottom sheets are one drawing, so they are one template rather than two
 * files that drift apart. What differs is how much of the presenting screen the
 * panel leaves showing, which is the whole distinction:
 *
 *   - `small` floats: a capped card inset from the bottom edge, all four
 *     corners rounded, `200px`–`50vh` (the design system's own small bounds).
 *   - `fullscreen` is a screen you are inside: it starts below a 54px strip of
 *     the presenting screen — the package's own `--bottom-sheet-top-inset` —
 *     runs to the bottom edge, and rounds its top corners only.
 */
function plainSheet(variant: 'small' | 'fullscreen', blurb: string): Template {
  const panel =
    variant === 'small'
      ? `  min-height: 200px;
  max-height: 50vh;
  /* Inset from the bottom edge rather than flush to it: a small iOS sheet
     floats on the screen, so all four corners are rounded. The design system
     floats it on 6px; the 16px spacing floor wins here (see the module doc). */
  margin: 0 1rem 1rem;
  border-radius: 34px;`
      : `  /* The strip of presenting screen left showing above a full-screen
     sheet — the design system's own \`--bottom-sheet-top-inset\` for iOS. */
  margin-top: 54px;
  flex: 1;
  min-height: 0;
  /* Flush to the bottom and both sides, so only the top corners round. */
  border-radius: 34px 34px 0 0;`
  return {
    jsx: (componentName) =>
      component(
        componentName,
        `    <main className={styles.page}>\n` +
          `      <div className={styles.scrim} />\n` +
          `      <section className={styles.sheet}>\n` +
          `        <div className={styles.grabber} />\n` +
          `        <header className={styles.header}>\n` +
          `          <button type="button" className={styles.close} aria-label="Close">×</button>\n` +
          `          <h1 className={styles.title}>${componentName}</h1>\n` +
          `        </header>\n` +
          `        <div className={styles.content}>\n` +
          `          <p className={styles.blurb}>${blurb}</p>\n` +
          `        </div>\n` +
          `      </section>\n` +
          `    </main>`,
      ),
    css: `${OVERLAY_ROOT_CSS}
  flex-direction: column;
  /* The panel sits on the bottom edge; everything above it is scrim, and how
     much of it there is IS the difference between the two sheet sizes. */
  justify-content: flex-end;
}

${OVERLAY_TOKENS_CSS}

.sheet {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
${panel}
  background: var(--panel-surface);
  color: var(--panel-text);
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}

.grabber {
  flex-shrink: 0;
  width: 36px;
  height: 5px;
  margin: 1rem auto 0;
  border-radius: 999px;
  background: var(--panel-grabber);
}

.header {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: 2.75rem;
  padding-inline: 1rem;
}

/* Leading, like every iOS sheet: the way out is where the thumb already is. */
.close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--panel-muted);
  color: var(--panel-text);
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

/* Absolutely centred rather than flex-centred, so the title stays optically
   centred whatever the close button's width — the same trick the design
   system's own sheet toolbar uses. */
.title {
  position: absolute;
  inset-inline: 3.75rem;
  margin: 0;
  font-size: 1.0625rem;
  line-height: 1.375rem;
  font-weight: 600;
  text-align: center;
}

/* The panel is capped, so its body is the part that scrolls — never the page
   behind it, which is not going anywhere while the sheet is up. */
.content {
  flex: 1;
  min-height: 0;
  padding: 0 1rem 1.5rem;
  overflow-y: auto;
}

.blurb {
  margin: 0;
  color: currentColor;
  opacity: 0.65;
}
`,
  }
}

const SMALL_SHEET_BLURB = 'One question, or one thing to confirm. Replace this with what the sheet is for.'
const LARGE_SHEET_BLURB = 'A whole step of a journey, without leaving the screen behind it. Replace this with its content.'

const ALM_TEMPLATES: Record<PageKind, Template> = {
  // A screen has no design-system shell to sit in — it IS the shell — so both
  // kits scaffold the same fluid starter for it.
  screen: plainScreen,
  popup: almPopup,
  'sheet-small': almSheet('small', SMALL_SHEET_BLURB),
  // "Big" is the package's own `fullscreen`: the panel starts below a 54px
  // strip of the presenting screen and runs to the bottom edge, top corners
  // only. `medium` was the first reading and it is a different object — a tall
  // floating card, not a screen you are inside.
  'sheet-large': almSheet('fullscreen', LARGE_SHEET_BLURB),
}

const PLAIN_TEMPLATES: Record<PageKind, Template> = {
  screen: plainScreen,
  popup: plainPopup,
  'sheet-small': plainSheet('small', SMALL_SHEET_BLURB),
  'sheet-large': plainSheet('fullscreen', LARGE_SHEET_BLURB),
}

/** The base an auto-named page of this kind counts from — `Sheet`, `Sheet2`, … rather than `Page7`. */
export function pageNameBase(kind: PageKind): string {
  return pageKindPreset(kind).nameBase
}
