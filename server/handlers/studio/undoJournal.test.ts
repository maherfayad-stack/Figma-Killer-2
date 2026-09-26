/**
 * undoJournal — the compare-and-swap restore journal (P3-F), exercised on
 * real files: what it restores, when it refuses, how it stays bounded, and
 * that nothing read back from `.studio/` is trusted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  UNDO_JOURNAL_DIR,
  captureUndoPreImage,
  recordUndoJournal,
  restoreUndoJournal,
  undoJournalFiles,
} from './undoJournal'
import { readGitStatus } from './gitOperations'

let dir: string
let outside: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}
const journalDir = () => path.join(dir, ...UNDO_JOURNAL_DIR.split('/'))
const entries = () => (fs.existsSync(journalDir()) ? fs.readdirSync(journalDir()).sort() : [])

/** Capture, write, record — what a batch does around a one-shot write. */
function journaledWrite(changes: Record<string, string | null>, created: string[] = []): string | null {
  const preImage = captureUndoPreImage(Object.keys(changes).filter((rel) => !created.includes(rel)).map(abs))
  for (const [rel, text] of Object.entries(changes)) {
    if (text === null) fs.rmSync(abs(rel))
    else write(rel, text)
  }
  return recordUndoJournal(dir, preImage, created.map(abs))
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'undo-journal-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'undo-journal-outside-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('restore — the exact bytes back', () => {
  it('puts every changed file back byte for byte (CRLF and a BOM included) and consumes the entry', () => {
    const page = String.fromCharCode(0xfeff) + 'export default function P() {\r\n  return <p>a</p>\r\n}\r\n'
    write('pages/Home.tsx', page)
    write('pages/Other.tsx', 'export const x = 1\n')

    const token = journaledWrite({ 'pages/Home.tsx': 'export default function P() {\r\n  return null\r\n}\r\n', 'pages/Other.tsx': 'export const x = 2\n' })
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(undoJournalFiles(dir, token!).map((file) => path.relative(dir, file).split(path.sep).join('/')).sort()).toEqual([
      'pages/Home.tsx',
      'pages/Other.tsx',
    ])

    const result = restoreUndoJournal(dir, token!)
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(abs('pages/Home.tsx'))).toEqual(Buffer.from(page, 'utf8'))
    expect(read('pages/Other.tsx')).toBe('export const x = 1\n')
    // Single use: the token cannot be replayed.
    expect(entries()).toEqual([])
    expect(restoreUndoJournal(dir, token!)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
  })

  it('removes a file the write created (an extract’s copy)', () => {
    write('pages/Home.tsx', '<Card />\n')
    const token = journaledWrite({ 'pages/Home.tsx': '<Card2 />\n', 'components/Card2.tsx': 'export function Card2() {}\n' }, ['components/Card2.tsx'])
    expect(restoreUndoJournal(dir, token!).ok).toBe(true)
    expect(read('pages/Home.tsx')).toBe('<Card />\n')
    expect(fs.existsSync(abs('components/Card2.tsx'))).toBe(false)
  })

  it('records only the files the write actually changed, and nothing when it changed none', () => {
    write('pages/Home.tsx', 'a\n')
    write('pages/Same.tsx', 'same\n')
    const token = journaledWrite({ 'pages/Home.tsx': 'b\n', 'pages/Same.tsx': 'same\n' })
    expect(undoJournalFiles(dir, token!).map((file) => path.basename(file))).toEqual(['Home.tsx'])
    expect(journaledWrite({ 'pages/Same.tsx': 'same\n' })).toBeNull()
  })
})

describe('compare-and-swap — a stale restore refuses and writes nothing', () => {
  it('refuses restore-stale, naming the file, when ANY file changed after the write', () => {
    write('pages/Home.tsx', 'home v1\n')
    write('pages/Other.tsx', 'other v1\n')
    const token = journaledWrite({ 'pages/Home.tsx': 'home v2\n', 'pages/Other.tsx': 'other v2\n' })
    write('pages/Other.tsx', 'other v3 — an agent edited it\n')

    const result = restoreUndoJournal(dir, token!)
    expect(result).toMatchObject({ ok: false, reason: 'restore-stale' })
    if (!result.ok) expect(result.message).toContain('pages/Other.tsx has changed since')
    // All or nothing: the untouched file was NOT put back either.
    expect(read('pages/Home.tsx')).toBe('home v2\n')
    expect(read('pages/Other.tsx')).toBe('other v3 — an agent edited it\n')
  })

  it('refuses when a file the write left has since been deleted', () => {
    write('pages/Home.tsx', 'v1\n')
    const token = journaledWrite({ 'pages/Home.tsx': 'v2\n' })
    fs.rmSync(abs('pages/Home.tsx'))
    expect(restoreUndoJournal(dir, token!)).toMatchObject({ ok: false, reason: 'restore-stale' })
    expect(fs.existsSync(abs('pages/Home.tsx'))).toBe(false)
  })

  it('applies again once the file is back to exactly what the write left', () => {
    write('pages/Home.tsx', 'v1\n')
    const token = journaledWrite({ 'pages/Home.tsx': 'v2\n' })
    write('pages/Home.tsx', 'v3\n')
    expect(restoreUndoJournal(dir, token!).ok).toBe(false)
    write('pages/Home.tsx', 'v2\n')
    expect(restoreUndoJournal(dir, token!).ok).toBe(true)
    expect(read('pages/Home.tsx')).toBe('v1\n')
  })
})

describe('bounded', () => {
  it(`keeps the newest ${MAX_ENTRIES} entries per project and prunes the rest`, () => {
    write('pages/Home.tsx', 'v0\n')
    const tokens: string[] = []
    for (let i = 1; i <= MAX_ENTRIES + 5; i++) tokens.push(journaledWrite({ 'pages/Home.tsx': `v${i}\n` })!)
    expect(entries()).toHaveLength(MAX_ENTRIES)
    expect(entries()).toEqual(tokens.slice(5).map((token) => `${token}.json`).sort())
    // The pruned ones are gone for good; the newest still restores.
    expect(restoreUndoJournal(dir, tokens[0]!)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    expect(restoreUndoJournal(dir, tokens.at(-1)!).ok).toBe(true)
  })

  it('records nothing for a write whose pre-image would not fit in one entry', () => {
    write('pages/Big.tsx', 'x'.repeat(MAX_ENTRY_BYTES + 1))
    expect(journaledWrite({ 'pages/Big.tsx': 'small\n' })).toBeNull()
    expect(entries()).toEqual([])
  })

  it('records nothing for a pre-image that is not valid UTF-8 — it could not be put back exactly', () => {
    write('pages/Home.tsx', Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
    expect(journaledWrite({ 'pages/Home.tsx': 'b\n' })).toBeNull()
  })
})

describe('review of #274', () => {
  /** A token-shaped name stamped `ms` since the epoch, as `mintToken` would write it. */
  const stampedName = (ms: number, n: number) => `${ms.toString(16).padStart(12, '0')}${n.toString(16).padStart(20, '0')}.json`

  it('nit 1 — future-stamped names cannot switch undo off: the new entry survives, the planted ones go', () => {
    fs.mkdirSync(journalDir(), { recursive: true })
    const future = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000
    for (let i = 0; i < MAX_ENTRIES; i++) fs.writeFileSync(path.join(journalDir(), stampedName(future, i)), '{}')
    write('pages/Home.tsx', 'v1\n')

    const token = journaledWrite({ 'pages/Home.tsx': 'v2\n' })
    expect(token).not.toBeNull()
    expect(entries()).toEqual([`${token}.json`])
    expect(restoreUndoJournal(dir, token!).ok).toBe(true)
    expect(read('pages/Home.tsx')).toBe('v1\n')
  })

  it('nit 1 — the entry just written is never the one pruned, even when every other name sorts above it', () => {
    fs.mkdirSync(journalDir(), { recursive: true })
    // Within the slack, so not "future" — but still stamped after anything this clock mints next.
    const soon = Date.now() + 60 * 60 * 1000
    for (let i = 0; i < MAX_ENTRIES; i++) fs.writeFileSync(path.join(journalDir(), stampedName(soon, i)), '{}')
    write('pages/Home.tsx', 'v1\n')

    const token = journaledWrite({ 'pages/Home.tsx': 'v2\n' })
    expect(entries()).toContain(`${token}.json`)
    expect(entries()).toHaveLength(MAX_ENTRIES)
    expect(restoreUndoJournal(dir, token!).ok).toBe(true)
  })

  it('nit 2 — a folder full of junk names is read only so far, and journaling still works', () => {
    fs.mkdirSync(journalDir(), { recursive: true })
    for (let i = 0; i < 1_200; i++) fs.writeFileSync(path.join(journalDir(), `junk-${i}.txt`), '')
    write('pages/Home.tsx', 'v1\n')
    const token = journaledWrite({ 'pages/Home.tsx': 'v2\n' })
    expect(restoreUndoJournal(dir, token!).ok).toBe(true)
    expect(read('pages/Home.tsx')).toBe('v1\n')
  })

  it('nit 3 — a write that fails part-way puts back the files already restored, keeps the entry, and a retry works', () => {
    write('pages/A.tsx', 'a1\n')
    write('pages/B.tsx', 'b1\n')
    const token = journaledWrite({ 'pages/A.tsx': 'a2\n', 'pages/B.tsx': 'b2\n' })!
    let writes = 0
    const failing = restoreUndoJournal(dir, token, {
      writeFile: (file, text) => {
        writes += 1
        if (writes === 2) throw new Error('disk full')
        fs.writeFileSync(file, text)
      },
    })
    expect(failing).toMatchObject({ ok: false, reason: 'restore-failed' })
    expect(read('pages/A.tsx')).toBe('a2\n')
    expect(read('pages/B.tsx')).toBe('b2\n')
    expect(entries()).toEqual([`${token}.json`])

    expect(restoreUndoJournal(dir, token).ok).toBe(true)
    expect(read('pages/A.tsx')).toBe('a1\n')
    expect(read('pages/B.tsx')).toBe('b1\n')
  })
})

describe('untrusted on read', () => {
  it('never lets a token become a path: anything but 32 hex digits is unavailable', () => {
    write('secret.json', '{"version":1}')
    for (const token of ['../../secret', '..\\..\\secret', '/etc/passwd', 'C:\\x', 'ABCDEF'.repeat(6).slice(0, 32), '0'.repeat(31), `${'0'.repeat(32)}/..`]) {
      expect(restoreUndoJournal(dir, token)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
      expect(undoJournalFiles(dir, token)).toEqual([])
    }
  })

  function plant(entry: unknown): string {
    const token = 'f'.repeat(32)
    fs.mkdirSync(journalDir(), { recursive: true })
    fs.writeFileSync(path.join(journalDir(), `${token}.json`), JSON.stringify(entry))
    return token
  }

  it('refuses an entry whose rel escapes the project, names a non-source file, or reaches into .studio', () => {
    write('pages/Home.tsx', 'mine\n')
    fs.writeFileSync(path.join(outside, 'victim.tsx'), 'victim\n')
    const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
    const hostile = [
      path.relative(dir, path.join(outside, 'victim.tsx')).split(path.sep).join('/'),
      '.studio/meta.json',
      '.git/hooks/pre-commit.js',
      'node_modules/pkg/index.js',
      '.env',
    ]
    for (const rel of hostile) {
      const token = plant({ version: 1, at: 1, files: [{ rel, before: 'pwned', afterSha256: sha('victim\n') }] })
      expect(restoreUndoJournal(dir, token)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    }
    expect(fs.readFileSync(path.join(outside, 'victim.tsx'), 'utf8')).toBe('victim\n')
    expect(read('pages/Home.tsx')).toBe('mine\n')
  })

  it('refuses a malformed entry, and one over the size cap, rather than trusting it', () => {
    write('pages/Home.tsx', 'mine\n')
    expect(restoreUndoJournal(dir, plant({ version: 2, files: [] }))).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    expect(restoreUndoJournal(dir, plant({ version: 1, at: 1, files: [{ rel: 'pages/Home.tsx', before: 'x', afterSha256: 'not-a-sha' }] }))).toMatchObject({
      ok: false,
      reason: 'restore-unavailable',
    })
    const token = 'f'.repeat(32)
    fs.writeFileSync(path.join(journalDir(), `${token}.json`), ' '.repeat(MAX_ENTRY_BYTES + 1))
    expect(restoreUndoJournal(dir, token)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    expect(read('pages/Home.tsx')).toBe('mine\n')
  })

  it('neither writes nor reads through a .studio/undo-journal that is a link', () => {
    write('pages/Home.tsx', 'v1\n')
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.symlinkSync(outside, journalDir(), 'junction')

    expect(journaledWrite({ 'pages/Home.tsx': 'v2\n' })).toBeNull()
    expect(fs.readdirSync(outside)).toEqual([])

    const token = 'e'.repeat(32)
    fs.writeFileSync(path.join(outside, `${token}.json`), JSON.stringify({ version: 1, at: 1, files: [{ rel: 'pages/Home.tsx', before: 'pwned', afterSha256: null }] }))
    expect(restoreUndoJournal(dir, token)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    expect(read('pages/Home.tsx')).toBe('v2\n')
  })
})

describe('kept out of git', () => {
  it("this repository ignores a project's .studio/undo-journal/", () => {
    const repoRoot = path.resolve(import.meta.dir, '../../..')
    const probe = `studio-workspace/__canonical-fixture/${UNDO_JOURNAL_DIR}/${'0'.repeat(32)}.json`
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd: repoRoot })
    expect(result.status).toBe(0)
  })

  it("Studio's own commit staging never offers a journal entry", async () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
    write('pages/Home.tsx', 'v1\n')
    expect(journaledWrite({ 'pages/Home.tsx': 'v2\n' })).not.toBeNull()
    const status = await readGitStatus(dir)
    expect('entries' in status).toBe(true)
    if (!('entries' in status)) return
    expect(status.entries.map((entry) => entry.path)).toEqual(['pages/'])
    expect(status.excludedCount).toBeGreaterThan(0)
  })
})
