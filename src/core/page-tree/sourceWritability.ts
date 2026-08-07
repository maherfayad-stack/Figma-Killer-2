/**
 * The single rule for "can the editor change this value?" on a studio-imported
 * node, asked by every surface that offers an edit: the store's mutation guards,
 * the docked properties panel, the in-place canvas inspector, and the save
 * adapter that turns a change into a source writeback.
 *
 * The rule is per-PROP and lives in `PageNode.codeProps`. It used to be
 * per-NODE, keyed on `lockReason`, and that conflated two unrelated facts:
 *
 *   - the node's STRUCTURE is code-controlled — a `.map` generated it, a ternary
 *     or `&&` chose it, a spread feeds it. True of huge swathes of a real app:
 *     a screen with `if (loading) return <Spinner/>` puts every node in its main
 *     return behind a branch.
 *   - the node's VALUES cannot be written back.
 *
 * The first does not imply the second. Which branch renders at runtime has
 * nothing to do with whether `title="Where to?"` on that branch's element is a
 * literal attribute at a known line and column — it is one, and `setJsxProp`
 * rewrites it precisely. Gating props on the structural lock made 42% of an
 * imported board's nodes silently reject every keystroke while the panel went on
 * rendering live-looking inputs full of the right values.
 *
 * `codeProps` names only the props that genuinely have no writable target: a
 * resolved expression (`title={c.sheetTitle}` — writing there would replace the
 * binding with a baked string), a structured or JSX value with no scalar source
 * form (`actions={[…]}`, `icon={<Icon/>}`), and — on a `.map` row, which has no
 * isolated source location — everything except a text that resolved to its own
 * string literal elsewhere.
 */
/**
 * The only two fields these rules read. Deliberately structural rather than
 * `PageNode`: the same question is asked of a Visual Component's nodes and of the
 * `BaseNode` the canvas inspector resolves, and none of them should need a cast
 * to ask it.
 */
export interface SourceWritableNode {
  lockReason?: string
  codeProps?: string[]
}

/** The `codeProps` entry naming an inline-style property. */
export function styleValueKey(property: string): string {
  return `style:${property}`
}

/**
 * True when this node came from imported source at all. A CMS node (nanoid id,
 * no `codeProps`) is not source-backed, and these rules must not narrow what the
 * ordinary editor can do to it.
 */
function isSourceBackedNode(node: SourceWritableNode): boolean {
  return node.lockReason !== undefined || node.codeProps !== undefined
}

/** True when `prop`'s value can be written back to source. */
export function isPropWritableToSource(node: SourceWritableNode, prop: string): boolean {
  if (!isSourceBackedNode(node)) return true
  return !(node.codeProps ?? []).includes(prop)
}

/** True when `property`'s inline-style value can be written back to source. */
export function isStyleWritableToSource(node: SourceWritableNode, property: string): boolean {
  return isPropWritableToSource(node, styleValueKey(property))
}

/**
 * True when EVERY key in `patch` is writable.
 *
 * All-or-nothing on purpose. A patch carrying both an editable `title` and a
 * code-valued `className` has no honest target for its second half, and a
 * half-applied patch is a canvas that disagrees with the file it claims to
 * mirror. Refusing the whole thing keeps the two in step.
 */
export function isPropPatchWritableToSource(node: SourceWritableNode, patch: Record<string, unknown>): boolean {
  if (!isSourceBackedNode(node)) return true
  const code = new Set(node.codeProps ?? [])
  return Object.keys(patch).every((key) => !code.has(key))
}

/** `isPropPatchWritableToSource` for an inline-style patch. */
export function isStylePatchWritableToSource(node: SourceWritableNode, patch: Record<string, unknown>): boolean {
  if (!isSourceBackedNode(node)) return true
  const code = new Set(node.codeProps ?? [])
  return Object.keys(patch).every((key) => !code.has(styleValueKey(key)))
}

/**
 * True when a node's whole `style=""` layer can be written back at all, based
 * only on which module owns it. `fsCodemodAdapter.saveSite`'s inline-style
 * writeback loop only ever emits a `kind:'style'` edit for a `base.*` node —
 * a `pkg.*` design-system component, an `alm.*` primitive, or a
 * `studio.instance` component ref renders its own `style=""` (if any) from
 * ITS OWN source, not the call site's, so nothing this panel writes for that
 * node has anywhere to land. This is the single predicate the offer
 * (`StyleSurface`) and the write path must agree on — see
 * docs/audits/2026-08-06/10-classes-vs-inline-styles.md finding S4, where the
 * offer had no `moduleId` check at all and every keystroke was silently
 * discarded.
 */
export function canWriteInlineStyleForModule(moduleId: string): boolean {
  return moduleId.startsWith('base.')
}
