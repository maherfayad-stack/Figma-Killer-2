/**
 * variantEditPlan — turn one Add variant / Remove variant / Add property edit
 * into the complete next text of every file it writes, WITHOUT writing any.
 *
 * ## Why the server re-reads instead of trusting the client
 *
 * The edit names a component (`file:line:col` of its declaration, plus its
 * export name), a prop and a value. Everything else — where the union's
 * literals are, which stylesheet or object entry styles each value, what the
 * default is — is read here from the files as they are NOW, by the same
 * analyzer that fed the panel (`extractLocalComponentCatalog`, restricted to
 * the one file). No range, selector or path from the client is ever a write
 * target, so a stale panel can only cause a refusal, never a wrong write.
 *
 * ## All-or-nothing
 *
 * The plan holds the next text of every touched file, computed and parsed
 * before the first byte is written (`studioVariantWriteback.ts` writes them,
 * and puts back what it wrote if a later write fails). A refusal in the third
 * file leaves the first two exactly as they were.
 *
 * ## One honest target
 *
 * Refused rather than guessed: a prop the component styles in computed code
 * (`opaque`), a union that other files also use (a shared alias is N targets),
 * and, for Remove, a value some call site passes (the refusal lists them).
 *
 * Parse, never execute. Nothing here renders a component or evaluates a module.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Node, SyntaxKind, type Project } from 'ts-morph'
import {
  addComponentProp,
  callSitesPassingVariant,
  findComponentCallSites,
  planAddVariant,
  planRemoveVariant,
  typeAliasReferences,
  type NewComponentProp,
  type VariantPlan,
  type VariantPropInput,
} from '@core/ast-codemods'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { createWorkspaceProject, isWorkspaceWritablePath, unwritableWorkspaceSegment } from '@core/page-parser'
import { applyLineEnding, detectLineEnding, toLf } from '@core/utils/lineEndings'
import type { VariantMember } from '@core/component-variants'
import { extractLocalComponentCatalog, type LocalComponentSpec, type LocalPropSpec } from './componentSpecExtract'
import { storiesPassingVariant } from './variantStoryUses'

/** What the three kinds ask for, as the planner sees it (the wire shapes are in `studioVariantWriteback.ts`). */
export type VariantEditRequest =
  | { kind: 'add-variant'; exportName: string; prop: string; name: string }
  | { kind: 'remove-variant'; exportName: string; prop: string; name: string }
  | { kind: 'add-component-prop'; exportName: string; prop: NewComponentProp }

/** One file a variant edit writes: what is on disk now, and exactly what should be there after (both with the file's own line endings). */
export interface VariantFileWrite {
  abs: string
  rel: string
  original: string
  next: string
}

export type VariantEditPlan = { ok: true; writes: VariantFileWrite[] } | { ok: false; reason: string; message: string }

function refuse(reason: string, message: string): { ok: false; reason: string; message: string } {
  return { ok: false, reason, message }
}

/** `studioEditRouting.ts`'s `canonicalSourceRel` for one project, injected: this module sits below the routing in the import graph (the routing asks it which files a variant edit touches). */
export type CanonicalSourceRel = (rel: string) => string | null

const SOURCE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs)$/i
const STYLESHEET_EXTENSION = /\.css$/i

/** The absolute path a variant edit may read and write for `rel`, or `null` — the same containment every writer shares. */
function writableTarget(dir: string, rel: string, canonicalRel: CanonicalSourceRel): string | null {
  const segments = rel.split(/[\\/]+/)
  if (rel.length === 0 || /^[a-zA-Z]:/.test(rel) || segments.some((segment) => segment === '' || segment === '..' || segment === '.')) return null
  if (SOURCE_EXTENSION.test(rel)) {
    const canonical = canonicalRel(rel)
    return canonical === null ? null : join(dir, ...canonical.split('/'))
  }
  if (STYLESHEET_EXTENSION.test(rel)) {
    if (unwritableWorkspaceSegment(rel) !== null || classifyStylesheetEditability(rel).kind !== 'plain-css') return null
    const abs = join(dir, ...segments)
    return isWorkspaceWritablePath(dir, abs) && existsSync(abs) ? abs : null
  }
  return null
}

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8')
  } catch (_err) {
    // A file that vanished mid-plan is a refusal the caller words ("could not read it"), not a crash.
    return undefined
  }
}

/** Turns a planner result (`rel -> next LF text`) into writes, each re-checked against the write guard and given the file's own line endings. */
function toWrites(dir: string, canonicalRel: CanonicalSourceRel, files: ReadonlyMap<string, string>): VariantFileWrite[] | { ok: false; reason: string; message: string } {
  const writes: VariantFileWrite[] = []
  for (const [rel, nextLf] of files) {
    const abs = writableTarget(dir, rel, canonicalRel)
    const original = abs === null ? undefined : readText(abs)
    if (abs === null || original === undefined) {
      return refuse('unwritable-target', `${rel} is outside the files Studio may write (or no longer exists), so nothing was written.`)
    }
    writes.push({ abs, rel, original, next: applyLineEnding(nextLf, detectLineEnding(original)) })
  }
  // Stylesheets first: if a later write fails, the union (the file that would otherwise promise a rule) is still untouched.
  return writes.sort((a, b) => Number(SOURCE_EXTENSION.test(a.rel)) - Number(SOURCE_EXTENSION.test(b.rel)))
}

function fromPlan(dir: string, canonicalRel: CanonicalSourceRel, plan: VariantPlan): VariantEditPlan {
  if (!plan.ok) return refuse(plan.refusal.reason, plan.refusal.message)
  const writes = toWrites(dir, canonicalRel, plan.files)
  return Array.isArray(writes) ? { ok: true, writes } : writes
}

function listUses(uses: ReadonlyArray<{ file: string; line: number }>): string {
  const shown = uses.slice(0, 5).map((use) => `${use.file}:${use.line}`)
  return uses.length > shown.length ? `${shown.join(', ')} and ${uses.length - shown.length} more` : shown.join(', ')
}

/** The union is a named alias other files also use: writing it is several targets. */
function sharedUnionRefusal(project: Project, dir: string, componentRel: string, members: readonly VariantMember[], prop: string): { reason: string; message: string } | null {
  const origin = members.find((member) => member.origin)?.origin
  if (!origin) return null
  const sourceFile = project.getSourceFile(join(dir, ...origin.file.split('/')))
  if (!sourceFile) return null
  const offset = sourceFile.compilerNode.getPositionOfLineAndCharacter(origin.line - 1, origin.column - 1)
  const alias = sourceFile.getDescendantAtPos(offset)?.getFirstAncestorByKind(SyntaxKind.TypeAliasDeclaration)
  if (!alias || !Node.isTypeAliasDeclaration(alias)) return null
  const elsewhere = typeAliasReferences(project, dir, alias, new Set([componentRel, origin.file]))
  if (elsewhere.length === 0) return null
  return {
    reason: 'shared-union',
    message: `The values of \`${prop}\` are the type \`${alias.getName()}\`, which ${listUses(elsewhere)} also use. Changing it would change those too, so edit it in code.`,
  }
}

interface ResolvedProp {
  spec: LocalComponentSpec
  prop: LocalPropSpec
}

function resolveEnumProp(project: Project, dir: string, componentRel: string, exportName: string, propName: string): ResolvedProp | { reason: string; message: string } {
  const spec = extractLocalComponentCatalog(project, dir, { onlyFile: componentRel }).find((candidate) => candidate.exportName === exportName)
  if (!spec) return { reason: 'component-not-found', message: `The component "${exportName}" is no longer in ${componentRel}: the file changed since it was read.` }
  const prop = spec.props.find((candidate) => candidate.name === propName)
  if (!prop || prop.kind.kind !== 'enum') {
    return { reason: 'not-a-variant-prop', message: `\`${propName}\` is not a set of fixed values on ${spec.name}, so it has no values to add or remove.` }
  }
  return { spec, prop }
}

/**
 * Plan one variant edit against the files as they are now. `componentRel` is
 * the canonical workspace-relative path the edit's `nodeId` decoded to.
 */
export function planVariantEdit(dir: string, request: VariantEditRequest, componentRel: string, canonicalRel: CanonicalSourceRel): VariantEditPlan {
  const project = createWorkspaceProject(dir)
  const componentAbs = join(dir, ...componentRel.split('/'))

  if (request.kind === 'add-component-prop') {
    const original = readText(componentAbs)
    if (original === undefined) return refuse('unwritable-target', `${componentRel} could not be read, so nothing was written.`)
    const result = addComponentProp(componentRel, toLf(original), request.exportName, request.prop)
    if (!result.ok) return refuse(result.refusal.reason, result.refusal.message)
    return fromPlan(dir, canonicalRel, { ok: true, files: new Map([[componentRel, result.source]]), styling: 'none' })
  }

  const resolved = resolveEnumProp(project, dir, componentRel, request.exportName, request.prop)
  if ('reason' in resolved) return refuse(resolved.reason, resolved.message)
  const { spec, prop } = resolved
  const input: VariantPropInput = {
    componentName: spec.name,
    prop: prop.name,
    members: prop.members ?? [],
    ...(prop.defaultValue !== undefined ? { defaultValue: prop.defaultValue } : {}),
    ...(prop.binding ? { binding: prop.binding } : {}),
  }

  const shared = sharedUnionRefusal(project, dir, componentRel, input.members, prop.name)
  if (shared) return refuse(shared.reason, shared.message)

  const read = (rel: string): string | undefined => {
    const abs = writableTarget(dir, rel, canonicalRel)
    const text = abs === null ? undefined : readText(abs)
    return text === undefined ? undefined : toLf(text)
  }

  if (request.kind === 'remove-variant') {
    const sites = findComponentCallSites(project, dir, componentAbs, request.exportName)
    // A story's `args` are call sites too: an args-only story has no JSX for the scan above to find.
    const uses = [
      ...callSitesPassingVariant(project, dir, sites, prop.name, request.name),
      ...storiesPassingVariant(dir, project, componentRel, prop.name, request.name),
    ]
    if (uses.length > 0) {
      return refuse(
        'variant-in-use',
        `${uses.length === 1 ? 'One place passes' : `${uses.length} places pass`} ${prop.name}="${request.name}": ${listUses(uses)}. Change ${uses.length === 1 ? 'it' : 'them'} first, then remove the value.`,
      )
    }
    return fromPlan(dir, canonicalRel, planRemoveVariant(input, read, request.name))
  }
  return fromPlan(dir, canonicalRel, planAddVariant(input, read, request.name))
}
