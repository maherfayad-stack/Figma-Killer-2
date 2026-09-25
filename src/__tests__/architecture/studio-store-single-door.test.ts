/**
 * Gate: every `.studio/` read and write goes through ONE door,
 * `server/handlers/studio/studioStore.ts`.
 *
 * `.studio/` is Studio's control plane inside a user's repository — the trust
 * tier, approved MCP servers, the board, share records, the launcher
 * thumbnail — and a cloned repository can ship any of it as a symlink. The
 * store door refuses a link on every read and write and validates what it
 * reads. Before it, each store built its own `join(dir, '.studio', …)` and
 * called `readFileSync`/`writeFileSync` on it, so each had the hole: the
 * thumbnail route served `~/.ssh/id_rsa` through `.studio/thumbnail.png`, and
 * a board drag overwrote whatever `.studio/boards.json` pointed at.
 *
 * So a server module may not SPELL a `.studio` path: no string or template
 * literal that is `.studio` or starts with `.studio/`, and no use of
 * `STUDIO_STORE_DIR`, outside the door and the few named exceptions below.
 * A store names its file relative to `.studio` (`'boards.json'`) and hands it
 * to the door. Comments are not code and are not scanned; a literal that only
 * MENTIONS `.studio/` mid-sentence (a tool description) does not start with it.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { ts } from 'ts-morph'
import { REPO_ROOT, readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

/** Files that may spell a `.studio` path, and why. Every entry must still need its exception. */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/studioStore.ts', 'The door itself.'],
  [
    'server/handlers/studio/agentCheckpoints.ts',
    'Its own, stricter store: every directory from `.studio` down is lstat-checked, hard links are refused, and it distrusts its own files’ contents (review of #251).',
  ],
  [
    'server/handlers/studio/parseCacheStore.ts',
    'Its own signed store: every directory from `.studio` down is lstat-checked and every entry is HMAC-verified before use.',
  ],
  ['server/handlers/studio/projectWatch.ts', 'A watcher filter: which relative directory names the walk enters. It reads no store.'],
  ['server/ai/mcp/outsideEditReload.ts', 'Classifies a changed relative path. It touches no file.'],
  ['server/handlers/studio/projectDuplicate.ts', 'A directory NAME kept in a copy filter. It reads no store.'],
])

/** Files that may use `STUDIO_STORE_DIR` to name the folder itself, and why. */
const STORE_DIR_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/studioStore.ts', 'The door itself.'],
  ['server/handlers/studio/archiveIngest.ts', 'Asks whether a fresh import target already has a `.studio` entry, and refuses if so. It reads no store.'],
  ['server/handlers/studio/studioLoadMemo.ts', 'A label in the load fingerprint; the read itself goes through the door.'],
])

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || rel.includes('/__tests__/') || /testHelpers?\.ts$/.test(rel)
}

function spellsStudioPath(text: string): boolean {
  return text === '.studio' || text.startsWith('.studio/')
}

interface Hit {
  readonly file: string
  readonly line: number
  readonly what: string
}

function scan(): { literals: Hit[]; storeDirUses: Hit[] } {
  const literals: Hit[] = []
  const storeDirUses: Hit[] = []
  for (const abs of walkSourceTree(join(REPO_ROOT, 'server'))) {
    const rel = toRepoRelativePosix(abs)
    if (isTestFile(rel)) continue
    const text = readSource(abs)
    if (!text.includes('.studio') && !text.includes('STUDIO_STORE_DIR')) continue
    const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) &&
        spellsStudioPath(node.text)
      ) {
        literals.push({ file: rel, line: lineOf(node), what: JSON.stringify(node.text) })
      }
      if (ts.isIdentifier(node) && node.text === 'STUDIO_STORE_DIR') {
        storeDirUses.push({ file: rel, line: lineOf(node), what: 'STUDIO_STORE_DIR' })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { literals, storeDirUses }
}

const { literals, storeDirUses } = scan()

describe('studio-store-single-door', () => {
  it('no server module outside the door spells a .studio path', () => {
    const offenders = literals.filter((hit) => !ALLOWED.has(hit.file)).map((hit) => `${hit.file}:${hit.line} ${hit.what}`)
    expect(offenders).toEqual([])
  })

  it('no server module outside the door names the folder through STUDIO_STORE_DIR', () => {
    const offenders = storeDirUses.filter((hit) => !STORE_DIR_ALLOWED.has(hit.file)).map((hit) => `${hit.file}:${hit.line}`)
    expect(offenders).toEqual([])
  })

  it('every exception is still needed (a stale entry would silently widen the door)', () => {
    const spelled = new Set(literals.map((hit) => hit.file))
    const named = new Set(storeDirUses.map((hit) => hit.file))
    expect([...ALLOWED.keys()].filter((file) => !spelled.has(file))).toEqual([])
    expect([...STORE_DIR_ALLOWED.keys()].filter((file) => !named.has(file))).toEqual([])
  })
})
