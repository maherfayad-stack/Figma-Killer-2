/**
 * Gate: every `.studio/` read and write goes through ONE door,
 * `server/handlers/studio/studioStore.ts`.
 *
 * `.studio/` is Studio's control plane inside a user's repository — the trust
 * tier, approved MCP servers, the board, share records, the launcher
 * thumbnail — and a cloned repository can ship any of it as a symlink. The
 * store door refuses a link (and a hard link) on every read and write,
 * bounds and validates what it reads. Before it, each store built its own
 * `join(dir, '.studio', …)` and called `readFileSync`/`writeFileSync` on it,
 * so each had the hole: the thumbnail route served `~/.ssh/id_rsa` through
 * `.studio/thumbnail.png`, and a board drag overwrote whatever
 * `.studio/boards.json` pointed at.
 *
 * Four rules, each with its named exceptions:
 *
 *  1. No module under `server/` or `src/core/` SPELLS a `.studio` path: no
 *     string or template part (head, middle or tail — `${dir}/.studio/x` is a
 *     middle) that is `.studio` or starts with `.studio/`, `/.studio/` or a
 *     backslash spelling of either. Comments are not code and are not
 *     scanned; a literal that only MENTIONS `.studio/` mid-sentence (a tool
 *     description) does not start with it.
 *  2. `STUDIO_STORE_DIR` (the folder's name) is used only where listed.
 *  3. `studioStorePath` — the door's one function that hands out an absolute
 *     path — is called only by the modules listed, each of which either
 *     names a file (a cache key, a stamp) or hands the path to a writer the
 *     door approved first.
 *  4. The `@core` names that spell a `.studio` path (`CANVAS_LAYER_DIR`,
 *     `canvasLayerRelPath`, `BUNDLE_ARCHIVE_MANIFEST_PATH`) are used in
 *     `server/` only where listed — so a core constant cannot carry a raw
 *     `.studio` path past rule 1.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { ts } from 'ts-morph'
import { REPO_ROOT, readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

/** Rule 1: files that may spell a `.studio` path, and why. */
const SPELLING_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/studioStore.ts', 'The door itself.'],
  [
    'server/handlers/studio/agentCheckpointStore.ts',
    'Its own, stricter store: realpath per segment, hard links refused, O_NOFOLLOW + fstat inode checks, and it distrusts its own files’ contents.',
  ],
  [
    'server/handlers/studio/parseCacheStore.ts',
    'Its own signed store: every directory from `.studio` down is lstat-checked and every entry is HMAC-verified with a key kept outside the project.',
  ],
  ['server/handlers/studio/projectDuplicate.ts', 'A directory NAME kept in a copy filter. It reads no store.'],
  ['src/core/studio-board/canvasLayers.ts', '`CANVAS_LAYER_DIR` / `canvasLayerRelPath`: the layer id grammar. Rule 4 polices who uses them.'],
  ['src/core/data/bundleArchive.ts', '`BUNDLE_ARCHIVE_MANIFEST_PATH`: an entry name inside a CMS export ZIP, never a file on disk. Rule 4 polices it.'],
  ['src/core/page-parser/workspaceFiles.ts', 'A directory NAME in the walk exclusions. It opens nothing.'],
  ['src/core/studio-runtime/vitePlugin.ts', 'A directory NAME in the Vite plugin’s walk exclusions. It opens nothing.'],
])

/** Rule 2: files that may use `STUDIO_STORE_DIR`, and why. */
const STORE_DIR_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/studioStore.ts', 'The door itself.'],
  ['server/handlers/studio/archiveIngest.ts', 'Asks whether a fresh import target already has a `.studio` entry, and refuses if so. It reads no store.'],
])

/** Rule 3: modules that may call `studioStorePath`, and why. */
const STORE_PATH_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/studioStore.ts', 'The door itself.'],
  ['server/handlers/studio/boardGeometry.ts', '`boardsFilePath`: names the file for a cache key and the shell’s stamp; `lstat` only.'],
  ['server/handlers/studio/studioMeta.ts', '`studioMetaFile`: names the file for the shell’s input stamp; `lstat` only.'],
  ['server/handlers/studio/prototypeStore.ts', '`prototypeFilePath`: names the file for the shell’s input stamp; `lstat` only.'],
  ['server/handlers/studio/commentsStore.ts', '`commentsFilePath`: names the file for tests and callers that stat it.'],
  ['server/handlers/studioFramework.ts', '`studioFrameworkFilePath`: names the file for the compare verdict cache key.'],
  ['server/handlers/studio/projectThumbnailFile.ts', '`projectThumbnailFile`: names the file in the capture result. Reads and writes use the door.'],
  ['server/handlers/studio/shareStore.ts', '`shareSnapshotDir`: names the folder for tests. Reads and writes use the door.'],
  ['server/handlers/studio/assetLanding.ts', 'The design-reference folder, checked link-free by `isStudioStorePathUnlinked` first; the landing then creates each file exclusively.'],
  ['server/handlers/studio/componentBundle.ts', 'The bundle worker’s output path, checked link-free first; a separate process writes it.'],
  ['server/handlers/studio/canvasLayerFiles.ts', '`canvasLayerFilePath`: the layer module path, returned only when link-free, for the writeback and the parse.'],
])

/** Rule 4: core names that spell a `.studio` path, and where `server/` may use them. */
const CORE_STUDIO_NAMES = ['CANVAS_LAYER_DIR', 'canvasLayerRelPath', 'BUNDLE_ARCHIVE_MANIFEST_PATH'] as const
const CORE_NAME_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['server/handlers/studio/canvasLayerFiles.ts', 'The layer files’ own module: checks `CANVAS_LAYER_DIR` is `.studio/canvas` and builds store paths from the id.'],
  ['server/handlers/studio/canvasLayerLoad.ts', 'The layer’s relative path as its page label; the parse reads `canvasLayerFilePath`.'],
  ['server/handlers/studio/studioLoadMemo.ts', 'The layer’s relative path as a fingerprint label; the stamp reads `canvasLayerFilePath`.'],
  ['server/handlers/studioCanvasLayerWriteback.ts', 'The layer’s relative path as a node id and an import base; writes go through `canvasLayerFilePath`.'],
  ['server/handlers/studio/projectWatch.ts', 'A watcher filter: which relative directory names the walk enters. It opens no store.'],
  ['server/ai/mcp/outsideEditReload.ts', 'Classifies a changed relative path. It touches no file.'],
  ['server/handlers/cms/export.ts', 'An entry name inside the CMS export ZIP.'],
  ['server/handlers/cms/importArchive.ts', 'An entry name inside the CMS export ZIP.'],
])

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || rel.includes('/__tests__/') || /testHelpers?\.ts$/.test(rel)
}

/** `.studio`, `.studio/…`, `/.studio/…` — backslash spellings folded to `/` first. */
function spellsStudioPath(text: string): boolean {
  return /^\/?\.studio(?:\/|$)/.test(text.replace(/\\/g, '/'))
}

interface Hit {
  readonly file: string
  readonly line: number
  readonly what: string
}

interface Scan {
  literals: Hit[]
  storeDirUses: Hit[]
  storePathCalls: Hit[]
  coreNameUses: Hit[]
}

function scan(): Scan {
  const out: Scan = { literals: [], storeDirUses: [], storePathCalls: [], coreNameUses: [] }
  const files = [...walkSourceTree(join(REPO_ROOT, 'server')), ...walkSourceTree(join(REPO_ROOT, 'src', 'core'))]
  for (const abs of files) {
    const rel = toRepoRelativePosix(abs)
    if (isTestFile(rel)) continue
    const text = readSource(abs)
    const inServer = rel.startsWith('server/')
    const mentionsCoreName = inServer && CORE_STUDIO_NAMES.some((name) => text.includes(name))
    if (!text.includes('.studio') && !text.includes('STUDIO_STORE_DIR') && !text.includes('studioStorePath') && !mentionsCoreName) continue
    const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const hit = (node: ts.Node, what: string): Hit => ({
      file: rel,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
    })
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        spellsStudioPath(node.text)
      ) {
        out.literals.push(hit(node, JSON.stringify(node.text)))
      }
      if (ts.isIdentifier(node)) {
        if (node.text === 'STUDIO_STORE_DIR') out.storeDirUses.push(hit(node, node.text))
        if (node.text === 'studioStorePath' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          out.storePathCalls.push(hit(node, node.text))
        }
        if (inServer && (CORE_STUDIO_NAMES as readonly string[]).includes(node.text)) out.coreNameUses.push(hit(node, node.text))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return out
}

const found = scan()

function offenders(hits: readonly Hit[], allowed: ReadonlyMap<string, string>): string[] {
  return hits.filter((hit) => !allowed.has(hit.file)).map((hit) => `${hit.file}:${hit.line} ${hit.what}`)
}

function staleEntries(hits: readonly Hit[], allowed: ReadonlyMap<string, string>): string[] {
  const seen = new Set(hits.map((hit) => hit.file))
  return [...allowed.keys()].filter((file) => !seen.has(file))
}

describe('studio-store-single-door', () => {
  it('rule 1: no module outside the door spells a .studio path (any template part, any separator)', () => {
    expect(offenders(found.literals, SPELLING_ALLOWED)).toEqual([])
  })

  it('rule 2: no module outside the door names the folder through STUDIO_STORE_DIR', () => {
    expect(offenders(found.storeDirUses, STORE_DIR_ALLOWED)).toEqual([])
  })

  it('rule 3: only the listed modules take an absolute store path from studioStorePath', () => {
    expect(offenders(found.storePathCalls, STORE_PATH_ALLOWED)).toEqual([])
  })

  it('rule 4: the core names that spell a .studio path are used in server/ only where listed', () => {
    expect(offenders(found.coreNameUses, CORE_NAME_ALLOWED)).toEqual([])
  })

  it('every exception is still needed (a stale entry would silently widen the door)', () => {
    expect(staleEntries(found.literals, SPELLING_ALLOWED)).toEqual([])
    expect(staleEntries(found.storeDirUses, STORE_DIR_ALLOWED)).toEqual([])
    expect(staleEntries(found.storePathCalls, STORE_PATH_ALLOWED)).toEqual([])
    expect(staleEntries(found.coreNameUses, CORE_NAME_ALLOWED)).toEqual([])
  })

  it('catches the spellings it claims to (a template middle, a backslash, a leading slash)', () => {
    expect(spellsStudioPath('/.studio/x')).toBe(true)
    expect(spellsStudioPath('.studio\\meta.json')).toBe(true)
    expect(spellsStudioPath('\\.studio\\meta.json')).toBe(true)
    expect(spellsStudioPath('.studio')).toBe(true)
    expect(spellsStudioPath('a sentence about .studio/meta.json')).toBe(false)
    expect(spellsStudioPath('.studiox')).toBe(false)
  })
})
