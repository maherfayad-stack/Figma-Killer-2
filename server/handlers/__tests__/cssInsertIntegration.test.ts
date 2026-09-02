/**
 * cssInsertIntegration — Track B1's end-to-end proof, not two isolated unit
 * tests that happen to compile. Three defects have shipped in this codebase
 * where a client-side half and a server-side half were each individually
 * correct and fully tested, with nothing actually connecting them (a codemod
 * nothing invokes, in CLAUDE.md's own phrasing). This file runs the REAL
 * client function (`collectStyleRuleEdits`, `@site/studio/styleRuleWriteback`
 * — what `ClassPicker`'s "create class" flow feeds into on autosave) through
 * the REAL server dispatcher (`applyStudioEditBatch`, `../studioWriteback` —
 * what `POST /admin/api/studio/save` runs) against a real temp file on disk.
 *
 * Two things this proves that neither side's own unit tests can:
 *
 *   1. A brand-new class with no `styleRuleSources` entry — exactly what
 *      `ClassPicker`'s `createClass()` produces — resolves a destination,
 *      emits a real `kind: 'css', op: 'insert'` edit, and that edit actually
 *      creates the rule in the file on disk.
 *   2. `commitBaseline`'s Track B1 source synthesis (called after the same
 *      save round trip `fsCodemodAdapter.saveSite` completes) makes the SAME
 *      rule editable through the ordinary `set` path on its very next edit —
 *      with no reload — and that edit ALSO actually reaches the same file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { StyleRule } from '@core/page-tree'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  commitBaseline,
  getStudioStyleRuleSources,
  recordCreatedStylesheet,
  ruleIdFromCssCreateNodeId,
  setStudioStyleRuleSources,
} from '@site/studio/styleRuleWriteback'
import { applyStudioEditBatch } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-css-insert-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
}

const EXISTING_RULE_ID = 'sc-existing'
const NEW_CLASS_ID = 'nanoid-brand-new-class'

function existingRule(): StyleRule {
  return {
    id: EXISTING_RULE_ID,
    kind: 'class',
    name: 'existing',
    selector: '.existing',
    styles: { color: 'black' },
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  } as StyleRule
}

function newClassRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: NEW_CLASS_ID,
    kind: 'class',
    name: 'brand-new',
    selector: '.brand-new',
    styles: {},
    contextStyles: {},
    order: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

describe('Track B1 integration — a class created in the editor reaches disk end to end', () => {
  it('createClass -> collectStyleRuleEdits -> applyStudioEditBatch actually writes the new rule to the real .css file', () => {
    write('src/screens/Home.css', '.existing {\n  color: black;\n}\n')

    // The load-time state ClassPicker's session starts from: ONE known,
    // hand-editable stylesheet, exactly what studioCss.ts ships after a real
    // project load with a single global stylesheet.
    setStudioStyleRuleSources(
      { [EXISTING_RULE_ID]: { file: 'src/screens/Home.css', selector: '.existing' } },
      { [EXISTING_RULE_ID]: existingRule() },
    )

    // The user clicks "New class" (ClassPicker -> store's createClass()) and
    // types two declarations into the Style panel — both land in
    // contextStyles.studio, exactly like every other canvas style edit.
    const styled = newClassRule({
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue', display: 'flex' } },
    })

    const plan = collectStyleRuleEdits({ [EXISTING_RULE_ID]: existingRule(), [NEW_CLASS_ID]: styled })

    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'insert',
      file: 'src/screens/Home.css',
      selector: '.brand-new',
      declarations: { color: 'blue', display: 'flex' },
    })

    // Exactly the batch fsCodemodAdapter.saveSite POSTs to /admin/api/studio/save.
    const result = applyStudioEditBatch(tmpDir, plan.edits)

    expect(result.written).toBe(1)
    expect(result.refusals).toHaveLength(0)
    // The EXISTING rule is untouched, and the new rule is a real block in
    // the real file — not a mock, not an assertion on an intermediate object.
    expect(read('src/screens/Home.css')).toBe(
      '.existing {\n  color: black;\n}\n\n.brand-new {\n  color: blue;\n  display: flex;\n}\n',
    )

    // fsCodemodAdapter.saveSite calls commitStyleRuleBaseline (= commitBaseline)
    // ONLY after this exact round trip succeeds — see that module's doc.
    commitBaseline({ [EXISTING_RULE_ID]: existingRule(), [NEW_CLASS_ID]: styled })

    // Requirement 4 — synthesized WITHOUT a reload: the client now believes
    // this rule has a real source, pointing at the file the insert actually landed in.
    expect(getStudioStyleRuleSources()[NEW_CLASS_ID]).toEqual({
      file: 'src/screens/Home.css',
      selector: '.brand-new',
    })

    // The user changes ONE property on the same class. No reload happened —
    // this is the SAME in-memory session, same module state.
    const restyled = newClassRule({
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red', display: 'flex' } },
    })
    const secondPlan = collectStyleRuleEdits({ [EXISTING_RULE_ID]: existingRule(), [NEW_CLASS_ID]: restyled })

    // A worse bug than never writing: a rule that inserts once and then
    // falls back to `unmapped` on its very next edit. Assert the opposite.
    expect(secondPlan.unmapped).toEqual([])
    expect(secondPlan.edits).toHaveLength(1)
    expect(secondPlan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'set',
      file: 'src/screens/Home.css',
      selector: '.brand-new',
      property: 'color',
      value: 'red',
    })

    const secondResult = applyStudioEditBatch(tmpDir, secondPlan.edits)
    expect(secondResult.written).toBe(1)
    expect(secondResult.refusals).toHaveLength(0)
    expect(read('src/screens/Home.css')).toBe(
      '.existing {\n  color: black;\n}\n\n.brand-new {\n  color: red;\n  display: flex;\n}\n',
    )
  })

  it('refuses honestly, with no write and no fabricated source, when zero stylesheets are known', () => {
    setStudioStyleRuleSources({}, {})
    const styled = newClassRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } } })

    const plan = collectStyleRuleEdits({ [NEW_CLASS_ID]: styled })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped[0]).toContain('.brand-new')
    expect(plan.unmapped[0]).toContain('could not find a hand-editable .css file')

    // Nothing to send — applying an empty batch is a no-op, proving there is
    // no silent write happening anywhere in this path.
    const result = applyStudioEditBatch(tmpDir, plan.edits)
    expect(result.written).toBe(0)

    commitBaseline({ [NEW_CLASS_ID]: styled })
    expect(getStudioStyleRuleSources()[NEW_CLASS_ID]).toBeUndefined()
  })

  it('refuses honestly, naming both candidates, when the destination is ambiguous', () => {
    write('src/screens/A.css', '.a {\n  color: red;\n}\n')
    write('src/screens/B.css', '.b {\n  color: red;\n}\n')
    setStudioStyleRuleSources(
      {
        a: { file: 'src/screens/A.css', selector: '.a' },
        b: { file: 'src/screens/B.css', selector: '.b' },
      },
      {},
    )
    const styled = newClassRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } } })

    const plan = collectStyleRuleEdits({ [NEW_CLASS_ID]: styled })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped[0]).toContain('src/screens/A.css')
    expect(plan.unmapped[0]).toContain('src/screens/B.css')
    // Neither file is touched — an ambiguous destination is a refusal, never a guess.
    expect(read('src/screens/A.css')).toBe('.a {\n  color: red;\n}\n')
    expect(read('src/screens/B.css')).toBe('.b {\n  color: red;\n}\n')
  })
})

/**
 * The middle branch B1 deferred (§6 of its own handoff, now landed): zero
 * editable stylesheets exist anywhere, but the rule names a real page
 * (`scope.nodeId`, `ensureNodeStyleClass`'s per-element auto-class) —
 * `resolveCssInsertDestination` offers `kind: 'create'`, and the SERVER
 * invents a co-located stylesheet, wires the page's `import`, and writes the
 * rule. Same "real client function through the real server dispatcher
 * against a real temp file" discipline as the block above.
 */
describe('Track B1 integration — create branch: zero stylesheets, but a real page to co-locate one with', () => {
  it('creates a co-located plain .css, wires the import, writes the rule, and is editable next without a reload', () => {
    write('src/pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    setStudioStyleRuleSources({}, {})

    const styled = newClassRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:2:10', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue', display: 'flex' } },
    })

    const plan = collectStyleRuleEdits({ [NEW_CLASS_ID]: styled })
    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'create',
      pageFile: 'src/pages/Home.tsx',
      selector: '.brand-new',
      declarations: { color: 'blue', display: 'flex' },
    })

    const result = applyStudioEditBatch(tmpDir, plan.edits)

    expect(result.written).toBe(1)
    expect(result.refusals).toHaveLength(0)
    // Requirement 3 — the caller can see WHICH file was chosen, never silent.
    expect(result.createdStylesheets).toEqual([{ nodeId: plan.edits[0]!.nodeId, file: 'src/pages/Home.css' }])
    // A brand-new project with no stylesheet signal anywhere defaults to a
    // plain .css — it needs no JS binding, so it's the lower-risk choice
    // when nothing in the project says otherwise.
    expect(read('src/pages/Home.css')).toBe('.brand-new {\n  color: blue;\n  display: flex;\n}')
    // The page's own source now imports it, side-effect only (matches the
    // plain-.css convention — no default binding to leave dangling).
    expect(read('src/pages/Home.tsx')).toBe(
      "import './Home.css';\n\nexport default function Home() {\n  return <div>Hi</div>\n}\n",
    )
    // The line-count shift from adding the import is reported (every node
    // id in this page below the import is now stale) — `applyStudioEditBatch`
    // is expected to notice this even though a `css`/`create` edit's own
    // nodeId never decodes to a location.
    expect(result.shifted).toBe(true)

    // `commitBaseline` (the ordinary post-save hook) must NOT fabricate a
    // source for a `create` destination — it doesn't know the server's
    // choice yet.
    commitBaseline({ [NEW_CLASS_ID]: styled })
    expect(getStudioStyleRuleSources()[NEW_CLASS_ID]).toBeUndefined()

    // `notifyCreatedStylesheets`'s real behaviour: decode the response back
    // to a rule id, and record the mapping.
    const created = result.createdStylesheets[0]!
    const ruleId = ruleIdFromCssCreateNodeId(created.nodeId)
    expect(ruleId).toBe(NEW_CLASS_ID)
    recordCreatedStylesheet(ruleId!, created.file, '.brand-new')
    expect(getStudioStyleRuleSources()[NEW_CLASS_ID]).toEqual({ file: 'src/pages/Home.css', selector: '.brand-new' })

    // Requirement — editable on the NEXT edit, with NO reload: the second
    // diff now takes the ordinary `set` path, in the same in-memory session.
    const restyled = newClassRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:2:10', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red', display: 'flex' } },
    })
    const secondPlan = collectStyleRuleEdits({ [NEW_CLASS_ID]: restyled })
    expect(secondPlan.edits).toHaveLength(1)
    expect(secondPlan.edits[0]).toMatchObject({
      op: 'set',
      file: 'src/pages/Home.css',
      selector: '.brand-new',
      property: 'color',
      value: 'red',
    })

    const secondResult = applyStudioEditBatch(tmpDir, secondPlan.edits)
    expect(secondResult.written).toBe(1)
    expect(read('src/pages/Home.css')).toBe('.brand-new {\n  color: red;\n  display: flex;\n}')
    // The second edit is an ordinary `set`, which never touches the page
    // file's import list — no further shift.
    expect(secondResult.shifted).toBe(false)
  })

  it('detects a CSS-Modules-leaning project and creates a .module.css with a default-import binding', () => {
    // No editable rule sources anywhere (still the zero-candidate case), but
    // the WORKSPACE itself already leans on CSS Modules elsewhere.
    write('src/pages/Other.module.css', '.other {\n  color: green;\n}\n')
    write('src/pages/Another.module.css', '.another {\n  color: green;\n}\n')
    write('src/pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    setStudioStyleRuleSources({}, {})

    const styled = newClassRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:2:10', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } },
    })
    const plan = collectStyleRuleEdits({ [NEW_CLASS_ID]: styled })

    const result = applyStudioEditBatch(tmpDir, plan.edits)

    expect(result.written).toBe(1)
    expect(result.createdStylesheets).toEqual([{ nodeId: plan.edits[0]!.nodeId, file: 'src/pages/Home.module.css' }])
    expect(read('src/pages/Home.module.css')).toBe('.brand-new {\n  color: blue;\n}')
    // A `.module.css` class is reachable ONLY through a default-import
    // binding — never a bare side-effect import, which would render as
    // nothing (Requirement 4).
    expect(read('src/pages/Home.tsx')).toContain("import styles from './Home.module.css'")
  })

  it('refuses rather than write an unreachable class when an existing import has the wrong shape for the convention', () => {
    // Bias convention detection to 'module' the same way as above…
    write('src/pages/Other.module.css', '.other {\n  color: green;\n}\n')
    write('src/pages/Another.module.css', '.another {\n  color: green;\n}\n')
    // …but the page ALREADY imports its co-located stylesheet side-effect
    // only (no binding) — writing declarations into a `.module.css` behind
    // that import would produce a class nothing in the JSX could reach.
    write(
      'src/pages/Home.tsx',
      "import './Home.module.css'\nexport default function Home() {\n  return <div>Hi</div>\n}\n",
    )
    setStudioStyleRuleSources({}, {})

    const styled = newClassRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:2:10', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } },
    })
    const plan = collectStyleRuleEdits({ [NEW_CLASS_ID]: styled })

    const result = applyStudioEditBatch(tmpDir, plan.edits)

    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'stylesheet-import-shape-mismatch' })
    // Refused BEFORE a byte was written — no stylesheet was fabricated, and
    // the page's existing (wrong-shaped) import is untouched.
    expect(fs.existsSync(path.join(tmpDir, 'src/pages/Home.module.css'))).toBe(false)
    expect(read('src/pages/Home.tsx')).toBe(
      "import './Home.module.css'\nexport default function Home() {\n  return <div>Hi</div>\n}\n",
    )
  })

  it('refuses (no write) when the page path escapes the workspace — a hand-crafted edit, not a real client output', () => {
    write('src/pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')

    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'css',
        op: 'create',
        nodeId: 'css:create:evil',
        pageFile: '../outside.tsx',
        selector: '.evil',
        declarations: { color: 'red' },
      },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(0) // not a NAMED refusal — an attack, not a sentence to show a user
    expect(result.createdStylesheets).toHaveLength(0)
    expect(fs.existsSync(path.join(path.dirname(tmpDir), 'outside.css'))).toBe(false)
  })

  it('refuses (no write) when the page path does not exist — a project layout with nowhere to place a file', () => {
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'css',
        op: 'create',
        nodeId: 'css:create:ghost',
        pageFile: 'src/pages/DoesNotExist.tsx',
        selector: '.ghost',
        declarations: { color: 'red' },
      },
    ])

    expect(result.written).toBe(0)
    expect(result.createdStylesheets).toHaveLength(0)
    expect(fs.existsSync(path.join(tmpDir, 'src/pages/DoesNotExist.css'))).toBe(false)
  })
})
