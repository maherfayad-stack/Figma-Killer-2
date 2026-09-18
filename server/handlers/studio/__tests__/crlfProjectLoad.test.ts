/**
 * End to end: a CRLF project loads to the same board as its LF copy.
 *
 * `crlfParse.test.ts` (`@core/page-parser`) proves the parser itself is
 * CRLF-invariant. This proves the whole `/admin/api/studio/load` pipeline is —
 * `loadStudioPages` walks the pages dir, builds the workspace ts-morph
 * project, compiles the stylesheets, converts each parse to a `Page` and
 * registers the style rules. Any one of those re-introducing a `\r` would put
 * a Windows user's board out of step with everyone else's for reasons nothing
 * on screen could explain.
 *
 * The project shares nothing with the eSIM corpus — it is a village-hall
 * booking app with a plain `.css` sheet — and its bytes are written by the
 * test, because this repository's own working tree is CRLF-converted by Git on
 * checkout and a committed CRLF fixture cannot be trusted to still be CRLF.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPages } from '../../studioPageLoad'

const FILES: Record<string, string[]> = {
  'pages/Bookings.css': [
    '.bookings {',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 12px;',
    '}',
    '',
    '.bookings__room {',
    '  padding: 6px;',
    '}',
    '',
  ],
  'components/RoomCard.tsx': [
    'export interface RoomCardProps {',
    '  name: string',
    '  capacity: number',
    '}',
    '',
    'export function RoomCard({ name, capacity }: RoomCardProps) {',
    '  return (',
    '    <article className="bookings__room">',
    '      <h3>{name}</h3>',
    '      <p>{`Seats ${capacity}`}</p>',
    '    </article>',
    '  )',
    '}',
    '',
  ],
  'pages/Bookings.tsx': [
    "import './Bookings.css'",
    "import { RoomCard } from '../components/RoomCard'",
    '',
    'const ROOMS = [',
    "  { name: 'Main hall', capacity: 120 },",
    "  { name: 'Committee room', capacity: 14 },",
    ']',
    '',
    'export default function Bookings() {',
    '  return (',
    '    <main className="bookings">',
    '      <h1>Village hall bookings</h1>',
    '      {ROOMS.map((room) => (',
    '        <RoomCard key={room.name} name={room.name} capacity={room.capacity} />',
    '      ))}',
    '    </main>',
    '  )',
    '}',
    '',
  ],
}

let lfRoot: string
let crlfRoot: string

function writeProject(root: string, eol: '\n' | '\r\n'): void {
  for (const [rel, lines] of Object.entries(FILES)) {
    const full = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, lines.join(eol), 'utf8')
  }
}

beforeEach(() => {
  lfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-load-lf-'))
  crlfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-load-crlf-'))
  writeProject(lfRoot, '\n')
  writeProject(crlfRoot, '\r\n')
})

afterEach(() => {
  fs.rmSync(lfRoot, { recursive: true, force: true })
  fs.rmSync(crlfRoot, { recursive: true, force: true })
})

describe('loadStudioPages against a CRLF project', () => {
  it('produces the same pages as the LF copy — node ids, positions and props alike', async () => {
    const [lf, crlf] = await Promise.all([loadStudioPages(lfRoot), loadStudioPages(crlfRoot)])
    expect(crlf.pages).toHaveLength(1)
    expect(crlf.pages).toEqual(lf.pages)

    // Named explicitly, so an empty-tree regression cannot pass this file by
    // comparing two empty boards: the `.map` rows and the inlined component's
    // own nodes must both be there, on both.
    const ids = Object.keys(crlf.pages[0]!.nodes).sort()
    expect(ids).toEqual(Object.keys(lf.pages[0]!.nodes).sort())
    expect(ids.some((id) => id.includes('#'))).toBe(true)
    expect(ids.some((id) => id.includes('~'))).toBe(true)
  })

  it('registers the same style rules from a CRLF stylesheet', async () => {
    const [lf, crlf] = await Promise.all([loadStudioPages(lfRoot), loadStudioPages(crlfRoot)])
    expect(Object.keys(crlf.styleRules).sort()).toEqual(Object.keys(lf.styleRules).sort())
    expect(crlf.styleRules).toEqual(lf.styleRules)
  })

  it('lets no \\r reach the board at all', async () => {
    const crlf = await loadStudioPages(crlfRoot)
    expect(JSON.stringify(crlf.pages)).not.toContain('\\r')
    expect(JSON.stringify(crlf.styleRules)).not.toContain('\\r')
  })

  it('reads the CRLF project without rewriting any of its files', async () => {
    const before = Object.keys(FILES).map((rel) => fs.readFileSync(path.join(crlfRoot, ...rel.split('/')), 'utf8'))
    await loadStudioPages(crlfRoot)
    const after = Object.keys(FILES).map((rel) => fs.readFileSync(path.join(crlfRoot, ...rel.split('/')), 'utf8'))
    expect(after).toEqual(before)
    expect(after.every((text) => text.includes('\r\n') && !/[^\r]\n/.test(text))).toBe(true)
  })
})
