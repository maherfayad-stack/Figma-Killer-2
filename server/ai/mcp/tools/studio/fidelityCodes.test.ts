/**
 * Doc ⇄ code parity gate (WS-9.4). Every code in `ALL_FIDELITY_CODES` must
 * appear in `docs/features/studio-import.md`'s "What still does not import"
 * table, and every backtick-quoted code cell in that table must be a real
 * registered code (or one of the probe's own emitted codes). This is what
 * keeps the doc and the tool's finding vocabulary from drifting apart.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ALL_FIDELITY_CODES } from './fidelityCodes'

const DOC_PATH = path.join(import.meta.dir, '..', '..', '..', '..', '..', 'docs', 'features', 'studio-import.md')

/** Extract every backtick-quoted code from ONLY the first (Code) column of each table row — the Limitation column freely contains its own unrelated backtick-quoted identifiers (`.map`, `className`, …) that must not be mistaken for finding codes. Line-split on `\r?\n` (the doc is CRLF) rather than substring-searching for a blank line. */
function extractTableCodes(doc: string): Set<string> {
  const lines = doc.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim() === '| Code | Limitation |')
  const codes = new Set<string>()
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('|')) break // table ended
    if (line.startsWith('|---')) continue // separator row
    const firstCell = line.split('|')[1] ?? ''
    for (const match of firstCell.matchAll(/`([A-Za-z0-9_.-]+)`/g)) {
      codes.add(match[1]!)
    }
  }
  return codes
}

describe('fidelityCodes doc parity', () => {
  it('finds the doc table', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true)
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    expect(doc).toContain('| Code | Limitation |')
  })

  it('every registered fidelity code appears in the doc table', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    const tableCodes = extractTableCodes(doc)
    for (const def of ALL_FIDELITY_CODES) {
      expect(tableCodes.has(def.code)).toBe(true)
    }
  })

  it('every backtick-quoted code cell in the doc table is a registered code', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    const tableCodes = extractTableCodes(doc)
    const registered = new Set(ALL_FIDELITY_CODES.map((c) => c.code))
    for (const code of tableCodes) {
      expect(registered.has(code)).toBe(true)
    }
  })

  it('has no duplicate codes', () => {
    const codes = ALL_FIDELITY_CODES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
