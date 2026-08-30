/**
 * What KIND of value a prop takes, in the vocabulary the Properties panel's
 * one control mapping speaks (`controlForPropKind`,
 * `src/admin/pages/site/property-controls/componentPropKind.ts`).
 *
 * A package that ships TypeScript declarations gets this from its `.d.ts`
 * (`componentSpecExtract.ts`). A package that ships bundled untyped JS — the
 * ALM design system does — has only its own docs, so
 * `buildDesignSystemManifest` derives it from the value FORM in each
 * component's documented JSX example (`skeleton={false}` is a boolean,
 * `icon={<SvgIcon />}` is a node, `onClick={fn}` is a handler). Without it
 * every prop fell through to a text box: a boolean was typed as the word
 * "false", and an `onClick` got an editable field that could only ever
 * corrupt the call site.
 */
export type PropSpecKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'node'
  | 'icon'
  | 'handler'
  | 'unknown'

export interface PropSpec {
  name: string
  tsType: string
  required: boolean
  defaultValue?: string
  enumValues?: string[]
  description?: string
  /** See {@link PropSpecKind}. Absent means "not determined" — treated as `'unknown'`. */
  kind?: PropSpecKind
}

export interface ComponentSpec {
  name: string
  file: string
  exportName: string
  isDefaultExport: boolean
  props: PropSpec[]
}

export interface ComponentManifest {
  components: ComponentSpec[]
}
