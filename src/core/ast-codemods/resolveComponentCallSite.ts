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
  findComponentDeclaration,
  findNamedComponentDeclaration,
  getFunctionLikeNode,
  resolveCallTarget,
  resolveComponentSources,
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
): { ok: true; result: ResolvedCallSiteComponent } | { ok: false; failure: ResolveCallSiteFailure } {
  const relFile = path.relative(workspaceRoot, absFile).split(path.sep).join('/')
  const source = classifyCallSiteComponent(project, callerFile, workspaceRoot, identifier, relFile, line, col)
  if (!source) {
    return { ok: false, failure: { reason: 'unresolvable', message: `Could not resolve <${identifier}>'s declaration.` } }
  }
  if (source.kind === 'package') {
    return { ok: false, failure: { reason: 'package-component', message: `<${identifier}> comes from an installed package, not this project's own source.` } }
  }

  const targetAbsPath = path.resolve(workspaceRoot, source.file)
  const target = resolveCallTarget(callerFile, identifier, targetAbsPath, project)
  if (!target) {
    return { ok: false, failure: { reason: 'unresolvable', message: `Could not resolve <${identifier}>'s declaration in ${source.file}.` } }
  }

  const declaration = target.exportedName === undefined
    ? findComponentDeclaration(target.sourceFile)
    : findNamedComponentDeclaration(target.sourceFile, target.exportedName, !target.sameFile)
  const fn = declaration ? getFunctionLikeNode(declaration) : undefined
  if (!fn) {
    return {
      ok: false,
      failure: { reason: 'unresolvable', message: `<${identifier}> is imported from ${source.file}, but its declaration could not be read.` },
    }
  }

  return { ok: true, result: { source, target, fn } }
}
