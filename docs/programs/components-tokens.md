# Plan: component variants + styles/variables (Figma parity, repo is the document)
> **Purpose:** the design for component variants and styles/variables (bundles CT-1..CT-6, CV-1..CV-4, decisions CT-OD and CV-OD) · **Read when:** before starting or reviewing a bundle of this plan · **Trust:** live design, not built (2026-10-10; STATE.md says which bundles are in flight) · **Owner:** studio-architect; studio-scribe folds shipped bundles out · **Verified:** 2026-10-10 (design read against the code, nothing run)

Status: design, not yet on ROADMAP.md. Not in `docs/decisions.md`; the owner decisions below are new (CT-OD-n).
Constraints feature (other planner): see "Interactions" at the end.

## 0. What already exists (build on, do not rebuild)

Components:
- `server/handlers/studio/componentSpecExtract.ts` + `GET /admin/api/studio/components` : syntactic (never the checker) PropSpec per local component. Already classifies string-literal unions AND named union aliases (K3) as `enum`, `boolean`, `node` (ReactNode), `handler` (dropped), `collection`.
- `property-controls/componentPropKind.ts` : the ONE `PropKind -> PropertyControl` mapping (enum -> select, boolean -> toggle, node -> slot).
- `inspector/sections/ComponentSection.tsx` + `panels/PropertiesPanel/componentCallSiteRows.ts` : per-DECLARED-prop rows on a `studio.instance`, writes via `updateInstanceCallSiteProp` (setJsxProp). So "variant picker per prop at the call site" is ~70% done.
- `ast-codemods/componentPropSignature.ts` (add ONE optional prop to a signature, inline literal / same-file interface), `addSlotPropToComponent`, `exposeLiteralAsProp`, `swapComponentInstance`, `detachComponent`, `extractSubtreeToComponent`.
- Storybook CSF import (W5-3): args-only stories are synthesized into real call sites and run through `inlineLocalComponents`. That is the mechanism for rendering N variant combinations without writing anything.
- `core/component-manifest/extractManifest.ts` uses react-docgen-typescript + the TS compiler. It is the DESIGN-SYSTEM manifest path (alm:sync). Do NOT use it for local components (it needs a type-checker program; local path is syntactic ts-morph). Only the `defaultValue`/`description` fields are worth mirroring.
- ALM pack: `alm.*` components are black boxes (`design-system.md`): their enums already show as selects, but "Add variant" is impossible (not user source). Properties panel for an `alm.*` instance stays call-site only.

Tokens:
- `server/handlers/studio/projectTokenSources.ts` (the exact CSS stack the canvas loads, in cascade order, with provenance) -> `projectTokenIndex.ts` `listProjectTokens` (name, light value, DARK value, family, declaring file:line) -> `studio_list_tokens` / `studio_set_tokens` (`setTokensTool.ts`, refuses `no-such-token | read-only-source | ambiguous-declaration`).
- `core/css-codemods/customProperty.ts` : `listCustomPropertyDeclarations`, `setCustomPropertyValueAtLine` (CST, byte-preserving). Only SET exists: no insert, rename, remove.
- `tokenExtractCssScan.ts` / `tokenExtractJsTheme.ts` (theme.ts / tokens.json read, Tier 0) / `designImport/*` (npm/GitHub wizard, `applyDesignImportTokens`).
- Client: `property-controls/projectVariables.ts` (scans the concatenated `authoredCss`/`vendorCss` stores, no file attribution), `ui/components/VariableField/*` (`useVariableAffordance`, `varBinding.ts`: bound = value is exactly one `var(--x)`; chip + detach + picker, filtered by `variableKind`: color/length/number/other), `TokenizedColorField` (also reads FRAMEWORK colours via `site.settings.framework`).
- Framework panel / `@core/framework` : Studio's OWN generated scales (`--text-xs…`, colour shades). Its `:root` block is already folded into `projectVariables` as a "Framework" bucket. It is a GENERATOR, not the user's token layer (projectTokenIndex doc explicitly refuses to merge them).
- Modes: `.studio/meta.json previewAxes {direction,colorScheme,locale}`, `colorSchemeDetect.ts` (detects `[data-theme]`, `.dark`, `prefers-color-scheme`), `PreviewAxesControls`, per-frame axes in `selectCanvasPageFor`. Breakpoints = frame widths + P3-C at-rule contexts.

Gaps: no token INSERT/RENAME/REMOVE codemod; no collections; "mode" is hard-coded to light/dark; no usage query for a token; fields accept variables but there is no "create from selection"; text and effect styles do not exist; variants have no WRITE path beyond a call-site prop and no analyzer for how a prop is consumed inside the component.

## 1. Data model (all derived from disk; nothing new persisted except mode choices already in meta.json)

```ts
// @core/studio-tokens (new barrel; pure, browser-safe; add to no-core-barrel-deep-imports list)
type ModeGate =                       // WHERE a value is declared = which "mode" it belongs to
  | { kind: 'base' }                                  // :root / html / :host
  | { kind: 'attr';  attr: string; value: string }    // [data-theme="dark"], [data-density=compact], :lang(ar) -> attr 'lang'
  | { kind: 'class'; className: string }              // .dark
  | { kind: 'media'; query: string }                  // prefers-color-scheme: dark ; min-width ; prefers-contrast
type ModeAxis = { id: string; label: string; modes: { id: string; label: string; gate: ModeGate }[] }
  // axis ids: 'color-scheme' | 'locale' | 'density' | 'breakpoint' | custom; first mode of each = base
type TokenDecl = { name: `--${string}`; value: string; gate: ModeGate; file: string; line: number;
                   editable: boolean /* hand-authored .css, not package/compiled/framework */; aliasOf?: `--${string}` }
type Token = { name; kind: VariableKind | 'shadow' | 'font' ; collection: string; decls: TokenDecl[] /* one per mode */ }
type Collection = { id: string /* file-relative + prefix, e.g. 'src/tokens.css#color' */; label; tokens: Token[]; axisId: string }
type TextStyle  = { className: string; file: string; line: number; props: Record<string,string> } // a class rule made of font-*/line-height/letter-spacing
```
Rules:
- Collection = (declaring stylesheet) x (leading name segment: `--color-*`, `--space-*`, `--radius-*`…). No sidecar file. A project can override by a `/* @collection Brand */` comment (read only; optional, deferred).
- Mode axis is INFERRED from the gates found among a collection's declarations; `detectColorScheme` stays the authority for the colour-scheme axis. Locale axis = `:lang()`/`[lang]`/`[dir]` gates.
- Alias = declaration whose value is a lone `var(--y)` (reuse `varBinding.parseVarBinding`); resolve with the existing admin-side `resolveVariableValue`, depth-capped.
- "Style" mapping (Figma -> repo):
  * Color style and effect (shadow) style = a token (`--color-brand`, `--shadow-card`). Applying = writing `var(--x)` to the property (already how the inspector binds).
  * Text style = a CSS CLASS in a project stylesheet (`.text-h1 { font: …; letter-spacing: … }`, values referencing tokens when present). Applying = class assign (`setJsxClassName`, shipped). Detach = copy declarations inline (`setJsxStyle`/class rule) and remove the class. Reasoning: a composite lives badly in one custom property (`font` shorthand cannot carry token indirection per sub-field), and a class is what React/Tailwind/CSS-Modules authors already write. Tailwind: a text style is `@apply`/`@utility` in the user's CSS, or a `text-*` utility from `@theme`.
  * Grid/layout styles: out of scope.
- Tailwind: v4 `@theme { --color-brand: … }` is custom properties inside an at-rule block -> same Token model, gate `base`, `inTheme: true`; edit = existing `setCustomPropertyValueAtLine`; apply = the property's `var(--color-brand)` OR the utility class (`bg-brand`) depending on whether the element is a Tailwind element (class path already exists, Track B2). v3 `tailwind.config` / `theme.ts` = READ-ONLY listing (`tokenExtractJsTheme`), apply by utility class only; editing refuses with "edit in code" (parse-never-execute).
- Variants:
```ts
type VariantAxis =                     // one Figma variant property
  | { prop: string; kind: 'enum';    members: { name: string; origin: SourceRange /* the literal in the union */ }[]; unionHome: 'inline'|'same-file-alias'|'other-file' }
  | { prop: string; kind: 'boolean'; default: boolean }
type VariantBinding =                  // HOW the component turns that prop into styling/markup  (analyzer output, parse-only)
  | { kind: 'css-module-class'; expr: 'styles[prop]' | 'styles[`btn-${prop}`]'; rules: Record<member, { file; selector; range }> }
  | { kind: 'data-attr';        attr: string; rules: Record<member, { file; selector; range }> }      // data-variant={variant} + [data-variant=x]
  | { kind: 'lookup-object';    objectRange; entries: Record<member, SourceRange> }                  // const variantClass: Record<Variant,string> = {…}
  | { kind: 'cva';              callRange; entries: Record<member, SourceRange> }                    // cva/tv/clsx maps
  | { kind: 'boolean-class';    classRange }                                                         // cn(base, disabled && 'is-disabled')
  | { kind: 'opaque' }                                                                                // ternary chain, switch, computed: renders, cannot write
type ComponentPropertyKind = 'variant' | 'boolean' | 'text' | 'instance-swap' | 'slot'
  // enum->variant, boolean->boolean, string->text, node->slot/instance-swap (ReactNode), children->slot
```
`VariantBinding` is attached to `LocalComponentSpec` (extend `PropSpecSchema` with `default?`, `doc?`, and `binding?`) so ONE catalog fetch feeds the inspector. Extra field is additive on a wire type we own (no compat issue).

## 2. Parse and codemod list

Parse (all ts-morph syntactic / postcss, never executed, extend `componentSpecExtract.ts`, new `core/page-parser/componentVariantBindings.ts`):
- P1 default value per prop (destructuring default `variant = 'primary'`).
- P2 union member source ranges (inline literal, same-file alias; other-file alias reports `unionHome:'other-file'`, editable only if that file is also in the workspace).
- P3 binding analyzer: for each enum/boolean prop find consuming expressions in the component body: `styles[x]`, template literal, `data-*={x}`, `Record<Union,…>` lookup object indexed by the prop, `cva` config key, `x && 'cls'`. Anything else -> `opaque`.
- P4 css rule locator: for `css-module-class` / `data-attr`, map member -> rule via the existing CSS registry (`StyleRule` + source file/range; same machinery as `setDeclaration`).
- P5 token catalog with gates (extends `collectRootScopeDeclarations`; today it picks a "winner"; now return all gated declarations). Also text-style discovery = classes whose declarations are all typographic.
- P6 token usage scan: every `var(--x)` in project CSS + string literals/template literals/style props in tsx (ts-morph string scan, Tier 0) + Tailwind arbitrary `[var(--x)]`. Returns file:line list and counts. Not in the per-node selector path (server/one-shot; PROJECT-BRIEF trap 11).

Codemods (pure text-in/text-out, `ast-codemods/` or `css-codemods/`):
- C1 `addUnionMember(file, unionHome, name, cloneFrom?)` : append `| 'name'` to the literal union (inline/same-file alias); refuse `other-file` unless in workspace; refuse `keyof typeof`/mapped/imported-package types (`unsupported-union-type`).
- C2 `cloneVariantBinding(binding, from, to)` : css-module/data-attr -> clone the `from` rule under the new selector via `insertRule` + copied declarations (CST); lookup-object / cva -> insert entry copying the `from` entry text; boolean-class -> n/a; opaque -> REFUSE with reason (one honest target rule). Composite "Add variant" = C1 + C2 in ONE planned multi-file write (atomic via `commitPlannedWrites`, one undo step, existing multi-file inverse infra from P1-F/P3-F).
- C3 `renameUnionMember` (rare; defer) and `removeUnionMember` (refuse if any call site passes it; else delete type member + binding entry; list call sites in the refusal).
- C4 `addComponentProp(kind: 'variant'|'boolean'|'text'|'slot', name, defaultValue)` : generalise `componentPropSignature.OptionalProp` (it already supports `type` + binding with default) - needs only a new enum/boolean creator + `boolean-class` binding creation. Replaces nothing; `addSlotPropToComponent` becomes a caller.
- C5 `insertCustomProperty(css, gate, name, value, afterName?)` : finds/creates the gate's rule (`insertRule` for a missing `[data-theme=dark]` / `@media` block) and appends the declaration. Counterpart of `setCustomPropertyValueAtLine`.
- C6 `renameCustomProperty(oldName, newName)` : planned multi-file edit - the declarations (css), every `var(--old)` in css, and the string literals in tsx (P6). Refuse when a usage sits in a package/compiled source. Undo = one entry (multi-file inverse).
- C7 `removeCustomProperty(name, replaceWith: 'literal'|'refuse-if-used')`.
- C8 `setTokenAtGate` : thin wrapper over existing `setCustomPropertyValueAtLine`; the SAME server module is shared by the new route and `studio_set_tokens` (lift out of `setTokensTool.ts`; the tool becomes a caller - no second implementation).
- C9 `createTextStyleFromNode` : `insertRule` for `.text-name` with the node's typographic declarations (bound to `var()` when they already are), then class-assign it (setJsxClassName) and strip those declarations from the node (one batch).
- C10 `detachToken(value)` : client-only; resolved literal from the frame's computed style - already the VariableField chip behaviour; extend to more property families.

New route(s) (two edits each: `subRouters.ts` AND `routeCapabilities.ts`; gate test `studio-routes-capability-declared`): `GET studio/tokens` (catalog + modes + usage counts; `site.read`), `POST studio/tokens` (set/insert/rename/remove; `studio.write`). Variants: no route; "Add variant" is a normal typed `StudioEdit` kind `addVariant` through `/studio/save` so it gets the write lock, fingerprint check and undo for free (add to `studioEditSchemas.ts`; P1-A/P3-A touch the same files, serial).

## 3. Inspector / UX

Variants
1. Instance selected (ComponentSection, exists): keep one row per declared prop. Change the mapping: enum with <= 4 members -> segmented control; > 4 -> select; boolean -> toggle; string -> text; `node` -> existing SlotControl; add "Instance swap" for a prop typed `ReactNode` whose current value is a lone component element (reuse `swapComponentInstance` + catalog picker). A prop the parser resolved from an expression stays read-only with `explainPropConstraint`.
2. Main component selected (the component's own definition root; reached by double-click into an instance / "Go to main component" / the Assets "Components" card opening it as a board frame): ComponentSection gets a second mode "Component properties" = the list of VariantAxis/boolean/text/slot rows with: default value, "+" Add property (C4), per-enum "+" Add variant (C1+C2), kebab Remove. A "Variants" strip shows the members; clicking one renders that member in the frame (via CV-2 synthesized call site) so style edits target it.
3. "Add variant" from canvas: duplicate-variant gesture on the strip's selected member -> prompts a name -> writes C1+C2 -> the new member is selected and the frame shows it. When the binding is `opaque` the button is disabled with the one-line reason ("variant styling is computed in code at Button.tsx:41"), with "Open in code" - the same refusal-with-remedy pattern as detach.
4. Variants gallery: a frame set rendering the cartesian product of enum x boolean props (cap 24) as synthesized call sites - read-only (not written, like the Stories board). This is the Figma "variant set" overview.
5. Editing a style while a variant member is shown writes to that member's rule (css-module / data-attr) or the lookup entry. Needs a `variant` edit context next to breakpoint/condition contexts (`atRuleForContext` family). Phase last.

Styles / variables
1. Every style/colour/length field already has the hover hexagon (VariableField). Extend `variableKind` with `shadow`, `font-family`, `duration`; extend the field set: stroke colour, border/outline colour, text colour, gap/padding/margin (TokenAwareInput), radius, font-size/weight, line-height, box-shadow, opacity, transition. Picker lists project Tokens (not framework) first, Framework/Package second (existing buckets), search, collection headers, swatch resolved in the FRAME's current mode.
2. Binding chip (exists) + new footer actions in the picker: "Create variable from this value…" (C5; name defaulted from nearest token family via `projectTokenIndex.nearestColorToken` so an existing equal token is offered first: no duplicate), "Detach" (C10).
3. Variables panel (new left-rail panel, replaces the Colors panel's project part; Framework panel remains the generator): table collections x modes like Figma - rows = tokens, columns = mode values, cells editable (colour swatch popover / text), alias cells show the target chip, "+ Mode" (inserts a gate block copying the base values: C5 per token), per-token "Used in N places" (P6; click lists file:line and selects the first on-board node), rename (C6), delete (C7). Non-editable sources (package, compiled, framework) show a lock and "Override in <project file>" (inserts a base-gate declaration into the entry stylesheet; reuses `resolveCssInsertDestination`).
4. Edit a token and see every use update: the write goes to the declaration; the canvas already re-injects the authored CSS, so use sites repaint. Add an optimistic patch of the `authoredCss` store while scrubbing (no disk write until commit) so a colour drag in the Variables panel is live in every frame.
5. Modes on the board: PreviewAxesControls generalises from {colorScheme, locale} to the inferred ModeAxis list; per-frame mode chip in the frame header (Figma "set mode on frame"). Applying a mode = set the gate on the frame's `<html>` (attr / class) or emulate media in the iframe (existing colorScheme path, runtime bridge). Breakpoint axis is NOT a toggle: it is frame width.
6. Text styles: a "Text styles" section in the same panel (from P5 discovery); in the Typography section of the inspector a style picker (class chip, detach = inline). "Create style from selection" = C9.

## 4. Bundles (proposed IDs `CT-*` tokens, `CV-*` variants; each one PR into the program trunk; sizes S<1d, M 1-3d, L 3-5d)

| Id | Change | Files (main) | Tests | Size |
|---|---|---|---|---|
| CT-1 | Token catalog with gates + collections + usage (read only). `GET studio/tokens`; `projectVariables.ts` switches to it and loses its own css scan (delete); `@core/studio-tokens` leaf | `server/handlers/studio/projectTokenIndex.ts`, new `tokenCatalog.ts`, `routeCapabilities.ts`, `subRouters.ts`, `src/core/studio-tokens/*`, `property-controls/projectVariables.ts` (rewrite) | unit: gate classification fixtures (`:root`, `[data-theme]`, `.dark`, `@media`, `@theme`, alias chains); route-declared gate; barrel gate | M |
| CT-2 | Apply/detach/create everywhere: `variableKind` + fields; `insertCustomProperty` (C5); picker footer "Create variable" | `variableKind.ts`, `useVariableAffordance.tsx`, stroke/radius/shadow/typography controls, `css-codemods/customProperty.ts`, `studioCssWriteback.ts` | codemod round-trip (CRLF, existing gate block, missing gate block), unit for kind filtering, a control never offers a wrong-kind token | M |
| CT-3 | Variables panel + edit + live preview + usage + rename/remove (C6, C7, C8); `studio_set_tokens` calls the shared module | new `panels/VariablesPanel/*`, `server/handlers/studio/tokenWrite.ts`, `setTokensTool.ts` (thin), `PanelRail`, `LeftSidebar`, delete the project part of `ColorsPanel`/`ColorsSection` | multi-file rename incl. tsx strings + Tailwind arbitrary; refusal for package source; undo restores byte-exact (like P1-F gates); `error-toast-sites` count unchanged | L |
| CT-4 | Modes on the board: generalised axes, per-frame mode chip, "+ Mode" | `core/studio-board/types.ts` (`PreviewAxes` gains `modes: Record<axisId, modeId>`), `PreviewAxesControls.tsx`, `BreakpointFrame.tsx`/`IframeFrameSurface.tsx`, runtime bridge messages (rebuild `runtimeBridgeBundle` + its freshness gate) | frame applies attr/class/media gate; persists in meta.json; locale `lang`/`dir`; e2e budget slice (touches frames) | M |
| CT-5 | Text + effect styles (C9, class discovery, picker, create-from-selection, detach) | `inspector/sections/Typography*`, `setJsxClassName`, `insertRule`, new `textStyleDiscovery.ts` | create then apply then detach restores literal declarations; no duplicate class | M |
| CT-6 | Tailwind/JS theme: v4 `@theme` write confirmed through CT-3; v3/`theme.ts` read-only rows with "apply by utility class"; refusal copy | `tokenExtractJsTheme.ts`, Variables panel rows | v3 config listed + edit refuses with reason; v4 edit writes inside `@theme` | S |
| CV-1 | Variant model (read): P1-P4 analyzer, `PropSpec.default/binding`, boolean/segmented/text/instance-swap rows, "Component properties" mode on main-component selection | `componentSpecExtract.ts`, new `componentVariantBindings.ts`, `componentPropKind.ts`, `ComponentSection.tsx`, `componentCallSiteRows.ts` | analyzer fixtures: css-module, data-attr, lookup, cva, boolean-class, opaque; control-mapping table test | M |
| CV-2 | Variants gallery: synthesized call-site frames for the cartesian product (read-only), variant strip on the main component | reuse `storyPages`-style synthesis (`server/handlers/studio/story*`) + `inlineLocalComponents`; board "Variants" frame group (never written to boards.json - derived) | cap + member selection renders the right class; Playwright measurement (frame sizes) | M |
| CV-3 | **Done (2026-10-11, branch `feat/add-variant`).** Add variant / add property / remove (C1, C2, C3, C4) as `StudioEdit` kinds, spelled `add-variant`, `add-component-prop`, `remove-variant` (kebab, like every kind); UI on the main-component mode and the gallery header "+"; contract in `docs/features/studio-import.md` "Add variant, Remove variant, Add property (CV-3)". Planned files below are the plan, not the result: the codemods are `unionMember.ts`, `objectEntry.ts`, `variantMembers.ts`, `addComponentProp.ts`, `variantCallSites.ts`, `css-codemods/variantRule.ts`. | `studioEditSchemas.ts`, `studioWriteback.ts`, `ast-codemods/addUnionMember.ts`, `cloneVariantBinding.ts`, `componentPropSignature.ts`, `studioSourceWrites.ts` | byte-exact output per binding kind; `opaque` refuses with reason; two-file undo; call sites unchanged | L |
| CV-4 | Edit styles per variant (variant edit context) | `studioSourceWrites.ts`, `styleRuleWriteback.ts`, `atRuleForContext` family | style edit on member "ghost" lands in `.btn-ghost`, never `.btn`; unknown binding refuses | L |

Order: CT-1 -> CT-2 -> CV-1 (parallel, different layers) -> CT-3 -> CT-4 -> CV-2 -> CV-3 -> CT-5 -> CT-6 -> CV-4. File-collision notes: CT-4 and CV-4 touch `studioSourceWrites.ts`/`BreakpointFrame.tsx`, which P3-D/P5-D own: schedule after them (ROADMAP §5 serial files). CT-3 and CV-3 both add `StudioEdit` kinds: serial. Each leaves the tree building.

Architecture gates to touch: `no-core-barrel-deep-imports.test.ts` (add `@core/studio-tokens`), `studio-routes-capability-declared` (new rows, no gate change), `error-toast-sites` (must NOT go up: refusals are `warning` with a remedy), `react-compiler-bailouts` (new components compile), `button-primitive-usage`, `runtime bridge freshness` (CT-4).

## 5. Owner decisions (recommendation first)

- CT-OD-1 Source of truth for tokens: the project's own CSS custom properties (+ Tailwind v4 `@theme`); Studio's Framework scales stay a separate generator shown as a read-only "Framework" collection. Rec: yes (matches `projectTokenIndex` doc and the one-honest-target rule). Alternative (merge framework into project tokens) rejected: two systems naming the same value.
- CT-OD-2 Modes are INFERRED from existing gates (`[data-theme]`, `.dark`, `@media`); "+ Mode" writes a gate block. Rec: yes. Sub-question: which gate does "+ Mode" write when none exists? Rec: reuse the project's detected colour-scheme gate, otherwise `[data-theme="<name>"]`.
- CT-OD-3 Text style = CSS class (not a composite custom property). Rec: class. Effect style = a `--shadow-*` token.
- CT-OD-4 Renaming a token rewrites every `var()` use in project source in one undo step; refuses if a use is inside a package/compiled source. Rec: yes (it is N sites by definition, so show "Updated N uses · Undo" like OD-8).
- CT-OD-5 Editing a token that is read-only (package/vendor/framework/ALM): offer "Override in <entry stylesheet>" (adds a base-gate declaration, never edits the package). Rec: yes.
- CV-OD-1 Which patterns are "writable variants"? Rec: css-module class map, `data-*` attribute selector, lookup object, cva/tv, boolean class; everything else `opaque` = renders, refuses Add variant with the line number. Do not attempt ternary/switch rewriting.
- CV-OD-2 Where is "the main component" on the board? Rec: a derived frame group "Components" (like Stories: separate named board, never mixed into curated boards) opened from Assets, rendering each component with default/synthesized props. Needs scout verification that a component definition root can be selected with a writable id (today components are inlined/spliced at call sites; editing inside an instance is blocked by shared-component refusal OD-7).
- CV-OD-3 "Add variant" clones the currently shown member's styling (Figma duplicate behaviour). Rec: yes; an empty variant is a second button, not default.
- CV-OD-4 Removing/renaming a variant member or prop that call sites use: refuse and list the sites; never rewrite N call sites silently. Rec: refuse now; "apply to all N call sites" later with its own bundle.
- CV-OD-5 Design-system (`alm.*`) and package components: call-site properties only, no Add variant. Rec: yes (black boxes by decision BUILTIN §0).
- OD-X Time-box: ship tokens (CT-1..4) before variant writes (CV-3/4), since tokens are lower risk and give the dark-mode board win immediately. Rec: yes.

## 6. Risks

- Binding analyzer false positives would let Add variant write a rule nothing consumes -> only claim a binding when BOTH the expression and the rule resolve; otherwise `opaque`. Fixtures from the real corpus (shadcn, Primer, test4).
- A rename across files races external editors -> same write lock + fingerprint check as every save (P1-A).
- Mode emulation of `@media (prefers-color-scheme)` inside an iframe: reuse the shipped colourScheme path; do not add a second emulation.
- Token panel scale (hundreds of tokens): virtualise rows; scan runs server-side once per stylesheet mtime set (projectTokenIndex cache), never in a Zustand selector.
- Duplicate catalogs: `projectVariables.ts` and `TokenizedColorField`'s framework read must collapse into the CT-1 catalog in the same PR (no old-beside-new).

## 7. Interactions with constraints (other planner)

- A variant can change a component's root size; constraints on children resolve against the instance's current box, so a variant switch must re-evaluate the constraint layout in the frame (no stored geometry - constraints are CSS, so it re-flows by itself; verify there is no cached `nodeVisualRect`).
- Constraint writes inside a main component must go to the shown variant's rule (CV-4's variant context) or they leak into every variant.
- Breakpoint mode axis = P3-C at-rule contexts that constraints/responsive edits already use: share `atRuleForContext`; a "mode" and a "breakpoint override" must not be two parallel mechanisms.
- Tokens bound to spacing values used by auto-layout/constraints (gap, padding) stay `var()`: constraint codemods must not overwrite a bound value with a literal (trap 4).
