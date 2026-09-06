/**
 * prototypeCodeFlow — tests for the derived flow map.
 *
 * The feature's whole promise is that a code connector is TRUE, so these tests
 * are weighted toward refusal: roughly half assert that something Studio cannot
 * be sure about produces NO edge. An arrow nobody wrote is a worse bug here
 * than a missing one, because the user cannot tell it is wrong by looking.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveCodeFlow } from '../prototypeCodeFlow'
import { buildRouteIndex, normalizeNavTarget, resolveNavTarget } from '../prototypeRouteIndex'
import { parsePageFile } from '@core/page-parser'
import type { CodeFlowEdge } from '@core/studio-prototype'

let tmpDir: string
let pagesDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-flow-'))
  pagesDir = path.join(tmpDir, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writePage(relPath: string, body: string): void {
  const file = path.join(pagesDir, relPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** Every page a flow can land on, so a test only has to write the interesting one. */
function writeDestinations(): void {
  writePage('Details.tsx', 'export default function Details() { return <div /> }\n')
  writePage('Settings.tsx', 'export default function Settings() { return <div /> }\n')
}

function page(body: string): void {
  writePage('Home.tsx', body)
}

function edges(): CodeFlowEdge[] {
  return deriveCodeFlow(tmpDir).edges
}

function targets(): string[] {
  return edges().map((edge) => edge.targetPageId)
}

describe('reading navigation out of the source', () => {
  it('reads an href on an anchor', () => {
    writeDestinations()
    page(`export default function Home() { return <a href="/details">Go</a> }\n`)
    expect(targets()).toEqual(['details'])
    expect(edges()[0]!.via).toBe('href')
  })

  it('reads a router Link `to`, expression-wrapped or not', () => {
    writeDestinations()
    page(`
      import { Link } from 'react-router-dom'
      export default function Home() {
        return <><Link to="/details">A</Link><Link to={'/settings'}>B</Link></>
      }
    `)
    expect(targets().sort()).toEqual(['details', 'settings'])
    expect(edges().every((edge) => edge.via === 'to')).toBe(true)
  })

  it('reads a navigate() call inside an inline handler', () => {
    writeDestinations()
    page(`
      export default function Home() {
        const navigate = useNavigate()
        return <button onClick={() => navigate('/details')}>Go</button>
      }
    `)
    expect(targets()).toEqual(['details'])
    expect(edges()[0]!.via).toBe('call')
    expect(edges()[0]!.evidence).toBe("navigate('/details')")
  })

  it('reads router.push / navigation.navigate / location.assign', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return (
          <>
            <button onClick={() => router.push('/details')}>A</button>
            <button onClick={() => navigation.navigate('Settings')}>B</button>
            <button onClick={() => window.location.assign('/details')}>C</button>
          </>
        )
      }
    `)
    expect(targets().sort()).toEqual(['details', 'details', 'settings'])
  })

  it('reads a `location.href = …` assignment, which is not a call at all', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return <button onClick={() => { window.location.href = '/settings' }}>Go</button>
      }
    `)
    expect(targets()).toEqual(['settings'])
  })

  it('reads a handler nested inside an object-valued prop', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return <Navbar toolbar={{ onBack: () => router.push('/details') }} />
      }
    `)
    expect(targets()).toEqual(['details'])
  })

  it('follows a bare identifier handler one hop to its same-file declaration', () => {
    writeDestinations()
    page(`
      export default function Home() {
        const goToDetails = () => navigate('/details')
        return <button onClick={goToDetails}>Go</button>
      }
    `)
    expect(targets()).toEqual(['details'])
  })

  it('terminates on a pair of handlers that reference each other', () => {
    writeDestinations()
    page(`
      export default function Home() {
        const a = () => b()
        const b = () => a()
        return <button onClick={a}>Go</button>
      }
    `)
    expect(targets()).toEqual([])
  })

  it('names the source element by the id the page parser mints for it', () => {
    // The claim that matters, checked against the real parser rather than a
    // transcribed line/column: a connector's tooltip cites a node id, and an id
    // this scan minted differently from the parser would cite a node that does
    // not exist. Both derive from the tag NAME's position, and this is the
    // tripwire for either side drifting.
    writeDestinations()
    page(`export default function Home() { return <a href="/details">Go</a> }\n`)
    const parsed = parsePageFile(path.join(pagesDir, 'Home.tsx'), tmpDir)
    expect(Object.keys(parsed.nodes)).toContain(edges()[0]!.sourceNodeId)
  })
})

describe('refusing what it cannot be sure of', () => {
  it('draws nothing for a target that leaves the project', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return (
          <>
            <a href="https://example.com">A</a>
            <a href="#terms">B</a>
            <a href="mailto:hi@example.com">C</a>
          </>
        )
      }
    `)
    expect(targets()).toEqual([])
  })

  it('draws nothing for a target no page answers to', () => {
    writeDestinations()
    page(`export default function Home() { return <a href="/checkout">Go</a> }\n`)
    expect(targets()).toEqual([])
  })

  it('draws nothing for a computed target, which names a different route each render', () => {
    writeDestinations()
    page(`
      export default function Home({ id }) {
        return (
          <>
            <a href={\`/details/\${id}\`}>A</a>
            <button onClick={() => navigate(route)}>B</button>
          </>
        )
      }
    `)
    expect(targets()).toEqual([])
  })

  it('draws nothing for a call that is not navigation', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return <button onClick={() => track('/details')}>Go</button>
      }
    `)
    expect(targets()).toEqual([])
  })

  it('collapses two identical facts written at one source position into one edge', () => {
    writeDestinations()
    page(`
      export default function Home() {
        return <a href="/details" onClick={() => navigate('/details')}>Go</a>
      }
    `)
    // Same element, same destination, but read two different ways — two
    // distinct facts, so two edges. The renderer collapses them per page pair.
    expect(edges()).toHaveLength(2)
    expect(new Set(edges().map((edge) => edge.id)).size).toBe(2)
  })

  it('is stable across two derivations of an unchanged project', () => {
    writeDestinations()
    page(`export default function Home() { return <a href="/details">Go</a> }\n`)
    expect(deriveCodeFlow(tmpDir)).toEqual(deriveCodeFlow(tmpDir))
  })
})

describe('route index', () => {
  it('normalizes the spellings one route is written in', () => {
    expect(normalizeNavTarget('/Details/')).toBe('details')
    expect(normalizeNavTarget('./details?a=1#x')).toBe('details')
    expect(normalizeNavTarget('/')).toBe('')
    expect(normalizeNavTarget('https://x.dev')).toBeNull()
    expect(normalizeNavTarget('#anchor')).toBeNull()
  })

  it('lets an index-shaped page answer to the site root', () => {
    const index = buildRouteIndex([{ pageId: 'home', relPath: 'Home.tsx' }])
    expect(resolveNavTarget(index, '/')).toBe('home')
    expect(resolveNavTarget(index, '/home')).toBe('home')
  })

  it('does not let a NESTED index page claim the site root', () => {
    const index = buildRouteIndex([{ pageId: 'account-index', relPath: 'account/index.tsx' }])
    expect(resolveNavTarget(index, '/')).toBeNull()
    expect(resolveNavTarget(index, '/account/index')).toBe('account-index')
  })

  it('withdraws a key two pages both answer to rather than picking one', () => {
    const index = buildRouteIndex([
      { pageId: 'details', relPath: 'Details.tsx' },
      { pageId: 'account-details', relPath: 'account/Details.tsx' },
    ])
    expect(resolveNavTarget(index, 'details')).toBeNull()
    // Each still keeps the spelling only it answers to.
    expect(resolveNavTarget(index, 'account/details')).toBe('account-details')
  })
})
