/**
 * `manifest.generated.json`'s prop specs → the module surface the editor needs:
 * the Properties-panel control schema, the runtime props schema, and what an
 * inserted component starts out holding.
 *
 * Split out of `register.tsx` for its own reason: `register.tsx` is about
 * REGISTERING components (which ones, wrapped in what, rendered how), and this
 * is about reading one manifest spec. It is also where all four of the
 * "inserted component arrived as a blank box" fixes live, and those are worth
 * being able to read without the rendering machinery around them.
 */
import { Type } from '@core/utils/typeboxHelpers'
import {
  controlForPropKind,
  isCanvasDrivenProp,
  type PropKind,
} from '@site/property-controls/componentPropKind'
import type { ModuleDefinition } from '@core/module-engine'
import type { PropSpec } from '@core/component-manifest'
import type { DesignSystemComponentSpec } from '@core/design-system-manifest'
import { CURATED_DEFAULTS } from './curatedDefaults'

/**
 * Maps this package's documented prop kinds onto Studio's ONE
 * `PropKind -> PropertyControl` mapping — the same one every `pkg.*` component
 * and every local `studio.instance` call site goes through.
 *
 * This file used to carry its own two-case version (enum -> select, everything
 * else -> text), which is why a boolean rendered as a text box you had to type
 * the word `false` into, a number rendered as a text box, and an `onClick`
 * rendered as an editable field at all. The manifest now carries a real
 * `kind` per prop (`buildDesignSystemManifest`, derived from the package's own
 * documented value forms), so there is no reason for a second mapping to
 * exist — CLAUDE.md's "no old-and-new side by side" applies to a mapping
 * function as much as to a feature. `handler` is passed straight through for
 * the same reason: `controlForPropKind` is what decides a handler gets no
 * control, not a private filter here.
 */
function propKindFor(p: PropSpec): PropKind {
  if (p.enumValues && p.enumValues.length >= 2) return { kind: 'enum', values: p.enumValues }
  switch (p.kind) {
    case 'handler':
      return { kind: 'handler' }
    case 'collection':
      return { kind: 'collection' }
    case 'number':
      // A number the docs call an index into a sibling list gets that list's
      // own entries to choose from instead of a bare number box — see
      // `PropSpec.indexesCollection`.
      return p.indexesCollection === undefined
        ? { kind: 'number' }
        : { kind: 'collectionIndex', collection: p.indexesCollection }
    case 'boolean':
      return { kind: 'boolean' }
    case 'icon':
    case 'node':
      return { kind: 'node' }
    // A URL the user should be able to upload or pick, not type by hand.
    case 'image':
      return { kind: 'image' }
    case 'string':
      return { kind: 'string' }
    default:
      return { kind: 'unknown' }
  }
}

/**
 * Carries `PropSpec.appliesWhen` (`buildDesignSystemManifest.ts`) onto the
 * control the Properties panel actually renders — the fix for the reported
 * bug: a `variant="primary"` `Button` showed a full image picker for
 * `cardArt`, a prop the package's own docs say is `apple-pay` /
 * `gpay-card` / `gpay-personalized` only. `renderModuleTabContent.tsx` is
 * what actually hides the row; this is just the one place a manifest prop's
 * gate becomes a schema control's gate.
 */
export function buildSchema(props: PropSpec[]): ModuleDefinition['schema'] {
  const schema: Record<string, unknown> = {}
  for (const p of props) {
    if (isCanvasDrivenProp(p.name)) continue
    const control = controlForPropKind(p.name, propKindFor(p))
    if (!control) continue
    schema[p.name] = p.appliesWhen ? { ...control, appliesWhen: p.appliesWhen } : control
  }
  return schema as ModuleDefinition['schema']
}

/**
 * Every prop is `Unknown`, because it genuinely is: the generator records
 * `tsType: 'unknown'` for all of them, so there is no real type here to declare.
 *
 * `Type.String()` was the old shape and it actively lied. `validateNodeProps`
 * runs `Value.Parse` against this schema, so an `actions={[{ label }]}` array —
 * exactly what a real `<ActionSheet>` needs — failed Check, threw, and fell back
 * to the module's defaults. Declaring the truth passes the value through
 * untouched, which is what a React component wants: a boolean `open` stays a
 * boolean instead of being converted to the string `"true"`.
 */
export function buildPropsSchema(props: PropSpec[]) {
  const shape: Record<string, ReturnType<typeof Type.Optional>> = {}
  // Handler props stay in the SCHEMA (a parsed call site legitimately carries
  // `onClick={fn}`, and `validateNodeProps` must let it through untouched) —
  // they are only absent from `schema`, the panel's control list.
  for (const p of props) {
    if (isCanvasDrivenProp(p.name)) continue
    shape[p.name] = Type.Optional(Type.Unknown())
  }
  return Type.Object(shape)
}

/**
 * What an inserted component starts out holding.
 *
 * **A component inserted with no content is not a component, it is a blank
 * box.** This used to seed three things — `label` (from the component's own
 * name), a collection's documented example, and an enum's first option — and
 * every content-bearing prop outside those three got nothing. So inserting a
 * `SystemBanner` drew a bare tinted row, a `Snackbar` drew an empty capsule, a
 * `LinearProgressIndicator` drew a grey track at 0%, a `ProgressStepper` drew
 * nothing at all, and an `Accordion` drew an untitled header. The author was
 * handed an empty shell and no clue which of eleven props would make it
 * visible. That is the same defect `TabBar.items` was fixed for, and this is
 * the same fix generalised: `PropSpec.example` now carries the package's own
 * documented value for EVERY prop whose docs show one, so a component arrives
 * looking like the thing its own documentation says it is.
 *
 * Everything seeded here is a real, editable prop written into the user's
 * source on insert — placeholder copy to replace, not a canvas-only illusion.
 * Three kinds never reach a manifest `example` at all (`documentedExample`): an
 * asset path (it names a file their project does not have), a React node or
 * icon (no JSON form, and inventing a glyph would put design in their source
 * their docs never asked for), and a handler (never a value). Two more are
 * recorded in the manifest — which is a record of what the docs SAY — and
 * declined here, which is the separate question of what an insert should WRITE:
 * see `isSeedableDefault`.
 *
 * The documented example beats the component's own name for `label` — `Callout`
 * documents `label="Cheapest for your dates"`, which shows what the component
 * is FOR; the bare word "Callout" only repeats what the layer tree already
 * says. The name stays as the fallback for a `label` the docs leave unshown.
 */
export function buildDefaults(spec: DesignSystemComponentSpec): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const p of spec.props) {
    // `dir` is the canvas's, not the node's — see `CANVAS_DRIVEN_PROPS`.
    if (isCanvasDrivenProp(p.name)) continue
    if (p.example !== undefined && isSeedableDefault(p)) defaults[p.name] = p.example
    else if (p.name === 'label') defaults[p.name] = spec.name
    else if (p.enumValues?.length) defaults[p.name] = p.enumValues[0]
  }
  // A curated value beats the docs' own — that is the whole point of an entry
  // existing. See `CURATED_DEFAULTS`. Merged BEFORE the applicability pass so
  // a curated `variant` decides which gated props the insert writes.
  const seeded: Record<string, unknown> = { ...defaults, ...CURATED_DEFAULTS[spec.name] }
  for (const p of spec.props) {
    if (p.appliesWhen && p.name in seeded && !propAppliesTo(p.appliesWhen, seeded)) delete seeded[p.name]
  }
  return seeded
}

/**
 * Whether a gated prop means anything on the instance these defaults describe.
 *
 * `PropSpec.appliesWhen` records the package's own "shown by `gpay-personalized`"
 * note (`applicabilityGates.ts`), and the Properties panel has honoured it since
 * the row-hiding fix — but the insert path did not, so a freshly inserted
 * `<Button variant="primary">` arrived carrying `cardLast4="1394"`, a masked
 * card number only the `gpay-personalized` variant ever renders. Writing a
 * value the chosen variant cannot use is not a default, it is noise in a file
 * a human reads, and the panel then hid the very row that would let them
 * remove it. The gate is read against the SEEDED value of its controlling
 * prop, which is exactly what the source will say — no other value exists at
 * insert time.
 */
function propAppliesTo(gate: NonNullable<PropSpec['appliesWhen']>, seeded: Record<string, unknown>): boolean {
  const controlling = seeded[gate.prop]
  return typeof controlling === 'string' && gate.values.includes(controlling)
}

/**
 * Whether a documented example is worth WRITING into the user's source on
 * insert. Content, yes; the component's own defaults and its failure states, no.
 *
 * **Booleans are declined wholesale.** A boolean is never a component's content
 * — it is a mode — and this package documents each one at the value the
 * component already uses (`skeleton={false}`, `dismissOnScrim={true}`,
 * `showBottomBar={true}  // defaults to true`). Writing them back changes
 * nothing on the canvas and costs an inserted `<TextInput>` five redundant
 * attributes (`disabled={false} required={false} skeleton={false}
 * multiline={false} password={false}`) in a file a human reads. The panel's
 * toggle still shows and sets every one of them.
 *
 * **`errorText` and friends are declined by name**, the one place here that
 * reads a name rather than a form. TextInput's own docs are explicit that "the
 * error state is derived from `errorText` being non-empty" — so seeding the
 * documented `"Error message"` does not illustrate the field, it puts every
 * newly inserted field into its failure state, red border and all. A component
 * arriving broken is worse than one arriving blank, which is the whole reason
 * this function exists.
 */
const ERROR_STATE_PROP_RE = /^error/i

function isSeedableDefault(p: PropSpec): boolean {
  if (p.kind === 'boolean' || typeof p.example === 'boolean') return false
  return !ERROR_STATE_PROP_RE.test(p.name)
}
