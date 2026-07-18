# PENPOT PARITY CHECKLIST — drive the studio to near-1:1 with real Penpot

Human directive (2026-07-18, dogfood round 4/4b, WITH side-by-side screenshots):
"make a step where this is gonna be as faithful and as close and nearly 1:1 100%
the same as penpot in every aspect."

**Acceptance gate for EVERY parity workstream:** a real-browser SIDE-BY-SIDE
screenshot of our panel next to the referenced real Penpot panel (source at
`../penpot`), that a fresh adversarial auditor agrees "reads as near-identical to
Penpot" — density, grouping, iconography, widget shapes, labels, behavior. NOT
merely "the control exists." Cite the exact Penpot `.cljs`/`.scss` for each element.

**Honest limit (disclose, don't fake):** Penpot is ClojureScript + SVG shapes; we
are code-first React + real DOM. A few Inspect *values* differ by nature (we read
real computed DOM, not vector geometry). Match everything else — look, density,
widgets, tooling, curation — as close as the stack allows; where a true 1:1 isn't
possible, say so in the workstream report rather than fabricating parity.

Ground truth: real Penpot right-pane = `../penpot/frontend/src/app/main/ui/
workspace/sidebar/options.cljs` + `options/menus/*.cljs`+`*.scss`; Inspect =
`.../viewport/*`/`ui/viewer/inspect/*` + `attributes/*.cljs`. Icons (317) at
`../penpot/frontend/resources/images/icons/*.svg` (MPL-2.0 © KALEIDOS; attribute).

---

## PANEL 1 — DESIGN tab (right pane)  [status: partial — W4/W4b-1/W4b-2 done]
DONE: section stack + order (FIX-W4); per-node-type context-awareness + honest
current-values (W4b-1); real Penpot icons + icon-button align groups + swatch/hex
chips + real disclosure chevrons (W4b-2).

GAPS (round-4) → **FIX-W4b-3** (3 focused sub-workers, sequential):
- [ ] **W4b-3a — Size & Position + frame sizing.** Ref `options/menus/measures.cljs`
      +`.scss`, frame size-presets. Direct editable numeric **W / H / X / Y** (not
      Auto/Custom two-step dropdowns) writing arbitrary values (`w-[508px]` etc.);
      **rotation** + **corner radius** numeric + independent-corners toggle; a
      **Size presets** dropdown + **device-type icons** (phone/tablet) with real
      device dimensions. Absorbs the device-preset half of old FIX-W5.
- [ ] **W4b-3b — LAYOUT declutter.** Ref `options/menus/layout_container.cljs`+
      `.scss`. Rebuild as Penpot's COMPACT cluster: align-grid + direction arrows +
      wrap toggle in ~2 tight rows, then small icon numeric fields for gap/padding
      (per-side toggle). Kill the tall labelled-dropdown-per-property layout.
- [ ] **W4b-3c — Color control.** Ref `options/menus/fill.cljs`+`color_row.cljs`+
      `components/color_bullet`. A real color widget: swatch + editable **HEX**
      (CUSTOM colors → `bg-[#RRGGBB]`) + opacity %; a picker POPOVER with the token
      palette that is **SEARCHABLE** and shows color-**preview swatches**; "Show in
      exports"/remove affordances. Same widget reused for Fill/Stroke/Typography.

## PANEL 2 — INSPECT tab (right pane)  [status: BROKEN + not Penpot-clean]
GAPS (round-4b) → **FIX-W4b-4** (subsumes old FIX-W2):
- [ ] **BUG: NODE + FRAME code blocks stuck on "Loading…"** (read-source round-trip
      hangs though report-computed-style works). Diagnose + fix so code loads
      reliably; honest error state if a read genuinely fails (no infinite spinner).
- [ ] **Curate + clean like Penpot** (ref `ui/viewer/inspect/*` +
      `attributes/*.cljs`): Board/node name header; a "Layer info" row with a
      HEX/Styles toggle; friendly GROUPED label:value (Size & Position; Fill =
      swatch + #hex + % + copy; Layout = Display / Flex direction / Flex wrap /
      Align items / Align content / Justify content) — NOT a raw dump of every
      computed CSS property. Keep the CODE (JSX) + per-block Copy.

## PANEL 3+ — broader chrome (future parity rounds, after right pane)
- [ ] Left dock (Pages/Layers) row anatomy vs `sidebar/layers*`.
- [ ] Headers / toolbar / dashboard vs their Penpot counterparts.
- [ ] Assets & Tokens panels.
(Scope: right pane FIRST — the active complaint — then expand outward.)

---

## Execution order (SEQUENTIAL, limit-resilient small workers)
1. gate W4b-2 (icons, in-flight) → 2. W4b-3a → 3. W4b-3b → 4. W4b-3c → 5. W4b-4
(Inspect clean + fix Loading… bug). Each: worker → fresh adversarial audit whose
gate is the side-by-side visual match → orchestrator commit + tag. Then Panel 3+.

---
## PENPOT VISUAL SPEC (extracted 2026-07-18 — the reference the anatomy passes lacked)
Human: "still not 100% 1:1 like penpot at all, not even close." Root cause: W4b-1..3c
made controls FUNCTIONALLY correct + anatomy-faithful but styled with OUR tokens, not
Penpot's rendered look. Extracted from ../penpot ds/ + refactor/themes:
- **Theme (dark):** panel bg #18181a; muted label/secondary #8f9da3; accent teal
  #00d1b8; input/segmented bg = --color-background-tertiary (a lighter gray); values
  white. (color-defs.scss + themes/default-theme.scss)
- **Spacing scale:** --sp-xs 4 / --sp-s 8 / --sp-m 12 / --sp-l 16 / --sp-xl 20 px.
- **Controls:** 32px height, radius $br-8 = 8px. (ds/controls/*.scss, ds/_borders.scss)
- **Segmented icon groups** (align/direction/justify) = ONE rounded tertiary-bg
  container (border-radius 8, gap sp-xs), buttons INSIDE, active = teal — NOT separate
  bordered buttons (radio_buttons.scss).
- **Size rows** = 3-col grid [input][input][action]: W+H+lock one row, X+Y next,
  gap sp-xs, margin-bottom sp-s (measures.scss).
- **MISSING header row:** blend-mode dropdown + opacity + eye + lock on one row.
- Sections carry +/⋮/− add-remove affordances; FILL has "Show in exports" + a
  Selected-colors section; also BLUR/GUIDES/EXPORT.

### FIX-W4b-5 — Design-tab HOLISTIC visual match (in flight) → re-skin to the spec above:
Penpot theme vars scoped to inspector + shared primitives (segmented pill, paired
numeric grid row, section title-bar w/ affordance, header row), applied consistently.
Behavior from W4b-1..3c UNCHANGED. Gate: side-by-side vs the target above reads
genuinely Penpot. This is the pass that should finally close the human's "not 1:1" gap
for the Design tab.

---
## DOGFOOD ROUND 5 (human, 2026-07-19) — "design still not there, make it 1:1" + concrete asks
Human dogfooded W4b-5 and: "still not there yet, make it 1:1"; PLUS two concrete:
- **R5-1 (+/add model):** "fill and others have a + icon — not all the options are
  present with none like it's done now." Penpot FILL/STROKE/SHADOW sections have a
  header **+** to ADD the property (section is EMPTY until added), and a **−** to
  remove — NOT always-shown-with-a-none-value. → FIX-W4b-6: give Fill/Stroke/Shadow
  the Penpot header-+ affordance mapped to real CSS (Fill=background-color add/remove;
  Stroke=border add/remove [there's already a Border checkbox — reconcile]; Shadow=
  box-shadow shadow-* add/remove). Cite fill.cljs/shadow.cljs/stroke.cljs title-bars.
- **R5-2 (wire the stubs — human chose ALL THREE):** blend-mode → mix-blend-* classes;
  per-corner radius + aspect-lock (W/H proportion co-scale); visibility (eye) + lock →
  needs NEW per-node hidden/locked state (bigger — touches tree/canvas/bridge, careful
  scope). → FIX-W4b-7 (blend + per-corner + aspect-lock, Inspector-local) then
  FIX-W4b-8 (visibility+lock, needs editor state).
- **R5-3 (overall 1:1):** design still not fully there — keep closing visual deltas vs
  the human's Penpot screenshots each pass; the final holistic sweep must be strict.

Order: W4b-6 (+/add model) → W4b-7 (blend/per-corner/aspect-lock) → W4b-8 (visibility+
lock) → final strict side-by-side sweep. All gated on visual match to Penpot.
