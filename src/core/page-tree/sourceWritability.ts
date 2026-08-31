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
  /**
   * Per-prop resolution, read for one thing only: an `origin`, which LIFTS the
   * `codeProps` refusal for that prop. See {@link isPropWritableToSource}.
   */
  resolvedProps?: Record<string, { origin?: { rel: string; line: number; col: number } }>
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

/**
 * True when `prop`'s value can be written back to source.
 *
 * A `codeProps` entry means the JSX attribute is an EXPRESSION, so the call
 * site is not a writeback target — baking a literal over `title={t.home.x}`
 * would destroy the binding. That is the whole rule, and for most expressions
 * it is the end of it.
 *
 * The exception is an expression the evaluator followed all the way down to a
 * single string literal inside the workspace, which it records as
 * `resolvedProps[prop].origin`. Then there IS an honest target — not the JSX,
 * but the literal one hop away — and refusing the edit is wrong: it tells a
 * user that copy they can see on the canvas is uneditable when the string
 * behind it is an ordinary source string. `PageNode.textOrigin` has made
 * exactly this trade for a node's TEXT since parser-05; this is the same trade
 * per prop, which is what an i18n'd design-system component needs (`title`,
 * `subtitle` and `actionLabel` are all expressions on one `<MarketingCard>`).
 *
 * The write path must honour the distinction — `fsCodemodAdapter.saveSite`
 * emits a `kind: 'literal'` edit aimed at the origin for these, never a
 * `kind: 'prop'` at the call site. If that branch is ever removed, this
 * predicate starts authorising exactly the destructive write it exists to
 * prevent.
 *
 * ## Two deliberate limits
 *
 * **Inline styles are excluded.** A `style:<property>` entry resolves through
 * a module-scope const far more often than through a per-element string
 * (`color: ACCENT`), and editing one element's colour in the inspector must
 * not silently repaint every other element reading that same const. Styles
 * also already have their own editing surface (`StyleSurface`'s class
 * workflow) that does not need this.
 *
 * **A shared literal is edited everywhere it is used**, and that is inherent,
 * not a bug to fix here: two call sites reading `t.home.bookATransfer` share
 * one string, so changing it changes both. For a DICTIONARY that is exactly
 * what the user means — it is what a dictionary is for. The panel should say
 * where the edit lands rather than pretend the edit is local; that affordance
 * is not built yet.
 */
export function isPropWritableToSource(node: SourceWritableNode, prop: string): boolean {
  if (!isSourceBackedNode(node)) return true
  if (!(node.codeProps ?? []).includes(prop)) return true
  // Inline styles keep the strict rule — see the doc above.
  if (prop.startsWith('style:')) return false
  return node.resolvedProps?.[prop]?.origin !== undefined
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
  return Object.keys(patch).every((key) => isPropWritableToSource(node, key))
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
