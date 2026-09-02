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
  /** A URL pointing at an image the user should be able to upload or pick, not type. */
  | 'image'
  | 'handler'
  /**
   * A structured value the docs show as an array or object literal
   * (`items={[{ icon, label }]}`). NOT editable as text: the panel used to
   * fall back to a text box here, and a real `<TabBar items={[…]}>` then took
   * any typed value — `5` — straight into `items.map(...)` and threw, leaving
   * "TabBar (render error)" on the canvas. There is no honest scalar edit for
   * this shape, so no control is offered.
   */
  | 'collection'
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
  /**
   * A ready-to-use value taken from the package's own documented usage
   * example, for a prop the editor cannot author as a scalar.
   *
   * Only set for `'collection'` props, and only when the documented literal
   * actually parses to something with content. It exists because refusing the
   * text box (which is right — no scalar you can type into `items` is valid)
   * left `<TabBar/>` rendering an empty pill with no way to fill it from the
   * UI at all. Seeding the documented example makes an inserted component
   * arrive populated, which is also what gets written into the user's source.
   *
   * No longer only collections: a component's CONTENT lives in its scalars too,
   * and seeding none of them meant inserting one drew an empty shell. See
   * `documentedExample` for what is and is not recorded.
   */
  example?: unknown
  /**
   * The sibling COLLECTION prop this number indexes — `TabBar.value` -> `items`.
   *
   * A bare number box is technically an edit and practically useless: the panel
   * showed a field labelled `value` holding `0`, and nothing anywhere said it
   * meant "which tab is currently selected". With this, the panel offers the
   * items themselves ("Home", "Explore", …) and writes back the index.
   *
   * Read off the docs, not guessed: set only when the prop's own comment calls
   * it an index (`value={0}  // active tab index (0-based, controlled)`) AND the
   * component has exactly one collection prop for it to index. Two props in this
   * package qualify — `TabBar.value` and `SegmentedControl.value` — and both do
   * index `items`.
   */
  indexesCollection?: string
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
