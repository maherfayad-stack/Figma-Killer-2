/**
 * board-27b — an unresolvable attribute/style/text expression used to vanish
 * with NO trace at all: not in `props`/`inlineStyles`/`text`, and not in
 * `codeProps` either. That is not cosmetic — `isPropWritableToSource` reads
 * an ABSENT `codeProps` entry as "writable", and `setJsxProp`/`setJsxProp`-
 * adjacent codemods have no guard against replacing a non-literal attribute's
 * initializer with a baked literal. A prop the panel silently dropped used to
 * look like an ordinary empty field — type into it, save, and the edit would
 * destroy the binding the source actually had.
 *
 * These tests pin the fix: every shape that cannot resolve still names itself
 * in `codeProps` (or `style:<property>`, or feeds `codeText`), so the panel
 * renders a read-only control instead of a lying one, and the store refuses
 * the edit instead of corrupting the file.
 *
 * The fixture in the last `describe` block is deliberately dashboard/
 * analytics-shaped — it shares no naming, no domain, and no component names
 * with the eSIM corpus every other page-parser fixture is built from, per
 * `genericRepoShapes.test.ts`'s discipline: a suite grown from one repo's
 * shapes encodes that repo's habits.
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
import { isPropWritableToSource, isStyleWritableToSource } from '@core/page-tree'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-value-tracing-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** `opts` is explicit — passing `undefined` to a defaulted param would silently re-enable the evaluator. */
function loadNodes(pageRel: string, opts: StaticEvalOptions | undefined): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  return Object.values(parsePageFile(file, tmpDir, project, opts).nodes)
}

const named = (nodes: ParsedNode[], name: string): ParsedNode => {
  const found = nodes.find((n) => n.name === name)
  if (!found) throw new Error(`No node named ${name} in ${nodes.map((n) => n.name).join(', ')}`)
  return found
}

describe('an unresolvable prop leaves a trace instead of vanishing', () => {
  it('an identifier bound to hook state on an HTML element: no value, but codeProps names it', () => {
    write(
      'pages/Toggle.jsx',
      ['export default function Toggle({ isOpen }) {', '  return <div aria-expanded={isOpen}>Menu</div>', '}', ''].join(
        '\n',
      ),
    )
    const div = named(loadNodes('pages/Toggle.jsx', evalOptions()), 'div')
    expect(div.props['aria-expanded']).toBeUndefined()
    expect(div.codeProps).toContain('aria-expanded')
    // This is the actual write-safety fix: before board-27b this returned
    // `true` (nothing in `codeProps` named the prop), and an edit here would
    // have `setJsxProp`'d a literal straight over `{isOpen}`.
    expect(isPropWritableToSource(div, 'aria-expanded')).toBe(false)
  })

  it('a member chain the evaluator cannot walk, on a component prop', () => {
    write(
      'pages/Card.jsx',
      [
        'export default function Card({ stats }) {',
        '  return <Widget count={stats.total} />',
        '}',
        '',
      ].join('\n'),
    )
    const widget = named(loadNodes('pages/Card.jsx', evalOptions()), 'Widget')
    expect(widget.props.count).toBeUndefined()
    expect(widget.codeProps).toContain('count')
    expect(isPropWritableToSource(widget, 'count')).toBe(false)
  })

  it('an unresolvable className interpolation: still no className VALUE, but now traced (closes the static-class-name blind spot)', () => {
    write(
      'pages/Badge.jsx',
      [
        'export default function Badge({ tone }) {',
        '  return <span className={`badge badge--${tone}`}>Hi</span>',
        '}',
        '',
      ].join('\n'),
    )
    const span = named(loadNodes('pages/Badge.jsx', evalOptions()), 'span')
    // The VALUE still does not reach the canvas — that half is unchanged and
    // correct (there is no honest string to render).
    expect(span.props.className).toBeUndefined()
    // The NAME is no longer invisible.
    expect(span.codeProps).toContain('className')
    expect(isPropWritableToSource(span, 'className')).toBe(false)
  })

  it('a JSX-valued prop on a plain HTML element is traced rather than silently dropped', () => {
    write(
      'pages/Weird.jsx',
      ['export default function Weird() {', '  return <div icon={<span>*</span>} />', '}', ''].join('\n'),
    )
    const div = named(loadNodes('pages/Weird.jsx', evalOptions()), 'div')
    expect(div.props.icon).toBeUndefined()
    expect(div.codeProps).toContain('icon')
  })

  it('a component array prop that declines entirely (unresolvable item) still names itself in codeProps', () => {
    write(
      'pages/List.jsx',
      [
        'export default function List({ extra }) {',
        '  return <TabBar items={["Home", extra]} />',
        '}',
        '',
      ].join('\n'),
    )
    const tabBar = named(loadNodes('pages/List.jsx', evalOptions()), 'TabBar')
    expect(tabBar.props.items).toBeUndefined()
    expect(tabBar.codeProps).toContain('items')
    expect(isPropWritableToSource(tabBar, 'items')).toBe(false)
  })

  it('a bare JSX-element component prop is NOT double-recorded — slot capture already traces it', () => {
    write(
      'pages/Sheet.jsx',
      ['export default function Sheet() {', '  return <Sheet icon={<Icon name="star" />} />', '}', ''].join('\n'),
    )
    const sheet = named(loadNodes('pages/Sheet.jsx', evalOptions()), 'Sheet')
    // Materialized as a slot child (WS-3.4), and codeProps names it exactly
    // once — no duplicate entry from `extractProps`' own catch-all.
    expect(sheet.codeProps?.filter((p) => p === 'icon')).toHaveLength(1)
  })

  it('does not fire when the evaluator is off — unchanged pre-§7 behaviour for every caller/test that omits evalOptions', () => {
    write(
      'pages/Toggle.jsx',
      ['export default function Toggle({ isOpen }) {', '  return <div aria-expanded={isOpen}>Menu</div>', '}', ''].join(
        '\n',
      ),
    )
    const div = named(loadNodes('pages/Toggle.jsx', undefined), 'div')
    expect(div.props['aria-expanded']).toBeUndefined()
    expect(div.codeProps ?? []).not.toContain('aria-expanded')
  })
})

describe('an unresolvable inline-style property leaves a trace instead of vanishing', () => {
  it('a hook-state-bound style value: no inlineStyles entry, but style:<prop> is traced', () => {
    write(
      'pages/Bar.jsx',
      [
        'export default function Bar({ pct }) {',
        '  return <div style={{ width: pct, padding: 4 }}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )
    const div = named(loadNodes('pages/Bar.jsx', evalOptions()), 'div')
    expect(div.inlineStyles?.width).toBeUndefined()
    expect(div.inlineStyles?.padding).toBe(4)
    expect(div.codeProps).toContain('style:width')
    expect(div.codeProps ?? []).not.toContain('style:padding')
    expect(isStyleWritableToSource(div, 'width')).toBe(false)
    expect(isStyleWritableToSource(div, 'padding')).toBe(true)
  })

  it('shorthand style properties resolve through the same identifier path as `{ color: accent }`', () => {
    write(
      'pages/Shorthand.jsx',
      [
        "const accent = 'var(--accent)'",
        'export default function Shorthand() {',
        '  return <span style={{ accent }}>Hi</span>',
        '}',
        '',
      ].join('\n'),
    )
    const span = named(loadNodes('pages/Shorthand.jsx', evalOptions()), 'span')
    expect(span.inlineStyles?.accent).toBe('var(--accent)')
  })

  it('an unresolvable shorthand style property is traced, not silently dropped', () => {
    write(
      'pages/Shorthand.jsx',
      [
        'export default function Shorthand({ accent }) {',
        '  return <span style={{ accent }}>Hi</span>',
        '}',
        '',
      ].join('\n'),
    )
    const span = named(loadNodes('pages/Shorthand.jsx', evalOptions()), 'span')
    expect(span.inlineStyles?.accent).toBeUndefined()
    expect(span.codeProps).toContain('style:accent')
  })

  it('a spread inside the style object: no name to trace, and its siblings resolve independently', () => {
    write(
      'pages/Spread.jsx',
      [
        'export default function Spread({ base }) {',
        '  return <div style={{ ...base, padding: 4 }}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )
    const div = named(loadNodes('pages/Spread.jsx', evalOptions()), 'div')
    expect(div.inlineStyles?.padding).toBe(4)
    expect(div.codeProps ?? []).not.toContain('style:padding')
  })
})

describe('a text expression that cannot resolve leaves a trace instead of looking empty', () => {
  it('sole expression child, unresolvable: no text, but codeText is true', () => {
    write(
      'pages/Label.jsx',
      ['export default function Label({ value }) {', '  return <span>{value}</span>', '}', ''].join('\n'),
    )
    const span = named(loadNodes('pages/Label.jsx', evalOptions()), 'span')
    expect(span.text).toBeUndefined()
    expect(span.codeText).toBe(true)
  })

  it('genuinely no text at all is NOT the same fact — codeText stays unset', () => {
    write('pages/Icon.jsx', ['export default function Icon() {', '  return <span className="glyph" />', '}', ''].join('\n'))
    const span = named(loadNodes('pages/Icon.jsx', evalOptions()), 'span')
    expect(span.text).toBeUndefined()
    expect(span.codeText).toBeUndefined()
  })

  it('does not fire when the evaluator is off', () => {
    write(
      'pages/Label.jsx',
      ['export default function Label({ value }) {', '  return <span>{value}</span>', '}', ''].join('\n'),
    )
    const span = named(loadNodes('pages/Label.jsx', undefined), 'span')
    expect(span.codeText).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A fixture that shares nothing with the eSIM corpus — dashboard/analytics
// naming, not travel/booking. genericRepoShapes.test.ts's discipline.
// ---------------------------------------------------------------------------

describe('generic repo shape — an analytics dashboard, not the eSIM corpus', () => {
  it('an unresolvable trend delta and a hook-driven card variant both leave a trace', () => {
    write(
      'pages/AnalyticsDashboard.jsx',
      [
        'export default function AnalyticsDashboard({ trendValue, cardVariant }) {',
        '  return (',
        '    <section className="dashboard">',
        '      <StatCard',
        '        label="Weekly revenue"',
        '        delta={trendValue}',
        '        variant={cardVariant}',
        '        icon={<TrendIcon glyph={trendValue > 0 ? "up" : "down"} />}',
        '      />',
        '    </section>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const nodes = loadNodes('pages/AnalyticsDashboard.jsx', evalOptions())
    const statCard = named(nodes, 'StatCard')

    // The literal survives untouched, exactly like every other resolved prop.
    expect(statCard.props.label).toBe('Weekly revenue')

    // `delta`/`variant` are read off destructured, unresolvable function
    // parameters — genuinely unrepresentable — but neither is silently
    // dropped any more.
    expect(statCard.props.delta).toBeUndefined()
    expect(statCard.codeProps).toContain('delta')
    expect(isPropWritableToSource(statCard, 'delta')).toBe(false)
    expect(statCard.props.variant).toBeUndefined()
    expect(statCard.codeProps).toContain('variant')

    // `icon`'s own value IS a bare JSX element (`<TrendIcon .../>`), so it is
    // materialized as a real, locked slot child (WS-3.4) — `icon` itself is
    // fine, reachable only through the `studio-slot:` sentinel, never
    // `children` (a slot value isn't a DOM child of its host). The
    // unresolvable expression lives one level DEEPER, on that child's own
    // `glyph` prop (a ternary whose condition, `trendValue > 0`, is not
    // statically decidable) — and the same catch-all traces it there,
    // proving the fix isn't limited to top-level attributes.
    const iconSlotId = studioSlotNodeId(statCard.props.icon)
    expect(iconSlotId).toBeDefined()
    const trendIcon = nodes.find((n) => n.id === iconSlotId)!
    expect(trendIcon.name).toBe('TrendIcon')
    expect(trendIcon.props.glyph).toBeUndefined()
    expect(trendIcon.codeProps).toContain('glyph')
    expect(isPropWritableToSource(trendIcon, 'glyph')).toBe(false)
  })
})
