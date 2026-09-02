/**
 * componentCallSites — E2.2's blast-radius scan. Covers a direct default
 * import, a direct named import, a barrel-resolved named import, an aliased
 * import, several call sites across several files, and the documented
 * namespace-import gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject } from '@core/page-parser'
import { findComponentCallSites } from '../componentCallSites'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-call-sites-'))
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

function callSitesFor(componentFile: string, exportName: string) {
  const project = createWorkspaceProject(tmpDir)
  return findComponentCallSites(project, tmpDir, componentFile, exportName)
}

describe('findComponentCallSites', () => {
  it('finds a direct default-export call site', () => {
    const cardFile = write('components/Card.tsx', 'export default function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', ["import Card from '../components/Card'", 'export default function Home() {', '  return <Card />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'default')
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ file: 'pages/Home.tsx', localName: 'Card' })
  })

  it('finds a direct named-export call site', () => {
    const cardFile = write('components/Card.tsx', 'export function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', ["import { Card } from '../components/Card'", 'export default function Home() {', '  return <Card />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'Card')
    expect(sites).toHaveLength(1)
  })

  it('follows a renaming barrel to the declaring file', () => {
    const cardFile = write('components/Card.tsx', 'export function Card() {\n  return <div />\n}\n')
    write('components/index.ts', "export { Card as PlanCard } from './Card'\n")
    write('pages/Home.tsx', ["import { PlanCard } from '../components'", 'export default function Home() {', '  return <PlanCard />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'Card')
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ file: 'pages/Home.tsx', localName: 'PlanCard' })
  })

  it('recognizes an aliased named import', () => {
    const cardFile = write('components/Card.tsx', 'export function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', ["import { Card as MyCard } from '../components/Card'", 'export default function Home() {', '  return <MyCard />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'Card')
    expect(sites).toHaveLength(1)
    expect(sites[0]!.localName).toBe('MyCard')
  })

  it('collects every call site across every file', () => {
    const cardFile = write('components/Card.tsx', 'export function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', ["import { Card } from '../components/Card'", 'export default function Home() {', '  return (', '    <div>', '      <Card />', '      <Card />', '    </div>', '  )', '}', ''].join('\n'))
    write('pages/About.tsx', ["import { Card } from '../components/Card'", 'export default function About() {', '  return <Card />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'Card')
    expect(sites).toHaveLength(3)
    expect(sites.filter((s) => s.file === 'pages/Home.tsx')).toHaveLength(2)
    expect(sites.filter((s) => s.file === 'pages/About.tsx')).toHaveLength(1)
  })

  it('does not confuse two DIFFERENT components with the same local tag name in different files', () => {
    const cardFile = write('components/Card.tsx', 'export default function Card() {\n  return <div />\n}\n')
    write('components/OtherCard.tsx', 'export default function Card() {\n  return <span />\n}\n')
    write('pages/Home.tsx', ["import Card from '../components/Card'", 'export default function Home() {', '  return <Card />', '}', ''].join('\n'))
    write('pages/Other.tsx', ["import Card from '../components/OtherCard'", 'export default function Other() {', '  return <Card />', '}', ''].join('\n'))

    const sites = callSitesFor(cardFile, 'default')
    expect(sites).toHaveLength(1)
    expect(sites[0]!.file).toBe('pages/Home.tsx')
  })

  it('returns an empty list when the component has no call sites at all', () => {
    const cardFile = write('components/Card.tsx', 'export default function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', 'export default function Home() {\n  return <div />\n}\n')

    expect(callSitesFor(cardFile, 'default')).toEqual([])
  })

  it('does not resolve a namespace import (documented gap)', () => {
    const cardFile = write('components/Card.tsx', 'export function Card() {\n  return <div />\n}\n')
    write('pages/Home.tsx', ["import * as C from '../components/Card'", 'export default function Home() {', '  return <C.Card />', '}', ''].join('\n'))

    expect(callSitesFor(cardFile, 'Card')).toEqual([])
  })
})
