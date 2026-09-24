/**
 * Review of #251 — the checkpoint store does not trust its own files.
 *
 * `.studio/` is out of every agent's reach, but not out of `git pull`'s or a
 * local process's. Each case plants something in the store the way such a
 * writer could, and checks that a revert or a diff neither reads nor writes
 * through it. The reviewer's probe (a pre-image that is a symlink to a key
 * outside the project) is the first case, with the record's hash set to the
 * key's REAL hash — the worst case, where only the no-follow read stands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  beginAgentCheckpointTurn,
  captureAgentPreImage,
  conversationCheckpointKey,
  listAgentCheckpointTurns,
  readAgentCheckpointDiff,
  recordAgentPostImage,
  revertAgentCheckpoint,
} from './agentCheckpoints'
import { contentHash } from './agentFileAccess'

const USER = 'a1b2c3d4e5f60718'
const CONVERSATION = 'conv-1'
const CONV_KEY = conversationCheckpointKey(CONVERSATION)
const SECRET = '-----BEGIN OPENSSH PRIVATE KEY----- SECRET'

let dir: string
let outside: string
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ckpt-forgery-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ckpt-outside-')))
  fs.writeFileSync(path.join(outside, 'id_rsa'), SECRET)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function write(rel: string, contents: string | Buffer): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
}
const read = (rel: string) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
const keyOf = (rel: string) => createHash('sha256').update(rel).digest('hex').slice(0, 24)
const filesDir = (turnId: string) => path.join(dir, '.studio', 'agent-checkpoints', USER, turnId, 'files')

/** A turn whose record for `pages/a.tsx` says the pre-image hashes to `preHash`; the pre-image blob itself is left to the caller. */
function forgeTurn(turnId: string, conversationId: string, preHash: string): string {
  write('pages/a.tsx', 'AGENT VERSION')
  const files = filesDir(turnId)
  fs.mkdirSync(files, { recursive: true })
  fs.writeFileSync(path.join(files, '..', 'turn.json'), JSON.stringify({ turnId, conversationId, startedAtMs: 1 }))
  const key = keyOf('pages/a.tsx')
  fs.writeFileSync(path.join(files, `${key}.json`), JSON.stringify({ path: 'pages/a.tsx', existed: true, hash: preHash, bytes: 1, tooLarge: false, atMs: 1 }))
  fs.writeFileSync(path.join(files, `${key}.post.json`), JSON.stringify({ hash: contentHash('AGENT VERSION'), bytes: 13, tooLarge: false, added: null, removed: null, atMs: 1 }))
  fs.writeFileSync(path.join(files, `${key}.post`), 'AGENT VERSION')
  return path.join(files, `${key}.pre`)
}

function trySymlink(target: string, link: string, type: 'file' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type)
    return true
  } catch {
    return false // no permission to create links here: the case cannot be staged
  }
}

describe('a forged checkpoint is never restored or shown', () => {
  it('a pre-image that is a SYMLINK to a key outside the project — even with the key\'s real hash — is not read', async () => {
    const pre = forgeTurn('forged', CONVERSATION, contentHash(SECRET))
    if (!trySymlink(path.join(outside, 'id_rsa'), pre, 'file')) return
    const diff = readAgentCheckpointDiff(dir, USER, CONVERSATION, 'forged', 'pages/a.tsx')
    expect(JSON.stringify(diff)).not.toContain('PRIVATE KEY')
    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
    expect(outcome.ok).toBe(false)
    expect(read('pages/a.tsx')).toBe('AGENT VERSION')
  })

  it('a pre-image that is a HARD LINK to a file outside the project is not read', async () => {
    const pre = forgeTurn('forged', CONVERSATION, contentHash(SECRET))
    fs.linkSync(path.join(outside, 'id_rsa'), pre)
    expect(JSON.stringify(readAgentCheckpointDiff(dir, USER, CONVERSATION, 'forged', 'pages/a.tsx'))).not.toContain('PRIVATE KEY')
    expect((await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')).ok).toBe(false)
    expect(read('pages/a.tsx')).toBe('AGENT VERSION')
  })

  it('a pre-image whose bytes do not hash to its record is not restored', async () => {
    const pre = forgeTurn('forged', CONVERSATION, contentHash('what the file really held'))
    fs.writeFileSync(pre, 'SWAPPED IN LATER')
    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
    expect(!outcome.ok && outcome.code).toBe('not-checkpointed')
    expect(read('pages/a.tsx')).toBe('AGENT VERSION')
    expect(readAgentCheckpointDiff(dir, USER, CONVERSATION, 'forged', 'pages/a.tsx').ok).toBe(false)
  })

  it('a turn of ANOTHER conversation is not found — for revert and for the diff', async () => {
    const pre = forgeTurn('forged', 'some-other-conversation', contentHash('ORIGINAL'))
    fs.writeFileSync(pre, 'ORIGINAL')
    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
    expect(!outcome.ok && outcome.code).toBe('not-found')
    expect(read('pages/a.tsx')).toBe('AGENT VERSION')
    expect(readAgentCheckpointDiff(dir, USER, CONVERSATION, 'forged', 'pages/a.tsx')).toMatchObject({ ok: false, code: 'not-found' })
    // The turn's own conversation still can.
    expect((await revertAgentCheckpoint(dir, USER, 'some-other-conversation', 'forged')).ok).toBe(true)
  })

  it('an oversized record is ignored, not read whole', () => {
    forgeTurn('forged', CONVERSATION, contentHash('ORIGINAL'))
    const record = path.join(filesDir('forged'), `${keyOf('pages/a.tsx')}.json`)
    const real = fs.readFileSync(record, 'utf8')
    fs.writeFileSync(record, real.replace('"atMs":1', `"atMs":1,"pad":"${'x'.repeat(100 * 1024)}"`))
    expect(listAgentCheckpointTurns(dir, USER, CONVERSATION)).toEqual([])
  })
})

describe('a linked checkpoint store is never used', () => {
  it('a junction at .studio/agent-checkpoints: nothing is written, read or pruned through it', async () => {
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    if (!trySymlink(outside, path.join(dir, '.studio', 'agent-checkpoints'), 'junction')) return
    write('pages/a.tsx', 'BEFORE')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    captureAgentPreImage(dir, USER, CONV_KEY, path.join(dir, 'pages', 'a.tsx'))
    write('pages/a.tsx', 'AFTER')
    recordAgentPostImage(dir, USER, CONV_KEY, path.join(dir, 'pages', 'a.tsx'))
    expect(fs.readdirSync(outside)).toEqual(['id_rsa'])
    expect(listAgentCheckpointTurns(dir, USER, CONVERSATION)).toEqual([])
  })
})

describe('the revert re-checks the file right before it writes (F3)', () => {
  it('a save that lands between the checks and the write is kept, and nothing is reverted', async () => {
    write('a.tsx', 'A0')
    write('b.tsx', 'B0')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    for (const [rel, next] of [['a.tsx', 'A1'], ['b.tsx', 'B1']] as const) {
      captureAgentPreImage(dir, USER, CONV_KEY, path.join(dir, rel))
      write(rel, next)
      recordAgentPostImage(dir, USER, CONV_KEY, path.join(dir, rel))
    }
    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1', undefined, {
      beforeWrite: (abs) => {
        if (abs.endsWith('b.tsx')) fs.writeFileSync(abs, 'B1 + a save from VS Code')
      },
    })
    expect(!outcome.ok && outcome.code).toBe('changed-since')
    expect(read('b.tsx')).toBe('B1 + a save from VS Code')
    expect(read('a.tsx')).toBe('A1') // rolled back: the turn is all-or-nothing
  })
})

describe('credential files are never copied into a checkpoint (F2, second layer)', () => {
  it('a write to a key file is listed, not revertable, not diffable — and no bytes are stored', () => {
    write('certs/server.key', 'OLD KEY')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    captureAgentPreImage(dir, USER, CONV_KEY, path.join(dir, 'certs', 'server.key'))
    write('certs/server.key', 'NEW KEY')
    recordAgentPostImage(dir, USER, CONV_KEY, path.join(dir, 'certs', 'server.key'))

    const stored = fs.readdirSync(filesDir('turn1'))
    expect(stored.some((name) => name.endsWith('.pre') || name.endsWith('.post'))).toBe(false)
    for (const name of stored) expect(fs.readFileSync(path.join(filesDir('turn1'), name), 'utf8')).not.toContain('KEY')
    const file = listAgentCheckpointTurns(dir, USER, CONVERSATION)[0]!.files[0]!
    expect(file).toMatchObject({ path: 'certs/server.key', revertable: false })
    expect(readAgentCheckpointDiff(dir, USER, CONVERSATION, 'turn1', 'certs/server.key')).toMatchObject({ ok: false, code: 'withheld' })
  })
})

describe('listing never re-diffs (F4)', () => {
  it('line counts come from the record written with the post-image', () => {
    write('a.tsx', 'a\nb\n')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    captureAgentPreImage(dir, USER, CONV_KEY, path.join(dir, 'a.tsx'))
    write('a.tsx', 'a\nB\nc\n')
    recordAgentPostImage(dir, USER, CONV_KEY, path.join(dir, 'a.tsx'))
    // With the blobs gone, a list that re-diffed would have nothing to count.
    for (const name of fs.readdirSync(filesDir('turn1'))) {
      if (name.endsWith('.pre') || name.endsWith('.post')) fs.rmSync(path.join(filesDir('turn1'), name))
    }
    expect(listAgentCheckpointTurns(dir, USER, CONVERSATION)[0]!.files[0]).toMatchObject({ added: 2, removed: 1 })
  })
})
