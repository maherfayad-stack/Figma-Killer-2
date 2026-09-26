/**
 * `studioStore.ts` — every `.studio/` read and write refuses a link.
 *
 * A repository cloned from GitHub can carry symlinks (git stores them), and
 * `.studio/` arrives with it. Before the one store door, every store called
 * `readFileSync`/`writeFileSync` on its own `join(dir, '.studio', …)`:
 *
 *   - `.studio/thumbnail.png -> ~/.ssh/id_rsa` and the launcher's thumbnail
 *     route served the key;
 *   - `.studio/boards.json -> ~/.bashrc` and the next board drag overwrote it;
 *   - `.studio -> <somewhere>` holding a `meta.json` with `trust: 'run-project'`
 *     and the project read a trust tier nobody granted;
 *   - a DANGLING `.studio/comments.json -> <anywhere>` and the first comment
 *     created a file there.
 *
 * Every case below is driven with the link in place and asserts both halves:
 * Studio did not act on what the link points at, and what it points at is
 * unchanged. Directory links are junctions (no privilege needed on Windows);
 * file links need symlink permission, and a test that cannot make one skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBoardsFile, serializeBoardsFile, upsertBoard, createBoard } from '@core/studio-board'
import { readBoardsFile, writeBoardsFile } from '../boardGeometry'
import { readStudioMeta, writeStudioMeta } from '../studioMeta'
import { readCommentsFile, writeCommentsFile } from '../commentsStore'
import { readProjectThumbnailBytes, readProjectThumbnailStat, writeProjectThumbnail } from '../projectThumbnailFile'
import { serveProjectThumbnail } from '../projectThumbnailRoute'
import { appendAgentTurnSummary, readAgentTurnSummaries } from '../agentTurnLog'
import {
  STUDIO_STORE_DEFAULT_MAX_BYTES,
  StudioStoreLinkError,
  appendStudioStoreText,
  readStudioStoreJson,
  readStudioStoreText,
  removeStudioStoreEntry,
  stripStudioStoreLinks,
  studioStorePath,
  writeStudioStoreJson,
} from '../studioStore'
import { Type } from '@core/utils/typeboxHelpers'

let dir: string
let outside: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-links-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-outside-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function studioDir(): string {
  const d = path.join(dir, '.studio')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** A file symlink, or `false` when this process may not make one. */
function linkFile(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, 'file')
    return true
  } catch {
    return false
  }
}

function linkDir(target: string, at: string): void {
  fs.symlinkSync(target, at, 'junction')
}

const SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n'

describe('a file link inside .studio', () => {
  it('boards.json -> an outside file: never read from, never written through', () => {
    const victim = path.join(outside, 'bashrc')
    const outsideBoards = serializeBoardsFile(upsertBoard(createBoardsFile(), createBoard('b1', 'Planted')))
    fs.writeFileSync(victim, outsideBoards)
    if (!linkFile(victim, path.join(studioDir(), 'boards.json'))) return

    expect(readBoardsFile(dir).boards).toEqual([])
    expect(() => writeBoardsFile(dir, createBoardsFile())).toThrow(StudioStoreLinkError)
    expect(fs.readFileSync(victim, 'utf8')).toBe(outsideBoards)
  })

  it('thumbnail.png -> a private key: the route answers 404, never the key', () => {
    const key = path.join(outside, 'id_rsa')
    fs.writeFileSync(key, SECRET)
    if (!linkFile(key, path.join(studioDir(), 'thumbnail.png'))) return

    expect(readProjectThumbnailStat(dir)).toBeNull()
    expect(readProjectThumbnailBytes(dir)).toBeNull()
    const res = serveProjectThumbnail(new Request('http://localhost/admin/api/studio/thumbnail'), dir)
    expect(res.status).toBe(404)

    // …and a capture never overwrites it either.
    expect(() => writeProjectThumbnail(dir, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(StudioStoreLinkError)
    expect(fs.readFileSync(key, 'utf8')).toBe(SECRET)
  })

  it('a DANGLING comments.json link: the first comment creates nothing where it points', () => {
    const planted = path.join(outside, 'planted.json')
    if (!linkFile(planted, path.join(studioDir(), 'comments.json'))) return

    expect(readCommentsFile(dir).threads).toEqual([])
    expect(() => writeCommentsFile(dir, readCommentsFile(dir))).toThrow(StudioStoreLinkError)
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('agent-turns.jsonl -> an outside file: a turn line is never appended there', () => {
    const victim = path.join(outside, 'profile')
    fs.writeFileSync(victim, 'export PATH=/usr/bin\n')
    if (!linkFile(victim, path.join(studioDir(), 'agent-turns.jsonl'))) return

    appendAgentTurnSummary(dir, {
      kind: 'turn',
      at: 0,
      conversationId: 'c1',
      provider: 'anthropic',
      model: 'm',
      conversationModel: 'm',
      modelMode: 'default',
      role: 'build',
      durationMs: 1,
      rounds: 1,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      outcome: 'ok',
    })

    expect(fs.readFileSync(victim, 'utf8')).toBe('export PATH=/usr/bin\n')
    expect(readAgentTurnSummaries(dir)).toEqual([])
  })
})

describe('a hard link inside .studio', () => {
  it('thumbnail.png hard-linked to a key: never read, never appended through', () => {
    const key = path.join(outside, 'id_rsa')
    fs.writeFileSync(key, SECRET)
    try {
      fs.linkSync(key, path.join(studioDir(), 'thumbnail.png'))
    } catch {
      return // another volume, or no hard links on this filesystem
    }
    expect(readProjectThumbnailBytes(dir)).toBeNull()
    expect(readProjectThumbnailStat(dir)).toBeNull()

    fs.linkSync(key, path.join(studioDir(), 'agent-turns.jsonl'))
    expect(() => appendStudioStoreText(dir, 'agent-turns.jsonl', 'x\n')).toThrow(StudioStoreLinkError)
    expect(fs.readFileSync(key, 'utf8')).toBe(SECRET)
  })
})

describe('reads are size-bounded', () => {
  it('a store file over the bound reads as absent, never loaded', () => {
    fs.writeFileSync(path.join(studioDir(), 'boards.json'), `{"version":1,"boards":[]}${' '.repeat(64)}`)
    expect(readStudioStoreText(dir, 'boards.json', { maxBytes: 32 })).toBeNull()
    expect(readStudioStoreText(dir, 'boards.json')).not.toBeNull()
    expect(STUDIO_STORE_DEFAULT_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024)
  })
})

describe('.studio itself a link', () => {
  it('reads no trust tier from where it points, and writes nothing there', () => {
    const planted = JSON.stringify({ trust: 'run-project', approvedMcpServers: ['evil'] })
    fs.writeFileSync(path.join(outside, 'meta.json'), planted)
    linkDir(outside, path.join(dir, '.studio'))

    expect(readStudioMeta(dir)).toEqual({})
    expect(() => writeStudioMeta(dir, { displayName: 'mine' })).toThrow(StudioStoreLinkError)
    expect(fs.readFileSync(path.join(outside, 'meta.json'), 'utf8')).toBe(planted)
    expect(fs.readdirSync(outside)).toEqual(['meta.json'])
  })

  it('refuses a link that stays INSIDE the project too — a store is never reached through one', () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    linkDir(path.join(dir, 'src'), path.join(dir, '.studio'))

    expect(() => writeStudioMeta(dir, { displayName: 'mine' })).toThrow(StudioStoreLinkError)
    expect(fs.existsSync(path.join(dir, 'src', 'meta.json'))).toBe(false)
  })
})

describe('store paths are Studio-shaped', () => {
  it('refuses anything that could climb or alias', () => {
    for (const rel of ['../meta.json', 'cache/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'meta.json.', 'meta.json ', 'meta.json:stream', '', 'a//b']) {
      expect(() => studioStorePath(dir, rel)).toThrow()
    }
    expect(studioStorePath(dir, 'cache/agent/0123456789abcdef/turnWrites.json')).toBe(
      path.join(dir, '.studio', 'cache', 'agent', '0123456789abcdef', 'turnWrites.json'),
    )
  })

  it('validates what it reads, falling back on the wrong shape', () => {
    const Schema = Type.Object({ n: Type.Number() })
    fs.writeFileSync(path.join(studioDir(), 'x.json'), '{"n":"not a number"}')
    expect(readStudioStoreJson(dir, 'x.json', Schema, null)).toBeNull()
    writeStudioStoreJson(dir, 'x.json', { n: 3 })
    expect(readStudioStoreJson(dir, 'x.json', Schema, null)).toEqual({ n: 3 })
  })
})

describe('removing a store folder never follows a link inside it', () => {
  it('removes the link, keeps what it pointed at', () => {
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    fs.mkdirSync(path.join(studioDir(), 'shares', 'tok'), { recursive: true })
    linkDir(outside, path.join(dir, '.studio', 'shares', 'tok', 'frames'))

    removeStudioStoreEntry(dir, 'shares/tok', { recursive: true })

    expect(fs.existsSync(path.join(dir, '.studio', 'shares', 'tok'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
})

describe('stripStudioStoreLinks — a cloned .studio made link-free', () => {
  it('removes a .studio that is itself a link, and nothing it points at', () => {
    fs.writeFileSync(path.join(outside, 'meta.json'), '{}')
    linkDir(outside, path.join(dir, '.studio'))

    expect(stripStudioStoreLinks(dir)).toEqual({ rootReplaced: true, removed: [] })
    expect(fs.existsSync(path.join(dir, '.studio'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'meta.json'), 'utf8')).toBe('{}')
  })

  it('removes every link inside a real .studio at any depth, and keeps every plain file', () => {
    fs.writeFileSync(path.join(outside, 'id_rsa'), SECRET)
    const board = serializeBoardsFile(createBoardsFile())
    fs.writeFileSync(path.join(studioDir(), 'boards.json'), board)
    fs.mkdirSync(path.join(dir, '.studio', 'references'), { recursive: true })
    linkDir(outside, path.join(dir, '.studio', 'cache'))
    const fileLinked = linkFile(path.join(outside, 'id_rsa'), path.join(dir, '.studio', 'references', 'thumbnail.png'))

    const result = stripStudioStoreLinks(dir)

    expect(result.rootReplaced).toBe(false)
    expect([...result.removed].sort()).toEqual(fileLinked ? ['cache', 'references/thumbnail.png'] : ['cache'])
    expect(fs.readFileSync(path.join(dir, '.studio', 'boards.json'), 'utf8')).toBe(board)
    expect(fs.existsSync(path.join(dir, '.studio', 'cache'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'id_rsa'), 'utf8')).toBe(SECRET)
  })

  it('leaves a project with no .studio alone', () => {
    expect(stripStudioStoreLinks(dir)).toEqual({ rootReplaced: false, removed: [] })
  })
})
