/**
 * modeRoot - what rendering a frame "in" a mode does to the frame's own
 * document root, decided from the token catalog's gates (CT-4).
 *
 * A mode is a gate (`gates.ts`): `[data-theme="dark"]`, `.dark`, `:lang(ar)`,
 * `@media (prefers-color-scheme: dark)`. The catalog already read every gate
 * the project's CSS declares, so "show this frame in dark" is not a guess about
 * conventions: it is writing the attribute or class the project's own selector
 * tests for, on the frame's `<html>`, and removing the ones that select the
 * other modes. The author's stylesheet then answers exactly as it does in the
 * real app.
 *
 * ## What is NOT emulated here
 *
 *   - `direction` and `locale` have first-class fields on `PreviewAxes` with
 *     their own behaviour (`dir`/`lang` writes, a parse-time locale reload), so
 *     the planner leaves those two axes to that path.
 *   - A `@media (prefers-color-scheme)` gate is already answered by the canvas'
 *     stylesheet rewrite (`data-studio-scheme`, written by the axes effect), so
 *     it plans nothing.
 *   - Any other `@media` gate (a width or contrast query) cannot be emulated by
 *     an attribute; the frame's own width decides it. Such a mode is not a
 *     choice (`isEmulableMode`), so a chip never offers one that would do nothing.
 *
 * Pure and DOM-free to plan; `applyModeRootPlan` takes the `<html>` element and
 * is shared by the portal frame adapter and the live-frame runtime.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { modeOfGate, type ModeGate } from './gates'
import type { ModeAxis } from './schema'

/** Axes with their own first-class handling; the planner leaves them alone. */
const OWN_PATH_AXES: ReadonlySet<string> = new Set(['direction', 'locale'])

/** True for an axis the planner and the mode chips drive from the catalog; false for `direction`/`locale`, which have their own fields and controls. */
export function isCatalogDrivenAxis(axisId: string): boolean {
  return !OWN_PATH_AXES.has(axisId)
}

/** Largest plan a frame will accept over the live-frame bridge. */
export const MODE_ROOT_PLAN_MAX_ENTRIES = 64

/** `attrs`: name to value to set, or `null` to remove. `classes`: name to present/absent. */
export const ModeRootPlanSchema = Type.Object({
  attrs: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Union([Type.String({ maxLength: 200 }), Type.Null()]), {
    maxProperties: MODE_ROOT_PLAN_MAX_ENTRIES,
  }),
  classes: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Boolean(), { maxProperties: MODE_ROOT_PLAN_MAX_ENTRIES }),
})
export type ModeRootPlan = Static<typeof ModeRootPlanSchema>

export interface ModeChoice {
  /** The mode id, or `null` for the axis' default (no gate selected). */
  readonly id: string | null
  readonly label: string
}

/** True when an attribute/class on the root can stand in for this gate. */
export function isEmulableGate(gate: ModeGate): boolean {
  if (gate.kind === 'attr' || gate.kind === 'class') return true
  if (gate.kind !== 'media') return false
  const mode = modeOfGate(gate)
  return mode !== null && mode.axisId === 'color-scheme'
}

/**
 * What a chip on `axis` offers: the default plus every emulable mode. The
 * colour scheme always offers both `light` and `dark` (one of them is the
 * `:root` default, which the catalog does not list as a mode).
 */
export function axisChoices(axis: ModeAxis): ModeChoice[] {
  const modes = axis.modes.filter((mode) => isEmulableGate(mode.gate))
  if (modes.length === 0) return []
  if (axis.id === 'color-scheme') {
    const labelled = new Map(modes.map((mode) => [mode.id, mode.label]))
    return ['light', 'dark'].map((id) => ({ id, label: labelled.get(id) ?? id[0]!.toUpperCase() + id.slice(1) }))
  }
  return [{ id: null, label: 'Default' }, ...modes.map((mode) => ({ id: mode.id, label: mode.label }))]
}

/**
 * The root changes that put `selection` (`axisId -> modeId`) in force, from the
 * catalog's `axes`. Unselected modes are switched off BEFORE selected ones are
 * switched on, so two modes that share an attribute (`[data-theme=dark]`,
 * `[data-theme=light]`) never undo each other.
 */
export function planModeRoot(axes: readonly ModeAxis[], selection: Readonly<Record<string, string>>): ModeRootPlan {
  const attrs: Record<string, string | null> = {}
  const classes: Record<string, boolean> = {}
  const selectedAttrs: Record<string, string> = {}
  const selectedClasses: string[] = []

  for (const axis of axes) {
    if (!isCatalogDrivenAxis(axis.id)) continue
    const chosen = selection[axis.id]
    for (const mode of axis.modes) {
      const gate = mode.gate
      const isChosen = chosen === mode.id
      if (gate.kind === 'class') {
        classes[gate.className] = false
        if (isChosen) selectedClasses.push(gate.className)
      } else if (gate.kind === 'attr') {
        // `:not([data-theme=light])` selects "dark": the attribute must hold
        // something OTHER than the negated value for the gate to match, and
        // the negated value itself when the mode is off.
        if (gate.negate) {
          attrs[gate.attr] = gate.value
          if (isChosen) selectedAttrs[gate.attr] = mode.id === gate.value ? `studio-${mode.id}` : mode.id
        } else {
          if (!(gate.attr in attrs)) attrs[gate.attr] = null
          if (isChosen) selectedAttrs[gate.attr] = gate.value
        }
      }
    }
  }

  for (const [name, value] of Object.entries(selectedAttrs)) attrs[name] = value
  for (const name of selectedClasses) classes[name] = true
  return { attrs, classes }
}

/** Writes `plan` onto the frame's root element. Idempotent. */
export function applyModeRootPlan(html: Element, plan: ModeRootPlan): void {
  for (const [name, value] of Object.entries(plan.attrs)) {
    if (value === null) html.removeAttribute(name)
    else if (html.getAttribute(name) !== value) html.setAttribute(name, value)
  }
  for (const [name, present] of Object.entries(plan.classes)) html.classList.toggle(name, present)
}

/** Whether the catalog defines a colour-scheme axis the planner can drive (so a probe-derived class toggle is not also needed). */
export function drivesColorScheme(axes: readonly ModeAxis[]): boolean {
  return axes.some((axis) => axis.id === 'color-scheme' && axis.modes.some((mode) => mode.gate.kind !== 'media' && isEmulableGate(mode.gate)))
}

/** Stable key of a plan, so an effect can skip a re-send when nothing changed. */
export function modeRootPlanKey(plan: ModeRootPlan): string {
  return JSON.stringify([plan.attrs, plan.classes])
}
