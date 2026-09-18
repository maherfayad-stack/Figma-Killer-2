/**
 * idStamp — unit tests.
 *
 * Cross-checked against ts-morph's own `getLineAndColumnAtPos` in
 * `src/__tests__/studio-runtime/idParity.test.ts`; this file exercises
 * `idStamp.ts` in isolation: what it stamps, what it refuses to, and its
 * never-throw contract.
 */
import { describe, expect, it } from 'bun:test'
import { stampHostElementIds, STUDIO_NODE_ID_ATTR } from '../idStamp'

describe('stampHostElementIds', () => {
  it('stamps a host element with rel:line:col, 1-based on both axes', () => {
    const code = 'export default function Home() {\n  return <div>hi</div>\n}\n'
    const result = stampHostElementIds(code, 'pages/Home.tsx')

    expect(result.changed).toBe(true)
    // "  return <" is 10 characters, so `d` of `div` sits at column 11 — this
    // pins the Babel-is-0-based/`sourceNodeId` convention-is-1-based `+1` this
    // file's header calls out as the single most likely place to drift.
    expect(result.code).toContain('data-node-id="pages/Home.tsx:2:11"')
  })

  it('does not stamp a component call site', () => {
    const code = 'export default function Home() {\n  return <PlanCard plan={p} />\n}\n'
    const result = stampHostElementIds(code, 'pages/Home.tsx')

    expect(result.changed).toBe(false)
    expect(result.code).not.toContain(STUDIO_NODE_ID_ATTR)
  })

  it('stamps a dotted, lowercase-led tag name (framer-motion\'s motion.div) — the classifyJsxTagKind quirk, reproduced on purpose', () => {
    const code = "import { motion } from 'framer-motion'\nexport default () => <motion.div />\n"
    const result = stampHostElementIds(code, 'pages/Home.tsx')

    expect(result.changed).toBe(true)
    expect(result.code).toContain(STUDIO_NODE_ID_ATTR)
  })

  it('stamps both a self-closing element and an open/close pair', () => {
    const code = 'export default function Home() {\n  return <div><img src="x" /></div>\n}\n'
    const result = stampHostElementIds(code, 'pages/Home.tsx')

    const matches = [...result.code.matchAll(new RegExp(`${STUDIO_NODE_ID_ATTR}="([^"]+)"`, 'g'))]
    expect(matches).toHaveLength(2)
  })

  it('does not double-stamp an element that already carries the attribute', () => {
    const once = stampHostElementIds('export default () => <div>hi</div>\n', 'pages/Home.tsx').code
    const twice = stampHostElementIds(once, 'pages/Home.tsx')

    expect(twice.changed).toBe(false)
    expect([...twice.code.matchAll(new RegExp(STUDIO_NODE_ID_ATTR, 'g'))]).toHaveLength(1)
  })

  it('preserves TypeScript syntax for Vite\'s own esbuild pass to strip later', () => {
    const code = 'interface Props { title: string }\nexport default function Home({ title }: Props) {\n  return <h1>{title}</h1>\n}\n'
    const result = stampHostElementIds(code, 'pages/Home.tsx')

    expect(result.changed).toBe(true)
    expect(result.code).toContain('interface Props')
    expect(result.code).toContain(': Props')
  })

  it('never throws on a file it cannot parse, and reports unchanged', () => {
    const broken = 'export default function Home( { <<< \n'
    expect(() => stampHostElementIds(broken, 'pages/Broken.tsx')).not.toThrow()
    const result = stampHostElementIds(broken, 'pages/Broken.tsx')
    expect(result).toEqual({ code: broken, changed: false })
  })

  it('reports unchanged for a file with no JSX at all', () => {
    const code = "export const VERSION = '1.0.0'\n"
    const result = stampHostElementIds(code, 'pages/Consts.ts')
    expect(result).toEqual({ code, changed: false })
  })
})
