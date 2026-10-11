/**
 * studioClassEditSchema - the wire shape of the `class` studio edit
 * (`setJsxClassName`), split out of `studioEditSchemas.ts` (module-size ceiling)
 * along the one boundary it has: nothing here depends on any other edit kind.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One `className` token add/remove writeback (Track B2) — `setJsxClassName`.
 * Replaces Phase 0 item 0.6's honesty-only stopgap: a `node.classIds` change
 * now reaches disk here instead of only ever warning that it couldn't.
 *
 * `add`/`remove` carry TOKENS, never `StyleRule` ids — the ids are Studio's own
 * `sc-<hash>` bookkeeping. Two token shapes, because two kinds of class exist
 * in a real repo (`style-02`):
 *
 *   - `{ kind: 'literal', token }` — a class whose NAME is what the DOM
 *     carries: a plain `.css` rule, a Tailwind utility, a generated framework
 *     class. Written as a plain token in the `className` attribute.
 *   - `{ kind: 'module', file, local }` — a class declared in a CSS Module.
 *     Its DOM name is a bundler-computed hash, so writing any literal name for
 *     it produces markup that styles nothing outside the tool that computed
 *     that hash. `file` is the workspace-relative `*.module.css` path (guarded
 *     by `studioWriteback.ts`'s `resolveClassNameTokens` before it is ever
 *     turned into a specifier) and `local` is the class as WRITTEN in that file, so the
 *     codemod can emit the only reachable spelling: `styles.<local>`.
 *
 * Can REFUSE with a specific reason (`css-module-binding` /
 * `template-dynamic` / `spread-attribute` / `unsupported-call` /
 * `unsupported-expression` — `ClassNameRefusalReason` in `@core/ast-codemods`)
 * exactly like `detach`/`swap`/`css` do — see `applyStudioEdit`'s `'class'`
 * case. Since P3-C (WB-18) an ADD to an expression `className` wraps it rather
 * than refusing, and a module token whose stylesheet the file does not import
 * yet is imported after the batch (`cssModuleImportPlan.ts`), so through this
 * schema `css-module-import-missing` no longer occurs.
 */
const ClassNameTokenSchema = Type.Union([
  Type.Object({ kind: Type.Literal('literal'), token: Type.String() }),
  Type.Object({ kind: Type.Literal('module'), file: Type.String(), local: Type.String() }),
])

/** One class token on the wire — `literal` or `module`. See `ClassEditSchema`. */
export type StudioClassNameToken = Static<typeof ClassNameTokenSchema>

export const ClassEditSchema = Type.Object({
  kind: Type.Literal('class'),
  nodeId: Type.String(),
  add: Type.Array(ClassNameTokenSchema),
  remove: Type.Array(ClassNameTokenSchema),
  /**
   * CT-5 - this class edit belongs to a restyle gesture (apply, create or detach
   * a text/effect style): the Inspector's style picker posts it together with the
   * `css` insert and the inline `style` strip/set the gesture needs. It asks for
   * two things no plain class edit gets: the batch is journaled (one `restore`
   * puts back every file it changed, a created stylesheet included) and it is
   * ALL OR NOTHING - if any edit in the batch refuses, every file goes back to
   * the bytes it had and nothing is written. A half-applied restyle (the inline
   * values stripped, the class refused) is a layer that changed look.
   * The Variables panel's apply-a-theme-class (CT-6) posts it too, alone. See
   * `studioBatchUndoJournal.ts`.
   */
  restyle: Type.Optional(Type.Literal(true)),
})

