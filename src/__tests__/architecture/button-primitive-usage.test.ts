/**
 * BTN-3 — Button Primitive Usage Gate (Task #462)
 *
 * Every interactive button in src/admin/ and src/admin/pages/site/ MUST use the shared Button primitive
 * (src/ui/components/Button/Button.tsx).  Raw <button JSX elements are
 * banned except in the §8 allowlist below.
 *
 * ALLOWLIST contains the ONLY files permitted to contain bare <button — either
 * because they ARE the Button primitive or because they carry a legitimate §8
 * design-system exception documented in Contribution #667.
 *
 * §8 exceptions:
 *   §8.1 Settings nav buttons — full-width left-sidebar navigation (SettingsModal)
 *   §8.2 Full-width disclosure toggles — Section, DepsSection,
 *         PropertyControlRenderer
 *   §8.3 Pill micro-remove buttons — ClassPicker (< 20×20px fixed,
 *         Button's 26px min-height would distort pill layout)
 *   §8.4 Toggle switch hit areas — ToggleControl, PreferencesSection
 *         (role="switch", custom 44×44 WCAG 2.5.5 hit area not achievable via
 *         Button's fixed size tokens)
 *   §8.5 Canvas coordinate affordances — CommentPin (a marker positioned at an
 *         exact board coordinate: asymmetric map-pin radius whose corner is the
 *         tip, plus a zoom counter-scale transform on its own root element) and
 *         the prototype link handle (a circle at an exact board coordinate,
 *         sized in board units, that starts a raw pointer drag)
 *
 * @see Contribution #667 — Button Design System Phase 2 spec (parent: this task)
 * @see Task #462 — Button Design System Phase 2 (37-file migration)
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const ADMIN_ROOT = join(SRC_ROOT, 'admin')
// 'src/editor' never existed in this repo's tracked history (`git log --all
// -- src/editor` is empty) — it contributed zero files here. 'admin' already
// recursively covers the real site-editor surface (src/admin/pages/site/),
// so dropping the dead 'editor' entry changes no scanned file set.
const SCAN_ROOTS = [{ label: 'admin', root: ADMIN_ROOT }]

// ---------------------------------------------------------------------------
// TSX file walker
// ---------------------------------------------------------------------------

function collectTSXFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTSXFiles(full))
    } else if (extname(entry) === '.tsx') {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// §8 allowlist — files permitted to contain bare <button elements
// Paths are relative to src/ for readability.
// ---------------------------------------------------------------------------

/**
 * Each entry is a path relative to src/ that is permitted to contain
 * one or more bare <button elements.  ALL entries must have a §8 justification
 * comment here; new entries without justification will fail code review.
 */
const ALLOWLIST = new Set([
  // ── §8.1 Settings nav buttons ────────────────────────────────────────────
  // Full-width left-sidebar navigation links styled as nav items.
  // Using Button would break the nav-item layout (full-width, icon+text, active state).
  'admin/modals/Settings/SettingsModal.tsx',

  // ── §8.2 Full-width disclosure toggles ──────────────────────────────────
  // These are collapsible section headers that span the full panel width.
  // Button's inline-flex sizing and padding do not fit a full-width disclosure pattern.
  'admin/pages/site/panels/PropertiesPanel/Section.tsx',
  'admin/pages/site/panels/DependenciesPanel/DepsSection.tsx',
  'admin/pages/site/property-controls/PropertyControlRenderer.tsx',

  // ── §8.4 Toggle switch hit areas ────────────────────────────────────────
  // role="switch" toggle controls need a 44×44 WCAG 2.5.5 transparent hit area
  // wrapped around the visual pill.  This is a custom <button layout that does
  // not fit Button's token-driven size system.
  'admin/pages/site/property-controls/ToggleControl.tsx',
  'admin/modals/Settings/sections/PreferencesSection.tsx',

  // ── §8.5 Canvas coordinate affordances ──────────────────────────────────
  // A review comment pin is a marker at an exact BOARD COORDINATE, not a
  // control in a layout. Three things about it are load-bearing and none is
  // expressible through Button's token-driven sizing:
  //   * an asymmetric map-pin radius (13px 13px 13px 2px) whose bottom-left
  //     corner IS the tip that must land on the anchored point;
  //   * `transform: scale(calc(1 / var(--canvas-zoom))) translate(-50%, -100%)`
  //     with `transform-origin: 0 0` — the counter-scale that keeps the pin a
  //     constant on-screen size at any zoom, and the offset that puts its tip
  //     on the coordinate. Button owns its own root element and applies its
  //     variant/size classes there, so this geometry cannot be layered on
  //     without fighting rules whose CSS-Modules order is not guaranteed;
  //   * a canvas-affordance background (--canvas-comment-pin), which is not a
  //     Button variant and should not become one — it belongs to the same
  //     family as the selection and hover rings, not to editor chrome.
  // Keyboard reachability, focus-visible styling and the accessible name are
  // all still provided explicitly (see CommentPin.tsx).
  'admin/pages/site/canvas/BoardCommentsLayer/CommentPin.tsx',

  // §8.5 — the prototype `+` handle. Same family as CommentPin above, for the
  // same two reasons:
  //   * it is positioned at an exact BOARD coordinate and sized in board units
  //     (it scales with the canvas), which Button's token-driven sizing cannot
  //     express without fighting rules whose CSS-Modules order is not
  //     guaranteed;
  //   * its background is a canvas-affordance token (--canvas-prototype-link),
  //     which is not a Button variant and should not become one — it belongs
  //     with the selection and hover rings, not with editor chrome.
  // It is a drag SOURCE, not a click target: its entire behaviour is a raw
  // pointerdown that never resolves into a click. Accessible name and keyboard
  // reachability are still provided explicitly.
  'admin/pages/site/canvas/BoardPrototypeLayer/BoardPrototypeLayer.tsx',

  // ── §8.6 ARIA tablist tabs ──────────────────────────────────────────────
  // role="tab" buttons inside role="tablist" need a custom tab layout
  // (icon + label, aria-selected, no border, mode-specific active state).
  // Button's token-driven sizing would distort the segmented-toggle look.
  // The same pill also hosts the Run-scripts toggle + Refresh and the inline
  // breakpoint switcher, which share the 22px icon-tab geometry.
  'admin/pages/site/canvas/CanvasModeToggle.tsx',

  // ── §8.7 Full-width row disclosure / listbox option custom layouts ──────
  // ColorTokenCard row toggle is a full-width structured row (title + meta,
  // expand caret pattern) — same pattern as §8.2 disclosures but on a
  // multi-cell row layout that Button's inline-flex sizing cannot represent.
  // CategoryComboBox renders role="option" items inside a role="listbox"
  // dropdown — Button's inline-flex layout cannot represent the option grid.
  // TokenizedColorField renders role="option" items inside a role="listbox"
  // with a swatch + token name + variant meta — Button's inline-flex layout
  // cannot represent the option grid.
  // AddGoogleFontDialog renders role="option" tiles inside a 2-column grid
  // with stacked content (large family-rendered preview on top, category
  // label below) — Button's fixed-height inline-flex row layout cannot
  // represent the card-style grid the font picker needs.
  'admin/pages/site/panels/ColorsPanel/ColorTokenCard.tsx',
  'admin/pages/site/panels/ColorsPanel/CategoryComboBox.tsx',
  'admin/pages/site/property-controls/TokenizedColorField.tsx',
  'admin/pages/site/panels/TypographyPanel/FontsSection/AddGoogleFontDialog.tsx',

  // ── §8.11 Overview project-launcher cards ───────────────────────────────
  // DashboardPage (the studio Overview) renders each project as a card-style
  // tile in a responsive grid: a folder glyph on top, project name, then a
  // page-count meta line stacked below. The whole surface is the click target
  // that opens the project. Button's fixed-height inline-flex row layout
  // cannot represent this stacked card grid — same pattern class as §8.5's
  // full-surface tiles.
  'admin/pages/dashboard/DashboardPage.tsx',

  // ── §8.12 Boards section collapse toggle ────────────────────────────────
  // StudioBoardsList's disclosure toggle must render its label in the exact
  // same compact uppercase-tracking typography (`.heading`) as the sibling
  // Pages section header, with zero extra padding/min-height, so collapsing
  // it doesn't shift the panel's established compact header rhythm. Button's
  // token-driven size system (26px+ min-height, fixed padding scale) doesn't
  // fit this exact-typography disclosure — same pattern class as §8.2.
  'admin/pages/site/panels/ExplorerPanel/StudioBoardsList.tsx',

  // ── §8.11 BorderControl side / corner picker hit areas ──────────────────
  // The visual border editor's side picker renders four absolutely-positioned
  // thin edge bars (6px wide/tall) inside a 72×72 box, and the radius corner
  // picker renders four 14×14 corner dots. Each is a clickable hit area whose
  // geometry IS the affordance (which edge / corner you're editing). Button's
  // token-driven size system (micro = 18px, sm = 26px) cannot represent a 6px
  // edge bar or a corner-anchored dot — same pattern class as §8.6 (custom
  // ARIA role + bespoke structural layout). These are the only bare
  // <button>s in the file.
  'admin/pages/site/panels/PropertiesPanel/BorderControl/BorderControl.tsx',

  // ── §8.12 Super Import "Review" category navigator ──────────────────────
  // AnalyzeStep is the Review step's category navigator (Direction B). Its
  // bare <button>s are all custom structured layouts Button's inline-flex
  // size tokens cannot represent:
  // • nav items — full-width 4-cell rows (tint dot + label + count + green
  //   include-state dot), the §8.7 full-width-row pattern;
  // • the "Add more files" affordance — a dashed 2-column drop target (30px
  //   icon tile + stacked title/sub), a bespoke drag/drop surface;
  // • the per-stylesheet disclosure chevron — the §8.2 caret pattern;
  // • the "All" / "None" bulk text links — 11.5px inline text actions, not
  //   the token-driven Button sizes.
  'admin/modals/SiteImport/steps/AnalyzeStep.tsx',
  // CMS transfer bundles reuse the same Super Import review navigator geometry
  // as AnalyzeStep: full-width category rows, dashed choose-file affordance,
  // and inline All / None text actions. Button's inline-flex size tokens
  // cannot represent those structured row surfaces.
  'admin/modals/SiteImport/steps/CmsBundleAnalyzeStep.tsx',

  // ── §8.13 Export site dialog category navigator ─────────────────────────
  // ExportDialog is the sibling of §8.12 — the same category-navigator
  // pattern, on the export side. Its bare <button>s are:
  // • nav items — full-width 4-cell rows (tint dot + label + count + green
  //   include-state dot), identical to §8.12's nav-item / §8.7 pattern;
  // • the "Select all" / "Select none" bulk text links — 11.5px inline text
  //   actions, not the token-driven Button sizes (same as §8.12).
  'admin/shared/ExportDialog/ExportDialog.tsx',

  // ── §8.14 Framework state cards ──────────────────────────────────────────
  // FrameworkManagerDialog's state options ("Full framework" / "Variables
  // only" / "None") render as role="radio" cards inside a role="radiogroup" —
  // each is a stacked custom layout (icon + title + tick + description + bullet
  // list) that Button's inline-flex size tokens cannot represent. Same pattern
  // class as §8.7's role="option" card grids (custom ARIA role + multi-line card).
  'admin/shared/dialogs/FrameworkManagerDialog/FrameworkManagerDialog.tsx',

  // ── §8.15 Framework Home activation cards ────────────────────────────────
  // FrameworkHome's Colors/Typography/Space cards are stacked multi-line tiles
  // (icon + title + status + count + swatch grid) that switch the panel tab on
  // click — the same multi-line custom-layout card class as §8.7 / §8.14 that
  // Button's inline-flex size tokens cannot represent.
  'admin/pages/site/panels/FrameworkPanel/FrameworkHome.tsx',

  // ── §8.16 Iframe-rendered canvas chrome (WS-3.3 package-component placeholder) ──
  // PackageComponentPlaceholder is NodeRenderer's fallback for an
  // unregistered `pkg.*` node — same rendering position as `.unknownModule`
  // (NodeRenderer.tsx), which is portalled INTO the per-frame iframe's own
  // document (canvas-engineer's own rule: "the canvas DOM must be the DOM
  // React renders"). CSS Modules — including Button.module.css — exist only
  // in the PARENT editor document's stylesheets and never reach iframe
  // content (see EditorChromeInjector.tsx's own module doc); a mounted
  // `Button` here would render functionally but visually unstyled. The
  // "Promote this project" action is styled instead via a stable
  // `data-studio-package-placeholder-promote` selector in
  // EditorChromeInjector's injected chrome stylesheet — the same
  // stable-data-attribute pattern `.unknownModule`/`data-studio-unknown-module`
  // already established for this exact constraint.
  'admin/pages/site/canvas/PackageComponentPlaceholder.tsx',

  // ── §8.17 Trash section collapse toggle ─────────────────────────────────
  // StudioTrashList's disclosure toggle is the same pattern as §8.12 and sits
  // directly beneath it in the same panel: its label must render in the exact
  // compact uppercase-tracking typography (`.heading`) the Boards and Pages
  // section headers use, with zero extra padding/min-height, or the three
  // section headers of one panel stop lining up. Button's token-driven size
  // system (26px+ min-height, fixed padding scale) doesn't fit that
  // exact-typography disclosure. The row's real ACTIONS — Empty, Restore,
  // Delete — are all `Button`; only the header toggle is bare.
  'admin/pages/site/panels/ExplorerPanel/StudioTrashList.tsx',
])

// ---------------------------------------------------------------------------
// BTN-3 gate
// ---------------------------------------------------------------------------

describe('BTN-3 — Button primitive usage gate', () => {
  it('all <button elements in src/admin and src/admin/pages/site are either the Button primitive or an §8 exception', () => {
    const files = SCAN_ROOTS.flatMap(({ root }) => collectTSXFiles(root))
    const violations: string[] = []

    for (const file of files) {
      // Normalize to POSIX separators so the forward-slash ALLOWLIST matches
      // on Windows too (relative() yields backslash paths there).
      const rel = relative(SRC_ROOT, file).split('\\').join('/')

      // Skip allowlisted files
      if (ALLOWLIST.has(rel)) continue

      const source = readFileSync(file, 'utf-8')

      // Match bare <button followed by a space or > (i.e. not <Button which is the primitive).
      // The capital-B <Button is the primitive; lowercase <button is forbidden outside the allowlist.
      if (/<button[\s>/]/.test(source)) {
        violations.push(rel)
      }
    }

    if (violations.length > 0) {
      const list = violations.map((v) => `  - ${v}`).join('\n')
      console.error(`BTN-3 FAIL: bare <button found outside allowlist:\n${list}`)
    }

    expect(violations).toEqual([])
  })

  it('Button primitive owns the shared 44px touch-target size', () => {
    const source = readFileSync(join(SRC_ROOT, 'ui/components/Button/Button.tsx'), 'utf-8')
    const css = readFileSync(join(SRC_ROOT, 'ui/components/Button/Button.module.css'), 'utf-8')

    expect(source).toMatch(/["']lg["']/)
    expect(css).toMatch(/\.size-lg\s*\{[\s\S]*height:\s*44px/)
    expect(css).toMatch(/\.size-lg\.iconOnly\s*\{[\s\S]*width:\s*44px/)
  })
})
