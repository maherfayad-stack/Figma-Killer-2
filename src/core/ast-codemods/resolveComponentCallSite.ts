/**
 * resolveComponentCallSite — shared "what does this JSX tag actually refer
 * to" resolution for the WS-4.4/4.5 codemods (`detachComponent`,
 * `extractComponentCopy`, `swapComponentInstance`). All three need the exact
 * same answer `inlineLocalComponents.ts` needed for the same question
 * (local vs package, which file, which export, honouring a renaming barrel)
 * — this module is that answer, factored out once instead of copied three
 * times.
 */
import * as path from 'node:path'
import type { Project, SourceFile } from 'ts-morph'
import {
  getFunctionLikeNode,
  resolveCallTarget,
  resolveComponentSources,
  resolveImportedDeclaringFile,
  type CallTarget,
  type ComponentSource,
  type FunctionLike,
  type ParsedNode,
  type ParsedPage,
} from '@core/page-parser'

/**
 * Classifies a component call site's tag identifier as local/package,
 * reusing the EXACT SAME classification `componentSources.ts` runs for a
 * whole-page parse — see that module's doc — by constructing a minimal
 * one-node `ParsedPage` around just this one call site. `project` must
 * already know about `callerFile` (a workspace-wide `Project` — see
 * `createWorkspaceProject`).
 */
export function classifyCallSiteComponent(
  project: Project,
  callerFile: SourceFile,
  workspaceRoot: string,
  identifier: string,
  relFile: string,
  line: number,
  col: number,
): ComponentSource | undefined {
  const fakeId = `${relFile}:${line}:${col}`
  const fakeNode: ParsedNode = {
    id: fakeId,
    kind: 'component',
    name: identifier,
    props: {},
    children: [],
    loc: { file: relFile, line, col },
    locked: false,
  }
  const fakePage: ParsedPage = { rootIds: [fakeId], nodes: { [fakeId]: fakeNode } }
  const sources = resolveComponentSources(project, callerFile.getFilePath(), workspaceRoot, fakePage)
  return sources[fakeId]
}

export interface ResolvedCallSiteComponent {
  source: ComponentSource
  target: CallTarget
  fn: FunctionLike
}

export type ResolveCallSiteFailureReason = 'unresolvable' | 'package-component'

export interface ResolveCallSiteFailure {
  reason: ResolveCallSiteFailureReason
  message: string
}

export interface ResolveCallSiteOptions {
  /**
   * What the project's own `design-system/` folder is. `'refuse'` (the default,
   * and every copy/expose codemod's answer): Studio manages the folder and
   * rewrites it when it goes stale, so copying or editing its body would write
   * code the user does not own. `'local'` (detach, OD-21): the folder is real,
   * in-project code, and inlining it at ONE call site changes nothing in the
   * folder - the result is ordinary markup in the user's page.
   */
  designSystem?: 'refuse' | 'local'
}

/**
 * The full resolution chain from "a JSX tag identifier at (file, line, col)"
 * to "the function whose JSX it renders" — classify (local/package) ->
 * resolve the call target (honouring barrels/renames) -> find the
 * declaration -> unwrap to a `FunctionLike`. Returns a typed failure at
 * whichever step didn't resolve, rather than throwing — every caller here
 * (detach/extract/swap) turns a failure into a specific, user-facing refusal
 * reason of its own.
 */
export function resolveComponentCallSite(
  project: Project,
  callerFile: SourceFile,
  workspaceRoot: string,
  identifier: string,
  absFile: string,
  line: number,
  col: number,
  options: ResolveCallSiteOptions = {},
): { ok: true; result: ResolvedCallSiteComponent } | { ok: false; failure: ResolveCallSiteFailure } {
  const relFile = path.relative(workspaceRoot, absFile).split(path.sep).join('/')
  const source = classifyCallSiteComponent(project, callerFile, workspaceRoot, identifier, relFile, line, col)
  if (!source) {
    return { ok: false, failure: { reason: 'unresolvable', message: `Could not resolve <${identifier}>'s declaration. Reload the project and try again.` } }
  }
  if (source.kind === 'package') {
    return { ok: false, failure: { reason: 'package-component', message: `<${identifier}> comes from an installed package, not this project's own source. Pick a component from your own source.` } }
  }
  // DS-3 - the project's `design-system/` folder is Studio-written and
  // Studio-managed (`@core/page-parser`'s `designSystemDir`). Its files are
  // inside the workspace, so this is NOT the package case textually, but for
  // a copy it is the same refusal in substance: writing that body beside the
  // original would put code the user does not own where Studio rewrites it
  // whenever the folder goes stale. Detach (OD-21) is the exception - see
  // {@link ResolveCallSiteOptions}.
  if (source.kind === 'design-system' && options.designSystem !== 'local') {
    return {
      ok: false,
      failure: {
        reason: 'package-component',
        message: `<${identifier}> comes from the built-in design system, which Studio manages, not from your own source. Pick a component from your own source.`,
      },
    }
  }

  let targetAbsPath: string
  if (source.kind === 'local') {
    targetAbsPath = path.resolve(workspaceRoot, source.file)
  } else {
    const declaring = resolveImportedDeclaringFile(callerFile, identifier)
    if (!declaring) {
      return { ok: false, failure: { reason: 'unresolvable', message: `Could not find where the design system declares <${identifier}>. Reload the project and try again.` } }
    }
    targetAbsPath = declaring.getFilePath()
  }
  const sourceLabel = path.relative(workspaceRoot, targetAbsPath).split(path.sep).join('/')
  const target = resolveCallTarget(callerFile, identifier, targetAbsPath, project)
  if (!target) {
    return { ok: false, failure: { reason: 'unresolvable', message: `Could not resolve <${identifier}>'s declaration in ${sourceLabel}. Reload the project and try again.` } }
  }

  // `memo(…)`/`forwardRef(…)` read as the function they wrap (P3-B), so every
  // codemod built on this sees the component's real signature and JSX.
  const fn = getFunctionLikeNode(target.declaration)
  if (!fn) {
    return {
      ok: false,
      failure: { reason: 'unresolvable', message: `<${identifier}> is imported from ${sourceLabel}, but its declaration could not be read. Check that file for syntax errors.` },
    }
  }

  return { ok: true, result: { source, target, fn } }
}
