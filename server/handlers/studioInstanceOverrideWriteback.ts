/**
 * studioInstanceOverrideWriteback - the two `/save` edits behind OD-19's
 * "editing a value inside a shared component changes ONLY that instance",
 * split out of `studioWriteback.ts` (module-size ceiling) along the line the
 * instance-override family draws: `expose-prop` (a literal becomes an optional
 * prop, the value is passed at ONE call site) and `promote-override` ("Apply to
 * all"). Their class-bound sibling is `studioClassOverride.ts`.
 *
 * Every position an id names is decoded by the caller's `locate` (the one path
 * decoder), so containment is per file and this module never builds a path
 * from the client.
 */
import { join } from 'node:path'
import { exposeLiteralAsProp, promoteOverrideToDefault } from '@core/ast-codemods'
import { callSitePosition, inlineDepth, inlineSegments } from '@core/page-tree'
import { StudioEditRefusalError } from './studioEditRefusals'
import type { LocateNode } from './studioClassOverride'
import type { StudioEdit, StudioEditApplyOutcome } from './studioEditSchemas'

/** An element's decoded position, with the absolute file its tail names. */
export interface ElementLocation {
  file: string
  line: number
  col: number
}

export function applyInstanceOverrideEdit(
  dir: string,
  edit: Extract<StudioEdit, { kind: 'expose-prop' | 'promote-override' }>,
  loc: ElementLocation,
  locate: LocateNode,
): StudioEditApplyOutcome {
  if (edit.kind === 'expose-prop') {
    // P5-C (DET-7) - two files: the component (this id's tail, `loc`) and the ONE call site (its head). G-2b: an
    // element deeper than one call site also names the call site inside each component on the way down
    // (`page~Card~Badge`); each is decoded on its own, so each file is contained on its own, and the codemod
    // threads the value through them.
    if (inlineDepth(edit.nodeId) < 1) {
      throw new StudioEditRefusalError('not-in-component', 'Only an element of a component can become a prop of that component.')
    }
    const sites = inlineSegments(edit.nodeId).slice(0, -1).map((segment) => locate(segment))
    const [callSite, ...inner] = sites
    if (!callSite || inner.some((site) => site === null)) return { applied: false, unwritable: 'no-source-location' }
    const result = exposeLiteralAsProp({
      callSiteFile: join(dir, callSite.rel),
      callSiteLine: callSite.line,
      callSiteCol: callSite.col,
      via: inner.flatMap((site) => (site ? [{ file: join(dir, site.rel), line: site.line, col: site.col }] : [])),
      elementFile: loc.file,
      line: loc.line,
      col: loc.col,
      workspaceRoot: dir,
      overrides: edit.overrides.map(({ target, propName, value }) => ({ target, propName, ...(value !== undefined ? { value } : {}) })),
    })
    if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
    return { applied: true }
  }
  // OD-19 - "Apply to all": the same two files as `expose-prop`, addressed the same way (call site = the id's head,
  // component file = its tail, both through the one decoder); the codemod checks the file the call site's import
  // resolves to is the tail's.
  if (inlineDepth(edit.nodeId) !== 1) {
    throw new StudioEditRefusalError('not-in-component', 'Only an instance placed directly on this page can have a value applied to every place its component is used.')
  }
  const callSite = locate(callSitePosition(edit.nodeId))
  if (!callSite) return { applied: false, unwritable: 'no-source-location' }
  const result = promoteOverrideToDefault({
    callSiteFile: join(dir, callSite.rel),
    callSiteLine: callSite.line,
    callSiteCol: callSite.col,
    componentFile: loc.file,
    workspaceRoot: dir,
    propNames: edit.propNames,
  })
  if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
  return { applied: true }
}
