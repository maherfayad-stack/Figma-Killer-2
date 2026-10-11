/**
 * studioVariantCommits — the editor's three writes to a component's
 * DEFINITION (CV-3): Add variant, Remove variant, Add property.
 *
 * They are one-shot structural commits (`commitStructural`), like Detach and
 * Expose-as-prop: one `/save` batch, one journal entry covering every file it
 * wrote (the component, and the stylesheet or lookup object that styles the
 * new value), and a ⌘Z that is the journal's `restore` — byte for byte, in one
 * step. Nothing is applied on the canvas first: the board re-reads the files,
 * so the gallery gets its new cell from the source, not from a guess.
 *
 * A refusal is the engine's usual warning with the server's sentence (an
 * opaque styling pattern names its line, a value some call site passes lists
 * the sites); nothing was written and there is nothing to take back.
 *
 * The edit addresses the component by `file:line:col` of its declaration (the
 * catalog's `line`/`column`) plus its export name. Nothing else the board
 * knows is sent — the server re-reads the union, the rule and the default.
 */
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { commitStructural } from './studioStructuralCommitEngine'

/** The new property's type and default, as the wire carries them. */
export type NewPropertyType =
  | { kind: 'boolean'; defaultValue: boolean }
  | { kind: 'text'; defaultValue: string }
  | { kind: 'variant'; members: readonly string[] }

/** The id the server decodes to the component's file and position. */
export function componentDefinitionNodeId(spec: Pick<LocalComponentSpec, 'file' | 'line' | 'column'>): string {
  return `${spec.file}:${spec.line}:${spec.column}`
}

function commitDefinitionEdit(
  spec: LocalComponentSpec,
  fields: Record<string, unknown> & { kind: string },
  refusalTitle: string,
  label: string,
): Promise<void> {
  return commitStructural([{ ...fields, nodeId: componentDefinitionNodeId(spec), exportName: spec.exportName }], refusalTitle, {
    undo: { label, template: { kind: 'restore-journal' } },
  })
}

/** A new value for the enum prop `prop`, styled as a copy of the default value's. */
export function commitStudioAddVariant(spec: LocalComponentSpec, prop: string, name: string): Promise<void> {
  return commitDefinitionEdit(spec, { kind: 'add-variant', prop, name }, 'Could not add the variant', `Add ${prop} "${name}"`)
}

/** Takes the value `name` out of the enum prop `prop`, with the rule or entry that styled it. */
export function commitStudioRemoveVariant(spec: LocalComponentSpec, prop: string, name: string): Promise<void> {
  return commitDefinitionEdit(spec, { kind: 'remove-variant', prop, name }, 'Could not remove the variant', `Remove ${prop} "${name}"`)
}

/** A new optional prop with a default, in the component's signature. */
export function commitStudioAddComponentProp(spec: LocalComponentSpec, name: string, propType: NewPropertyType): Promise<void> {
  return commitDefinitionEdit(spec, { kind: 'add-component-prop', name, propType }, 'Could not add the property', `Add property "${name}"`)
}
