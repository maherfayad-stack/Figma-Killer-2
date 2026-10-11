/**
 * modeRootPlan - the canvas' two reads of the token catalog's mode gates: which
 * axes the open project declares, and the root changes that put a frame's axes
 * in force (CT-4). A leaf with no editor-store import, so both frame adapters
 * (the portal one writes the plan itself, the bridge one ships it to the live
 * frame's runtime) can share it.
 */
import { axisSelection, type PreviewAxes } from '@core/studio-board'
import { planModeRoot, type ModeAxis, type ModeRootPlan } from '@core/studio-tokens'
import { getStudioTokenCatalog } from '@site/studio/studioTokenCatalogStore'

/** The catalog's mode axes for the open project, or none while it is unread. */
export function currentModeAxes(): readonly ModeAxis[] {
  return getStudioTokenCatalog()?.axes ?? []
}

/** The root attribute/class changes that put `axes` in force, from the catalog's gates. */
export function modeRootPlanFor(modeAxes: readonly ModeAxis[], axes: PreviewAxes): ModeRootPlan {
  return planModeRoot(modeAxes, axisSelection(axes))
}
