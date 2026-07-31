/**
 * parser-06 — stop stacking every branch of a multi-return component.
 *
 * The predecessor policy (see git history) rendered EVERY `return` in a
 * component, stacked and locked — reasoned as "the same rule a ternary
 * already gets one level down". That was a real, measured visual defect: a
 * card with a loading state, an empty state, and a loaded state rendered all
 * three, in a column, on every screen that used it — never what a user
 * actually sees (`STATE.md`'s `parser-06` entry has the before/after count
 * against the real eSIM corpus).
 *
 * The new policy: the parser SELECTS one branch — the LAST JSX-bearing
 * `return` (guard clauses are early returns; the one that survives every
 * guard is the "normal" content) — walks only that one into real nodes
 * (unlocked: the structure at that location is completely ordinary), and
 * records what it did NOT choose as a `BranchAlternative` (a label + source
 * location, never a materialized subtree) on the chosen node. Nothing is
 * EVALUATED to make this choice — no `loading`/`stage` variable is ever
 * read — so this stays outside the banned Tier D exactly as Tier A/B/C do:
 * see `docs/features/studio-import.md`.
 *
 * A ternary or `&&` inside JSX gets the identical treatment one level down
 * (`selectJsxBranch` in `parsePageFile.ts`), UNLESS the evaluator can
 * actually resolve the condition (a literal, a module-scope const) — that
 * real answer always outranks the "prefer the first-written branch"
 * heuristic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  parsePageFile,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-return-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

function load(pageRel: string): { rootIds: string[]; nodes: ParsedNode[] } {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(file, tmpDir, project, evalOptions())
  return { rootIds: parsed.rootIds, nodes: Object.values(parsed.nodes) }
}

const names = (nodes: ParsedNode[]): string[] => nodes.map((n) => n.name)

describe('components with more than one return', () => {
  it('chooses the LAST branch, unlocked, and records the rest as alternatives', () => {
    write(
      'pages/Addon.jsx',
      [
        'export default function Addon({ type }) {',
        '  if (type === "ring") {',
        '    return <div className="ring"><svg viewBox="0 0 40 40" /></div>',
        '  }',
        '  return <img src="/chip.png" alt="" />',
        '}',
        '',
      ].join('\n'),
    )

    const { rootIds, nodes } = load('pages/Addon.jsx')
    // Only the chosen (last) branch is walked into real nodes — the "ring"
    // branch's <div>/<svg> are never materialized at all.
    expect(names(nodes)).toEqual(['img'])
    expect(rootIds).toHaveLength(1)

    const img = nodes.find((n) => n.name === 'img')!
    expect(img.locked).toBe(false)
    expect(img.lockReason).toBeUndefined()
    expect(img.resolution?.note).toContain('ring')
    expect(img.branchAlternatives).toHaveLength(1)
    expect(img.branchAlternatives?.[0]!.label).toBe('type === "ring"')
    expect(img.branchAlternatives?.[0]!.loc.line).toBe(3)
  })

  it('picks the LAST of three+ branches and names every alternative', () => {
    write(
      'pages/Stages.jsx',
      [
        'export default function Stages({ stage }) {',
        '  if (stage === "loading") return <div className="loading">Loading…</div>',
        '  if (!stage) return <div className="empty">Nothing yet</div>',
        '  return <section><h1>Done</h1></section>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Stages.jsx')
    expect(names(nodes).sort()).toEqual(['h1', 'section'])
    const section = nodes.find((n) => n.name === 'section')!
    expect(section.locked).toBe(false)
    const labels = (section.branchAlternatives ?? []).map((a) => a.label)
    expect(labels).toEqual(['stage === "loading"', '!stage'])
  })

  it('leaves a single-return component completely unlocked, with no alternatives', () => {
    write(
      'pages/Plain.jsx',
      [
        'export default function Plain() {',
        '  return <div className="plain"><p>Hi</p></div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Plain.jsx')
    expect(nodes.every((n) => !n.locked)).toBe(true)
    expect(nodes.every((n) => !n.branchAlternatives)).toBe(true)
  })

  it('does not let a `return null` guard lock the real tree', () => {
    write(
      'pages/Guarded.jsx',
      [
        'export default function Guarded({ data }) {',
        '  if (!data) return null',
        '  return <div className="real"><p>Content</p></div>',
        '}',
        '',
      ].join('\n'),
    )

    // `return null` contributes no nodes, so it is not a branch anyone can see —
    // counting it would lock an entire editable screen for a guard clause.
    const { rootIds, nodes } = load('pages/Guarded.jsx')
    expect(rootIds).toHaveLength(1)
    expect(nodes.every((n) => !n.locked)).toBe(true)
    expect(nodes.every((n) => !n.branchAlternatives)).toBe(true)
  })

  it('treats a component whose ONLY return sits inside a conditional as unconditional', () => {
    // No fallback return at all — there is nothing to choose BETWEEN, so this
    // must behave exactly like the single-return case above, not like a
    // 2-branch component.
    write(
      'pages/OnlyGuarded.jsx',
      [
        'export default function OnlyGuarded({ ok }) {',
        '  if (ok) {',
        '    return <div className="ok"><p>Ready</p></div>',
        '  }',
        '}',
        '',
      ].join('\n'),
    )

    const { rootIds, nodes } = load('pages/OnlyGuarded.jsx')
    expect(rootIds).toHaveLength(1)
    expect(nodes.every((n) => !n.locked)).toBe(true)
    expect(nodes.every((n) => !n.branchAlternatives)).toBe(true)
  })

  it('ignores returns belonging to a nested callback', () => {
    write(
      'pages/List.jsx',
      [
        'const ITEMS = ["a", "b"]',
        'export default function List() {',
        '  return (',
        '    <ul>',
        '      {ITEMS.map((item) => {',
        '        return <li key={item}>{item}</li>',
        '      })}',
        '    </ul>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // The callback's `return` belongs to the callback, not the component — the
    // `<ul>` is the component's only branch and stays editable.
    const { rootIds, nodes } = load('pages/List.jsx')
    expect(rootIds).toHaveLength(1)
    expect(nodes.find((n) => n.name === 'ul')?.locked).toBe(false)
  })
})

describe('a ternary inside JSX', () => {
  it('prefers the consequent when the condition cannot be resolved, and records the alternate', () => {
    write(
      'pages/Toggle.jsx',
      [
        'export default function Toggle({ open }) {',
        '  return <div>{open ? <span className="a">A</span> : <em className="b">B</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Toggle.jsx')
    expect(names(nodes).sort()).toEqual(['div', 'span'])
    const span = nodes.find((n) => n.name === 'span')!
    expect(span.locked).toBe(false)
    expect(span.branchAlternatives).toHaveLength(1)
    expect(span.branchAlternatives?.[0]!.label).toBe('not (open)')
  })

  it('resolves a statically-known condition instead of falling back to the heuristic', () => {
    write(
      'pages/StaticToggle.jsx',
      [
        'const SHOW_A = false',
        'export default function StaticToggle() {',
        '  return <div>{SHOW_A ? <span className="a">A</span> : <em className="b">B</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/StaticToggle.jsx')
    // The heuristic alone would have preferred the consequent (<span>) — the
    // statically-false condition must override it and pick <em> instead.
    expect(names(nodes).sort()).toEqual(['div', 'em'])
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.locked).toBe(false)
    expect(em.resolution?.note).toContain('statically false')
    expect(em.branchAlternatives).toHaveLength(1)
  })

  it('resolves a useState(<literal>) initial value the same way — first paint, not a guess (parser-07)', () => {
    write(
      'pages/StepToggle.jsx',
      [
        'export default function StepToggle() {',
        "  const [step] = useState('summary')",
        '  return <div>{step === "summary" ? <span className="a">Summary</span> : <em className="b">Other</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // Same fix as the `&&` overlay case, shared through `evaluateCondition`'s
    // comparator path: `step`'s useState initializer is a literal in the
    // source, so `step === "summary"` is not a guess — it is genuinely known
    // at first paint.
    const { nodes } = load('pages/StepToggle.jsx')
    expect(names(nodes).sort()).toEqual(['div', 'span'])
    const span = nodes.find((n) => n.name === 'span')!
    expect(span.locked).toBe(false)
    expect(span.resolution?.note).toContain('statically true')
    expect(span.branchAlternatives).toHaveLength(1)
  })

  it('declines (falls through to ordinary dynamic locking) when neither side has JSX', () => {
    write(
      'pages/ValueTernary.jsx',
      [
        'export default function ValueTernary({ n }) {',
        '  return <div>{n > 0 ? "positive" : "non-positive"}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // A pure-value ternary reaching the structural walk (because it is not a
    // literal text-only leaf) produces no JSX child node at all — nothing to
    // assert on but that this does not throw and the wrapper stays unlocked.
    const { nodes } = load('pages/ValueTernary.jsx')
    expect(nodes.find((n) => n.name === 'div')?.locked).toBe(false)
  })
})

describe('`&&` inside JSX', () => {
  it('renders the body unlocked when the condition cannot be resolved, and records the hidden state as an alternative (parser-07)', () => {
    write(
      'pages/Banner.jsx',
      [
        'export default function Banner({ show }) {',
        '  return <div>{show && <strong className="banner">Saved</strong>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // `show` is a prop — genuinely unresolvable — so this still falls back to
    // today's "render it" behaviour. What's NEW (parser-07): the hidden state
    // is no longer silently assumed away, it is recorded as a
    // `branchAlternatives` entry a user can deliberately switch to.
    const { nodes } = load('pages/Banner.jsx')
    const strong = nodes.find((n) => n.name === 'strong')!
    expect(strong.locked).toBe(false)
    expect(strong.resolution?.note).toContain('show')
    expect(strong.branchAlternatives).toHaveLength(1)
    expect(strong.branchAlternatives?.[0]!.label).toBe('not (show)')
  })

  it('renders nothing when the condition resolves to a literal useState(false) — does not stack the overlay (parser-07)', () => {
    write(
      'pages/DataHelp.jsx',
      [
        'export default function DataHelp() {',
        '  const [showDataHelp] = useState(false)',
        '  return (',
        '    <div className="screen">',
        '      <p>Base content</p>',
        '      {showDataHelp && <aside className="help">Need help?</aside>}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // The overlay's guard reads `useState(false)` — its initial value is a
    // literal sitting right there in the source, not hook state that has to
    // run. The first paint has it hidden: no `aside` node at all, not a
    // locked-and-shown one.
    const { nodes } = load('pages/DataHelp.jsx')
    expect(nodes.find((n) => n.name === 'aside')).toBeUndefined()
    const div = nodes.find((n) => n.name === 'div')!
    expect(div.locked).toBe(false)
    expect(div.children).toHaveLength(1) // only <p>, the hidden <aside> contributes no node/id at all
  })

  it('renders the body, unlocked, with no alternative, when the condition resolves to a literal useState(true) (parser-07)', () => {
    write(
      'pages/Toast.jsx',
      [
        'export default function Toast() {',
        '  const [visible] = useState(true)',
        '  return <div>{visible && <strong className="toast">Saved</strong>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Toast.jsx')
    const strong = nodes.find((n) => n.name === 'strong')!
    expect(strong.locked).toBe(false)
    expect(strong.resolution?.note).toContain('statically true')
    expect(strong.branchAlternatives).toBeUndefined()
  })

  it('resolves a condition against a destructured prop parameter\'s own default, not just useState (parser-07)', () => {
    // Not hook state at all — a plain defaulted prop, compared directly. The
    // real corpus's `ActivationFlowScreen` gates two of its five overlays on
    // exactly this shape (`introVariant === 'onboarding'` /
    // `introVariant !== 'onboarding'`), and without this the `&&` fix alone
    // still stacks both, because neither condition resolves.
    write(
      'pages/IntroStep.jsx',
      [
        'export default function IntroStep({ introVariant = "checklist" }) {',
        '  return (',
        '    <div>',
        '      {introVariant === "onboarding" && <section className="onboarding">Carousel</section>}',
        '      {introVariant !== "onboarding" && <section className="checklist">Checklist</section>}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/IntroStep.jsx')
    const sections = nodes.filter((n) => n.name === 'section')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.props.className).toBe('checklist')
  })

  it('resolves a useState(<defaultedParam>) chain one hop into the parameter default — the real ActivationFlowScreen shape (parser-07)', () => {
    write(
      'pages/StepFlow.jsx',
      [
        'export default function StepFlow({ initialStep = "intro" }) {',
        '  const [step] = useState(initialStep)',
        '  return (',
        '    <div>',
        '      {step === "intro" && <section className="a">Intro</section>}',
        '      {step === "settings" && <section className="b">Settings</section>}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // `useState(initialStep)`'s argument is an IDENTIFIER, not a bare
    // literal — it only resolves because `initialStep` is itself a
    // defaulted parameter. This is the one-hop recursion
    // `findDefaultLiteralNode` (`defaultLiteralBindings.ts`) performs.
    const { nodes } = load('pages/StepFlow.jsx')
    const sections = nodes.filter((n) => n.name === 'section')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.props.className).toBe('a')
  })

  it('does not resolve a useState(<param>) whose parameter has NO default — stays unresolvable (parser-07)', () => {
    write(
      'pages/NoDefault.jsx',
      [
        'export default function NoDefault({ initialStep }) {',
        '  const [step] = useState(initialStep)',
        '  return <div>{step === "intro" && <strong className="a">Intro</strong>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // No default anywhere for `initialStep` to fall back to — a genuinely
    // unknown call-time value, not a bare literal in disguise. Falls back to
    // today's "cannot decide" behaviour: render it, record the alternative.
    const { nodes } = load('pages/NoDefault.jsx')
    const strong = nodes.find((n) => n.name === 'strong')!
    expect(strong.locked).toBe(false)
    expect(strong.branchAlternatives).toHaveLength(1)
  })

  it('still resolves a module-scope const condition, same as before parser-07', () => {
    write(
      'pages/Banner2.jsx',
      [
        'const SHOW_BANNER = true',
        'export default function Banner2() {',
        '  return <div>{SHOW_BANNER && <strong className="banner">Saved</strong>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Banner2.jsx')
    const strong = nodes.find((n) => n.name === 'strong')!
    expect(strong.locked).toBe(false)
    expect(strong.resolution?.note).toContain('statically true')
    expect(strong.branchAlternatives).toBeUndefined()
  })

  it('treats a setter-reassigned useState binding as unresolvable, not as its initial literal (parser-07)', () => {
    write(
      'pages/Wizard.jsx',
      [
        'export default function Wizard({ skipIntro }) {',
        '  let [flag] = useState(false)',
        '  if (skipIntro) {',
        '    flag = true',
        '  }',
        '  return <div>{flag && <strong className="skip">Skipped</strong>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // `flag` is hand-reassigned outside React's setter contract — reading its
    // literal `useState(false)` initializer would misrepresent even the first
    // paint, so this must fall back to "unresolvable", exactly like a prop.
    const { nodes } = load('pages/Wizard.jsx')
    const strong = nodes.find((n) => n.name === 'strong')!
    expect(strong.locked).toBe(false)
    expect(strong.resolution?.note).toContain('flag')
    expect(strong.resolution?.note).not.toContain('statically')
    expect(strong.branchAlternatives).toHaveLength(1)
  })

  it('still locks an unresolved `.map` nested inside `&&`', () => {
    write(
      'pages/DynamicList.jsx',
      [
        'export default function DynamicList({ show, items }) {',
        '  return <ul>{show && items.map((item) => <li key={item}>{item}</li>)}</ul>',
        '}',
        '',
      ].join('\n'),
    )

    // `items` is a prop, not a resolvable module-scope array, so the nested
    // `.map` cannot expand — it must still lock, exactly as it would if `&&`
    // were not in the way at all.
    const { nodes } = load('pages/DynamicList.jsx')
    const li = nodes.find((n) => n.name === 'li')!
    expect(li.locked).toBe(true)
    expect(li.lockReason).toBe('dynamic — rendered in code')
  })
})

/**
 * parser-07 — the two FALLBACK forms, `value || <Fallback/>` and
 * `value ?? <Fallback/>`.
 *
 * They look interchangeable and are not: `||` falls through on FALSINESS,
 * `??` only on NULLISHNESS. `{count || <Empty/>}` with `count === 0` renders
 * `<Empty/>`; `{count ?? <Empty/>}` with the same `count` renders `0`. Getting
 * that backwards shows a fallback state on a screen that has real content, so
 * the pair of `useState(0)` tests below is the load-bearing one.
 *
 * Before parser-07 neither form was a branch point at all: `||` was treated as
 * an unresolvable dynamic surface (fallback rendered LOCKED, no note, no
 * alternative) and `??` was not recognised, so ordinary descent walked BOTH
 * operands and stacked them whenever the left side was JSX.
 */
describe('a `||` / `??` fallback inside JSX', () => {
  it('renders the `||` fallback unlocked, with the truthy state recorded as an alternative', () => {
    write(
      'pages/OrUnknown.jsx',
      [
        'export default function OrUnknown({ name }) {',
        '  return <div>{name || <em className="anon">Anonymous</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // `name` is a prop with no default — genuinely undecidable. The fallback is
    // the only JSX here, so it renders, but it is an ORDINARY editable node now
    // (it used to carry DYNAMIC_LOCK_REASON), and the state where `name` wins is
    // recorded rather than silently assumed away.
    const { nodes } = load('pages/OrUnknown.jsx')
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.locked).toBe(false)
    expect(em.lockReason).toBeUndefined()
    expect(em.resolution?.note).toContain('cannot evaluate')
    expect(em.branchAlternatives).toHaveLength(1)
    expect(em.branchAlternatives?.[0]!.label).toBe('name')
  })

  it('drops the `||` fallback entirely when the left side is statically truthy', () => {
    write(
      'pages/OrTruthy.jsx',
      [
        'const NAME = "Ada"',
        'export default function OrTruthy() {',
        '  return <div>{NAME || <em className="anon">Anonymous</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // `NAME` always wins, so `<em>` is JSX the source placed at a position that
    // never paints — nothing to render, not even locked.
    const { nodes } = load('pages/OrTruthy.jsx')
    expect(nodes.find((n) => n.name === 'em')).toBeUndefined()
  })

  it('keeps the `||` fallback with NO alternative when the left side is statically falsy', () => {
    write(
      'pages/OrFalsy.jsx',
      [
        'const NAME = ""',
        'export default function OrFalsy() {',
        '  return <div>{NAME || <em className="anon">Anonymous</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // The parser is CERTAIN here, so there is no other state to offer.
    const { nodes } = load('pages/OrFalsy.jsx')
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.locked).toBe(false)
    expect(em.resolution?.note).toContain('statically falsy')
    expect(em.branchAlternatives).toBeUndefined()
  })

  it('renders the `||` fallback for a useState(0) binding — 0 is falsy', () => {
    write(
      'pages/OrZero.jsx',
      [
        'export default function OrZero() {',
        '  const [count] = useState(0)',
        '  return <div>{count || <em className="empty">No items</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/OrZero.jsx')
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.resolution?.note).toContain('statically falsy')
    expect(em.branchAlternatives).toBeUndefined()
  })

  it('does NOT render the `??` fallback for that same useState(0) binding — 0 is not null', () => {
    write(
      'pages/NullishZero.jsx',
      [
        'export default function NullishZero() {',
        '  const [count] = useState(0)',
        '  return <div>{count ?? <em className="empty">No items</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // The whole reason `??` gets its own decision path: answering this with a
    // truthiness test would paint an empty state over a screen showing `0`.
    const { nodes } = load('pages/NullishZero.jsx')
    expect(nodes.find((n) => n.name === 'em')).toBeUndefined()
  })

  it('renders the `??` fallback for a useState(null) binding, with no alternative', () => {
    write(
      'pages/NullishNull.jsx',
      [
        'export default function NullishNull() {',
        '  const [error] = useState(null)',
        '  return <div>{error ?? <em className="placeholder">All good</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/NullishNull.jsx')
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.locked).toBe(false)
    expect(em.resolution?.note).toContain('statically null')
    expect(em.branchAlternatives).toBeUndefined()
  })

  it('records the fallback as an alternative when `??` cannot be decided', () => {
    write(
      'pages/NullishUnknown.jsx',
      [
        'export default function NullishUnknown({ error }) {',
        '  return <div>{error ?? <em className="placeholder">All good</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/NullishUnknown.jsx')
    const em = nodes.find((n) => n.name === 'em')!
    expect(em.locked).toBe(false)
    expect(em.resolution?.note).toContain('cannot evaluate')
    expect(em.branchAlternatives).toHaveLength(1)
    expect(em.branchAlternatives?.[0]!.label).toBe('error')
  })

  it('picks ONE side when both operands of a fallback carry JSX, instead of stacking them', () => {
    write(
      'pages/BothJsx.jsx',
      [
        'export default function BothJsx() {',
        '  return <div>{(<em className="primary">P</em>) || <em className="fallback">F</em>}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // The degenerate shape, kept as the regression: ordinary descent used to
    // walk both operands and render two <em>s on top of each other. `a || b` is
    // `a ? a : b`, so the left operand is preferred — the same "first-written
    // branch" rule the ternary default uses.
    const { nodes } = load('pages/BothJsx.jsx')
    const ems = nodes.filter((n) => n.name === 'em')
    expect(ems).toHaveLength(1)
    expect(ems[0]!.props.className).toBe('primary')
    expect(ems[0]!.branchAlternatives).toHaveLength(1)
  })
})
