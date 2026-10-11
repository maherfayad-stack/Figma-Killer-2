/**
 * Architecture gate (G-11): every refusal is at most two lines, names ONE
 * remedy, and the number of distinct refusal reasons only goes down.
 *
 * A refusal is the editor keeping a promise: it would not write something it
 * could not write honestly. What the person reads next decides whether that
 * feels like a wall or like a signpost, so each one is shaped the same way:
 *
 *   1. what is true, in one plain sentence;
 *   2. the one thing to do about it, opening with a verb.
 *
 * Measured on the source, not by calling every refusal path (that would need a
 * fixture project per branch), over every file that writes a refusal a gesture
 * or an edit can meet: the AST and CSS codemods, the structural-refusal
 * vocabulary in `@core/page-tree`, the Studio writeback handlers, and the
 * client's own refusals and warning toasts. `helpers/refusalSentences.ts` holds
 * the reader and the exact rule (`copyViolation`).
 *
 * Sentences that more than one refusal says live once in
 * `src/core/utils/refusalCopy.ts`; this gate reads those too.
 *
 * `same-element` has no sentence on purpose: dropping an element on itself is a
 * no-op, so nothing is written, nothing is said.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { listRowRefusalMessage } from '../../core/page-tree/listRowSource'
import { outOfScopeMessage } from '../../core/utils/refusalCopy'
import {
  copyViolation,
  readReasonCodes,
  readRefusalSentences,
  readSentenceLiterals,
  stringConstantsOf,
} from './helpers/refusalSentences'
import { readSource, REPO_ROOT, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

/** Files whose `{ reason, message }` / `refuse(…)` / warning-toast shapes are all refusals. */
const STRUCTURED_FILES: readonly RegExp[] = [
  /^src\/core\/ast-codemods\/[^/]+\.ts$/,
  /^src\/core\/css-codemods\/[^/]+\.ts$/,
  /^src\/core\/page-tree\/[^/]+\.ts$/,
  /^src\/core\/utils\/(?:htmlContentModel|refusalCopy)\.ts$/,
  /^src\/core\/vector\/svgAttributeWrites\.ts$/,
  /^server\/handlers\/studio(?:CssWriteback|Structural[A-Za-z]*|Insert[A-Za-z]*|PastedHtmlGuard|SvgWriteback|UnrollWriteback|CanvasLayerWriteback|EditApply|EditRefusals|BatchUndoJournal)\.ts$/,
  /^server\/handlers\/studio\/(?:undoJournal|variantEditPlan|extractComponent)\.ts$/,
  /^src\/admin\/pages\/site\/(?!agent\/).+\.tsx?$/,
]

/**
 * Files that build their refusal text through helpers, `const`s and records, where the
 * structured reader cannot see it: every sentence-like literal in them is read too.
 */
const SENTENCE_FILES: readonly string[] = [
  'server/handlers/studioEditRefusals.ts',
  'server/handlers/studioPastedHtmlGuard.ts',
  'src/admin/pages/site/canvas/BoardVectorLayer/vectorEditEntry.ts',
  'src/admin/pages/site/canvas/BoardVectorLayer/vectorEditParts.ts',
  'src/admin/pages/site/canvas/canvasDropIntake.ts',
  'src/admin/pages/site/canvas/canvasFileDrop.ts',
  'src/admin/pages/site/canvas/canvasFrameSelection.ts',
  'src/admin/pages/site/canvas/canvasFrameSelectionPlan.ts',
  'src/admin/pages/site/canvas/copyAsPngTarget.ts',
  'src/admin/pages/site/canvas/ignoreAutoLayoutMeasure.ts',
  'src/admin/pages/site/canvas/layoutConversion.ts',
  'src/admin/pages/site/canvas/useCanvasFileDrop.ts',
  'src/admin/pages/site/canvas/useCanvasNodeArrowKeys.ts',
  'src/admin/pages/site/inspector/sections/vectorPaintModel.ts',
  'src/admin/pages/site/store/slices/site/ignoreAutoLayoutPlan.ts',
  'src/admin/pages/site/store/slices/site/importedNodesActions.ts',
  'src/admin/pages/site/store/slices/site/layoutConversionPlan.ts',
  'src/admin/pages/site/store/slices/site/studioPasteWrites.ts',
  'src/admin/pages/site/store/slices/site/studioSourceRefusals.ts',
  'src/admin/pages/site/studio/htmlToJsx.ts',
  'src/admin/pages/site/studio/svgImportStyles.ts',
  'src/admin/pages/site/studio/svgToJsxNode.ts',
  'src/admin/pages/site/studio/textStylePlan.ts',
  'src/core/ast-codemods/editListItems.ts',
  'src/core/ast-codemods/frameJsxElements.ts',
  'src/core/ast-codemods/jsxClassTokens.ts',
  'src/core/ast-codemods/jsxSubtree.ts',
  'src/core/ast-codemods/setJsxProp.ts',
  'src/core/ast-codemods/setJsxStyle.ts',
  'src/core/ast-codemods/transplantBindings.ts',
  'src/core/ast-codemods/transplantCarry.ts',
  'src/core/ast-codemods/transplantJsxElement.ts',
  'src/core/ast-codemods/transplantPropBake.ts',
  'src/core/ast-codemods/transplantScopeCarry.ts',
  'src/core/ast-codemods/transplantStateCarry.ts',
  'src/core/css-codemods/classifyStylesheetEditability.ts',
  'src/core/css-codemods/customProperty.ts',
  'src/core/page-tree/editConstraint.ts',
  'src/core/page-tree/listRowPlans.ts',
  'src/core/page-tree/listRowSource.ts',
  'src/core/page-tree/sourceStructure.ts',
  'src/core/page-tree/sourceStructurePreview.ts',
  'src/core/page-tree/sourceStructureTransplant.ts',
  'src/core/page-tree/structuralConstraint.ts',
  'src/core/utils/htmlContentModel.ts',
]

/**
 * Files whose refusals G-2b (`feat/instance-class-overrides`: class-bound style and
 * spread-forwarding components through "expose as a prop") is still rewriting. They
 * keep the sentences they had; the merge of that branch rewrites them in the same
 * two-line shape and EMPTIES this list. Nothing else is exempt.
 */
const PENDING_G2B: ReadonlySet<string> = new Set([
  'src/core/ast-codemods/exposeFedProp.ts',
  'src/core/ast-codemods/exposeLiteralAsProp.ts',
  'src/core/ast-codemods/exposeLiteralSites.ts',
  'src/core/ast-codemods/exposeThroughLevels.ts',
  'src/core/ast-codemods/promoteOverrideToDefault.ts',
])

/**
 * The most distinct refusal reasons the codebase may carry. It was 90 in the
 * 2026-09-23 audit; G-1 to G-10 turned most of them into writes. Lower it when
 * you delete a reason; a new one has to be argued for in `docs/programs/refusals.md`.
 */
const REFUSAL_REASON_BUDGET = 150

const SHARED = 'src/core/utils/refusalCopy.ts'

function sourceFiles(): string[] {
  return [...walkSourceTree(join(REPO_ROOT, 'src')), ...walkSourceTree(join(REPO_ROOT, 'server'))]
    .map(toRepoRelativePosix)
    .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel))
}

describe('refusal copy (G-11)', () => {
  const all = sourceFiles()
  const structured = all.filter((rel) => STRUCTURED_FILES.some((pattern) => pattern.test(rel)))
  const judged = structured.filter((rel) => !PENDING_G2B.has(rel))
  const shared = stringConstantsOf(SHARED, readSource(join(REPO_ROOT, SHARED)))
  const sentences = [
    ...judged.flatMap((rel) => {
      const source = readSource(join(REPO_ROOT, rel))
      const read = readRefusalSentences(rel, source, shared)
      const extra = SENTENCE_FILES.includes(rel) ? readSentenceLiterals(rel, source, new Set(read.map((s) => s.line))) : []
      return [...read, ...extra]
    }),
    ...[...shared].map(([name, text]) => ({ file: SHARED, line: 0, reason: name, text, remedyIsAction: false })),
  ]

  it('reads refusals from the files it names (a scan of nothing passes forever)', () => {
    expect(structured.length).toBeGreaterThan(300)
    expect(sentences.length).toBeGreaterThan(400)
    for (const rel of SENTENCE_FILES) expect(all, `${rel} is listed in SENTENCE_FILES but does not exist`).toContain(rel)
    for (const rel of PENDING_G2B) expect(all, `${rel} is listed in PENDING_G2B but does not exist`).toContain(rel)
  })

  it('every refusal sentence is at most two lines and carries one remedy', () => {
    const offenders = sentences
      .map((s) => ({ s, why: copyViolation(s.text, { remedyIsAction: s.remedyIsAction === true }) }))
      .filter((entry) => entry.why !== null)
      .map(({ s, why }) => `${s.file}:${s.line} [${s.reason}] ${why}\n      ${s.text}`)
    expect(offenders, `Rewrite these as: what is true. What to do.\n${offenders.join('\n')}`).toEqual([])
  })

  it('the sentences built by helpers keep the rule too', () => {
    const built = [
      outOfScopeMessage(['value']),
      outOfScopeMessage(['value', 'other']),
      listRowRefusalMessage({ id: 'src/App.tsx:1:1' }, false),
      listRowRefusalMessage({ id: 'src/App.tsx:1:1', listRow: { kind: 'array', source: 'ITEMS' } as never }, false),
      ...(['imported', 'computed', 'prop', 'spread', 'nested', 'multi-root'] as const).map((reason) =>
        listRowRefusalMessage({ id: 'src/App.tsx:1:1', listRow: { kind: 'refused', reason, source: 'ITEMS' } as never }, false),
      ),
    ]
    const offenders = built.map((text) => ({ text, why: copyViolation(text) })).filter((entry) => entry.why !== null)
    expect(offenders).toEqual([])
  })

  it('same-element stays silent: no refusal carries that reason', () => {
    expect(sentences.filter((s) => s.reason === 'same-element')).toEqual([])
  })

  it('the number of distinct refusal reasons only goes down', () => {
    const codes = new Set<string>()
    for (const rel of structured) for (const code of readReasonCodes(rel, readSource(join(REPO_ROOT, rel)))) codes.add(code)
    expect(codes.size, `Reasons: ${[...codes].sort().join(', ')}`).toBeLessThanOrEqual(REFUSAL_REASON_BUDGET)
  })
})
