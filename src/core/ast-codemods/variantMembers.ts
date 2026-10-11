/**
 * variantMembers — plan "Add variant" and "Remove variant" for ONE enum prop of
 * ONE local component: the union member, plus whatever the component's own
 * code uses to turn that member into styling.
 *
 * The plan is built from the variant read model (`@core/component-variants`):
 * the prop's members with the source range of the literal that defines each,
 * its default, and its `binding` — how the component consumes the prop. Which
 * second write a binding needs is the whole decision:
 *
 *   | binding             | Add variant                                   | Remove variant                |
 *   |---------------------|-----------------------------------------------|-------------------------------|
 *   | css-module-class    | copy the default member's rule under `.new`   | delete that member's rule     |
 *   | data-attr           | copy its `[data-x="default"]` rule            | delete that member's rule     |
 *   | lookup-object / cva | copy the default member's entry under `new`   | delete that member's entry    |
 *   | boolean-class       | refused (a boolean has no members)            | refused                       |
 *   | opaque / unread     | refused with the line that defeated Studio    | refused                       |
 *
 * `opaque` refuses on purpose: when the prop is also read by computed code (a
 * ternary, a switch, `variant === 'ghost'`), copying one rule would leave that
 * branch unaware of the new member, and removing one would leave it comparing
 * against a value the type no longer allows. One honest target or no write.
 *
 * The result is the complete next text of every file the change touches — all
 * computed before any is written, so a refusal in the third file leaves the
 * first two exactly as they were. Same-file splices (the union and a lookup
 * object in one `.tsx`) are planned against the original text and applied
 * together. Text is LF-normalised; the caller restores each file's own ending.
 *
 * Whether a CALL SITE passes the member being removed is not decided here (it
 * needs the whole workspace): `variantCallSites.ts` answers it and the server
 * refuses before planning.
 */
import {
  cloneRule,
  removeRule,
  rewriteAttributeSelector,
  rewriteClassSelector,
  type VariantRuleRefusal,
} from '@core/css-codemods'
import { applyTextSplices, type TextSplice } from '@core/utils/textSplice'
import { VARIANT_NAME_PATTERN } from '@core/component-variants'
import type { PropDefault, SourceRange, VariantBinding, VariantEntry, VariantMember, VariantRule } from '@core/component-variants'
import { cloneObjectEntry, removeObjectEntry, type ObjectEntryRefusal } from './objectEntry'
import { addUnionMember, removeUnionMember, type UnionMemberRefusal } from './unionMember'

export type VariantPlanRefusalReason =
  | 'union-not-writable'
  | 'no-binding'
  | 'opaque-binding'
  | 'unsupported-binding'
  | 'no-such-variant'
  | 'default-variant'
  | 'file-unreadable'
  | UnionMemberRefusal['reason']
  | ObjectEntryRefusal['reason']
  | VariantRuleRefusal['reason']

export interface VariantPlanRefusal {
  reason: VariantPlanRefusalReason
  message: string
}

/** How the member's styling was handled: copied/removed, or already there (a rule or entry of that name existed). */
export type VariantStyling = 'cloned' | 'already-styled' | 'removed' | 'none'

export type VariantPlan =
  | {
      ok: true
      /** The next LF text of every file the change writes, keyed by workspace-relative POSIX path. */
      files: Map<string, string>
      styling: VariantStyling
      /** Workspace-relative file the style rule/entry lives in, when there is one. */
      stylingFile?: string
    }
  | { ok: false; refusal: VariantPlanRefusal }

/** The LF text of a workspace file, or `undefined` when it cannot be read. */
export type ReadWorkspaceText = (rel: string) => string | undefined

export interface VariantPropInput {
  componentName: string
  prop: string
  members: readonly VariantMember[]
  defaultValue?: PropDefault
  binding?: VariantBinding
}

function refuse(reason: VariantPlanRefusalReason, message: string): { ok: false; refusal: VariantPlanRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/** Splices collected per file, and the original text each was planned against. */
class FileEdits {
  private readonly originals = new Map<string, string>()
  private readonly splices = new Map<string, TextSplice[]>()
  private readonly read: ReadWorkspaceText

  constructor(read: ReadWorkspaceText) {
    this.read = read
  }

  text(rel: string): string | undefined {
    if (!this.originals.has(rel)) {
      const text = this.read(rel)
      if (text === undefined) return undefined
      this.originals.set(rel, text)
    }
    return this.originals.get(rel)
  }

  add(rel: string, splice: TextSplice): void {
    this.splices.set(rel, [...(this.splices.get(rel) ?? []), splice])
  }

  result(): Map<string, string> {
    const files = new Map<string, string>()
    for (const [rel, splices] of this.splices) files.set(rel, applyTextSplices(this.originals.get(rel)!, splices))
    return files
  }
}

/** The member whose styling is the model for a new variant: the default's, else the first that has any. */
function sourceMember(input: VariantPropInput, styled: readonly string[]): string | undefined {
  if (typeof input.defaultValue === 'string' && styled.includes(input.defaultValue)) return input.defaultValue
  return styled[0]
}

function unreadable(rel: string): { ok: false; refusal: VariantPlanRefusal } {
  return refuse('file-unreadable', `Studio could not read ${rel}, so nothing was written.`)
}

function membersWithOrigin(input: VariantPropInput): { members: Array<VariantMember & { origin: SourceRange }>; file: string } | VariantPlanRefusal {
  const members = input.members.filter((member): member is VariantMember & { origin: SourceRange } => member.origin !== undefined)
  const file = members[0]?.origin.file
  if (members.length !== input.members.length || members.length === 0 || file === undefined || members.some((member) => member.origin.file !== file)) {
    return {
      reason: 'union-not-writable',
      message: `The values of \`${input.prop}\` are not all written as string literals in one file of your project, so a value cannot be added or removed here.`,
    }
  }
  return { members, file }
}

/** The bindings Add / Remove variant can write: a stylesheet rule per value, or an object entry per value. */
type StyledBinding = Extract<VariantBinding, { kind: 'css-module-class' | 'data-attr' | 'lookup-object' | 'cva' }>

function styledBindingOf(input: VariantPropInput): StyledBinding | VariantPlanRefusal {
  const { binding } = input
  if (!binding) {
    return { reason: 'no-binding', message: `Studio could not read how ${input.componentName} styles \`${input.prop}\`, so it cannot extend it.` }
  }
  if (binding.kind === 'opaque') {
    return {
      reason: 'opaque-binding',
      message: `${input.componentName} chooses its styling from \`${input.prop}\` in code Studio cannot extend safely (${binding.reason}; ${binding.file}:${binding.line}). Edit it in code.`,
    }
  }
  if (binding.kind === 'boolean-class') {
    return { reason: 'unsupported-binding', message: `\`${input.prop}\` is an on/off class, not a set of values, so it has nothing to add or remove.` }
  }
  return binding
}

interface StyleSheetTarget {
  rule: VariantRule
  /** Rewrites the member's selector into another member's. */
  rewrite: (from: string, to: string) => (selector: string) => string
}

function styleSheetTarget(binding: Extract<VariantBinding, { kind: 'css-module-class' | 'data-attr' }>, member: string): StyleSheetTarget | undefined {
  const rule = binding.rules.find((candidate) => candidate.member === member)
  if (!rule) return undefined
  if (binding.kind === 'css-module-class') {
    const { classPrefix, classSuffix } = binding
    return { rule, rewrite: (from, to) => (selector) => rewriteClassSelector(selector, `${classPrefix}${from}${classSuffix}`, `${classPrefix}${to}${classSuffix}`) }
  }
  return { rule, rewrite: (from, to) => (selector) => rewriteAttributeSelector(selector, binding.attr, from, to) }
}

/** Plan adding the member `name` to the enum prop. */
export function planAddVariant(input: VariantPropInput, read: ReadWorkspaceText, name: string): VariantPlan {
  if (!VARIANT_NAME_PATTERN.test(name)) {
    return refuse('invalid-variant-name', `"${name}" is not a usable variant name: start with a letter, then letters, digits, "-" or "_".`)
  }
  if (input.members.some((member) => member.name === name)) return refuse('variant-exists', `\`${input.prop}\` already has a "${name}" value.`)
  const located = membersWithOrigin(input)
  if ('reason' in located) return { ok: false, refusal: located }
  const binding = styledBindingOf(input)
  if ('reason' in binding) return { ok: false, refusal: binding }

  const edits = new FileEdits(read)
  const unionText = edits.text(located.file)
  if (unionText === undefined) return unreadable(located.file)
  const last = located.members.at(-1)!
  const union = addUnionMember(located.file, unionText, { line: last.origin.line, column: last.origin.column, name: last.name }, name)
  if (!union.ok) return { ok: false, refusal: union.refusal }
  edits.add(located.file, union.splice)

  let styling: VariantStyling
  let stylingFile: string | undefined
  if (binding.kind === 'css-module-class' || binding.kind === 'data-attr') {
    const from = sourceMember(input, binding.rules.map((rule) => rule.member))
    const target = from === undefined ? undefined : styleSheetTarget(binding, from)
    if (!from || !target) return refuse('no-binding', `Studio found no rule styling any value of \`${input.prop}\`, so there is nothing to copy.`)
    const sheet = edits.text(target.rule.range.file)
    if (sheet === undefined) return unreadable(target.rule.range.file)
    const cloned = cloneRule(
      sheet,
      { line: target.rule.range.line, column: target.rule.range.column, selector: target.rule.selector },
      target.rewrite(from, name),
    )
    if (!cloned.ok) return { ok: false, refusal: cloned.refusal }
    stylingFile = target.rule.range.file
    styling = cloned.existed ? 'already-styled' : 'cloned'
    if (cloned.splice) edits.add(stylingFile, cloned.splice)
  } else {
    const from = sourceMember(input, binding.entries.map((entry) => entry.member))
    const entry: VariantEntry | undefined = binding.entries.find((candidate) => candidate.member === from)
    if (!from || !entry) return refuse('no-binding', `Studio found no entry styling any value of \`${input.prop}\`, so there is nothing to copy.`)
    const text = edits.text(entry.range.file)
    if (text === undefined) return unreadable(entry.range.file)
    const cloned = cloneObjectEntry(entry.range.file, text, { line: entry.range.line, column: entry.range.column, member: from }, name)
    if (!cloned.ok) return { ok: false, refusal: cloned.refusal }
    stylingFile = entry.range.file
    styling = cloned.existed ? 'already-styled' : 'cloned'
    if (cloned.splice) edits.add(stylingFile, cloned.splice)
  }
  return { ok: true, files: edits.result(), styling, ...(stylingFile ? { stylingFile } : {}) }
}

/** Plan removing the member `name` from the enum prop. */
export function planRemoveVariant(input: VariantPropInput, read: ReadWorkspaceText, name: string): VariantPlan {
  const member = input.members.find((candidate) => candidate.name === name)
  if (!member) return refuse('no-such-variant', `\`${input.prop}\` has no "${name}" value.`)
  if (input.defaultValue === name) {
    return refuse('default-variant', `"${name}" is the default of \`${input.prop}\`; pick another default in code first.`)
  }
  const located = membersWithOrigin(input)
  if ('reason' in located) return { ok: false, refusal: located }
  const binding = styledBindingOf(input)
  if ('reason' in binding) return { ok: false, refusal: binding }

  const edits = new FileEdits(read)
  const unionText = edits.text(located.file)
  if (unionText === undefined) return unreadable(located.file)
  const at = located.members.find((candidate) => candidate.name === name)!
  const union = removeUnionMember(located.file, unionText, { line: at.origin.line, column: at.origin.column, name })
  if (!union.ok) return { ok: false, refusal: union.refusal }
  edits.add(located.file, union.splice)

  let styling: VariantStyling = 'none'
  let stylingFile: string | undefined
  if (binding.kind === 'css-module-class' || binding.kind === 'data-attr') {
    const target = styleSheetTarget(binding, name)
    if (target) {
      const sheet = edits.text(target.rule.range.file)
      if (sheet === undefined) return unreadable(target.rule.range.file)
      const removed = removeRule(sheet, { line: target.rule.range.line, column: target.rule.range.column, selector: target.rule.selector })
      if (!removed.ok) return { ok: false, refusal: removed.refusal }
      stylingFile = target.rule.range.file
      styling = 'removed'
      edits.add(stylingFile, removed.splice)
    }
  } else {
    const entry = binding.entries.find((candidate) => candidate.member === name)
    if (entry) {
      const text = edits.text(entry.range.file)
      if (text === undefined) return unreadable(entry.range.file)
      const removed = removeObjectEntry(entry.range.file, text, { line: entry.range.line, column: entry.range.column, member: name })
      if (!removed.ok) return { ok: false, refusal: removed.refusal }
      stylingFile = entry.range.file
      styling = 'removed'
      edits.add(stylingFile, removed.splice)
    }
  }
  return { ok: true, files: edits.result(), styling, ...(stylingFile ? { stylingFile } : {}) }
}
