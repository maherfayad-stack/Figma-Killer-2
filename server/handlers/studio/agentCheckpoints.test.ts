/**
 * AI-7 — per-turn pre-image checkpoints and the user's revert.
 *
 * The revert cases double as the security-guard threat list for this module:
 * a revert may land nowhere an agent write could not (outside the project,
 * `.studio/`, `.git/`, `.claude/`, `prototype/`, a host-executed config, a
 * link out, a hard link), and it never overwrites a file somebody changed
 * after the agent did.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_TURNS_KEPT,
  beginAgentCheckpointTurn,
  captureAgentPreImage,
  conversationCheckpointKey,
  listAgentCheckpointTurns,
  readAgentCheckpointDiff,
  recordAgentPostImage,
  revertAgentCheckpoint,
} from './agentCheckpoints'
import { readGitStatus } from './gitOperations'

const USER = 'a1b2c3d4e5f60718'
const OTHER_USER = '00112233445566ff'
const CONVERSATION = 'conv-1'
const CONV_KEY = conversationCheckpointKey(CONVERSATION)

let dir: string
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-checkpoints-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function abs(rel: string): string {
  return path.join(dir, ...rel.split('/'))
}
function write(rel: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), contents)
}
function read(rel: string): Buffer {
  return fs.readFileSync(abs(rel))
}

/** What an agent write looks like to this module: pre-image, the write, post-image. */
function agentWrite(rel: string, contents: string | Buffer, userKey = USER, convKey = CONV_KEY): void {
  captureAgentPreImage(dir, userKey, convKey, abs(rel))
  write(rel, contents)
  recordAgentPostImage(dir, userKey, convKey, abs(rel))
}

describe('agentCheckpoints — capture', () => {
  it('lists what a turn changed: a modified file with line counts, and a created one', () => {
    write('pages/Home.tsx', 'a\nb\nc\n')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('pages/Home.tsx', 'a\nB\nc\nd\n')
    agentWrite('pages/New.tsx', 'x\n')

    const turns = listAgentCheckpointTurns(dir, USER, CONVERSATION)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnId).toBe('turn1')
    expect(turns[0]!.files).toEqual([
      { path: 'pages/Home.tsx', change: 'modified', state: 'current', revertable: true, reason: null, added: 2, removed: 1 },
      { path: 'pages/New.tsx', change: 'created', state: 'current', revertable: true, reason: null, added: 1, removed: 0 },
    ])
  })

  it('keeps the FIRST pre-image and the LAST post-image of a file written several times in one turn', () => {
    write('a.css', 'v0')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('a.css', 'v1')
    agentWrite('a.css', 'v2')
    const diff = readAgentCheckpointDiff(dir, USER, CONVERSATION, 'turn1', 'a.css')
    expect(diff).toMatchObject({ ok: true, added: 1, removed: 1 })
    expect(diff.ok && diff.diff).toContain('-v0')
    expect(diff.ok && diff.diff).toContain('+v2')
    expect(diff.ok && diff.diff).not.toContain('v1')
  })

  it('records nothing when no turn is open, and a write the gate refused (pre, no post) is not listed', () => {
    captureAgentPreImage(dir, USER, CONV_KEY, abs('x.ts'))
    write('x.ts', '1')
    recordAgentPostImage(dir, USER, CONV_KEY, abs('x.ts'))
    expect(fs.existsSync(path.join(dir, '.studio', 'agent-checkpoints'))).toBe(false)

    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    captureAgentPreImage(dir, USER, CONV_KEY, abs('refused.ts'))
    expect(listAgentCheckpointTurns(dir, USER, CONVERSATION)).toEqual([])
  })

  it('a write with no pre-image (the hook did not run) lists, but never offers a revert', () => {
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    write('y.ts', 'agent')
    recordAgentPostImage(dir, USER, CONV_KEY, abs('y.ts'))
    const file = listAgentCheckpointTurns(dir, USER, CONVERSATION)[0]!.files[0]!
    expect(file).toMatchObject({ path: 'y.ts', revertable: false })
    expect(file.reason).toContain('could not record')
  })

  it('ignores a path outside the project', () => {
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    const outside = path.join(dir, '..', `outside-${path.basename(dir)}.ts`)
    captureAgentPreImage(dir, USER, CONV_KEY, outside)
    recordAgentPostImage(dir, USER, CONV_KEY, outside)
    expect(listAgentCheckpointTurns(dir, USER, CONVERSATION)).toEqual([])
  })

  it('refuses a turn id that is not a safe path segment', () => {
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: '../escape' })
    expect(fs.existsSync(path.join(dir, '.studio', 'agent-checkpoints'))).toBe(false)
  })

  it(`keeps the newest ${MAX_TURNS_KEPT} turns per account`, () => {
    for (let i = 0; i < MAX_TURNS_KEPT + 3; i++) {
      beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: `t${i}`, atMs: 1000 + i })
      agentWrite('f.ts', String(i))
    }
    const turns = listAgentCheckpointTurns(dir, USER, CONVERSATION)
    expect(turns).toHaveLength(MAX_TURNS_KEPT)
    expect(turns[0]!.turnId).toBe('t3')
  })
})

describe('agentCheckpoints — revert (compare-and-swap)', () => {
  it('Revert turn restores every file byte-identically, and deletes a file the turn created', async () => {
    const original = Buffer.from('line 1\r\nline 2\r\né\r\n', 'utf8')
    write('pages/Home.tsx', original)
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('pages/Home.tsx', 'rewritten\n')
    agentWrite('pages/Home.module.css', '.a{}\n')

    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1')
    expect(outcome).toEqual({ ok: true, reverted: ['pages/Home.module.css', 'pages/Home.tsx'] })
    expect(read('pages/Home.tsx').equals(original)).toBe(true)
    expect(fs.existsSync(abs('pages/Home.module.css'))).toBe(false)
    const files = listAgentCheckpointTurns(dir, USER, CONVERSATION)[0]!.files
    expect(files.every((f) => f.state === 'reverted' && !f.revertable)).toBe(true)
  })

  it('refuses the whole turn, writing nothing, when the user edited one file since; the other still reverts on its own', async () => {
    write('a.tsx', 'A0')
    write('b.tsx', 'B0')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('a.tsx', 'A1')
    agentWrite('b.tsx', 'B1')
    write('b.tsx', 'B1 + the user\'s own edit')

    const listed = listAgentCheckpointTurns(dir, USER, CONVERSATION)[0]!.files
    expect(listed.find((f) => f.path === 'b.tsx')).toMatchObject({ state: 'changed-since', revertable: false })

    const whole = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1')
    expect(whole.ok).toBe(false)
    expect(!whole.ok && whole.code).toBe('changed-since')
    expect(!whole.ok && whole.message).toContain('"b.tsx"')
    expect(read('a.tsx').toString()).toBe('A1')
    expect(read('b.tsx').toString()).toBe('B1 + the user\'s own edit')

    expect(await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1', ['a.tsx'])).toEqual({ ok: true, reverted: ['a.tsx'] })
    expect(read('a.tsx').toString()).toBe('A0')
    const perFile = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1', ['b.tsx'])
    expect(!perFile.ok && perFile.code).toBe('changed-since')
    expect(read('b.tsx').toString()).toBe('B1 + the user\'s own edit')
  })

  it('refuses a second revert of the same file', async () => {
    write('a.tsx', 'A0')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('a.tsx', 'A1')
    expect((await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1')).ok).toBe(true)
    const again = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1')
    expect(!again.ok && again.code).toBe('already-reverted')
  })

  it('another account can neither see nor revert this turn', async () => {
    write('a.tsx', 'A0')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('a.tsx', 'A1')
    expect(listAgentCheckpointTurns(dir, OTHER_USER, CONVERSATION)).toEqual([])
    const outcome = await revertAgentCheckpoint(dir, OTHER_USER, CONVERSATION, 'turn1')
    expect(!outcome.ok && outcome.code).toBe('not-found')
    expect(read('a.tsx').toString()).toBe('A1')
  })

  it('refuses a malformed turn id', async () => {
    const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, '../../etc')
    expect(!outcome.ok && outcome.code).toBe('not-found')
  })

  /**
   * A checkpoint record is a file under `.studio/`, which no agent can write —
   * but a revert must not TRUST it: every restore goes back through the agent
   * write gate. Each case forges a record naming a forbidden path and checks
   * the target is untouched.
   */
  describe('never restores into a place an agent write could not reach (forged records)', () => {
    const forbidden: Array<[string, string]> = [
      ['.git/hooks/pre-commit', 'protected-path'],
      ['.claude/settings.local.json', 'protected-path'],
      ['.studio/meta.json', 'protected-path'],
      ['prototype/studioRuntime.generated.js', 'protected-path'],
      ['vite.config.js', 'needs-user'],
      ['package.json', 'needs-user'],
    ]
    for (const [rel, code] of forbidden) {
      it(`${rel} → ${code}`, async () => {
        write(rel, 'agent-version')
        beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'forged' })
        forgeRecord('forged', rel, 'EVIL', 'agent-version')
        const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
        expect(outcome.ok).toBe(false)
        expect(!outcome.ok && outcome.code).toBe(code)
        expect(read(rel).toString()).toBe('agent-version')
      })
    }

    it('a path that climbs out of the project', async () => {
      const victim = path.join(path.dirname(dir), `victim-${path.basename(dir)}.txt`)
      fs.writeFileSync(victim, 'agent-version')
      try {
        beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'forged' })
        forgeRecord('forged', `../${path.basename(victim)}`, 'EVIL', 'agent-version')
        const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
        expect(!outcome.ok && outcome.code).toBe('path-outside-project')
        expect(fs.readFileSync(victim, 'utf8')).toBe('agent-version')
      } finally {
        fs.rmSync(victim, { force: true })
      }
    })

    it('a symlink inside the project that points out of it', async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-checkpoint-outside-')))
      try {
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'agent-version')
        try {
          fs.symlinkSync(outside, abs('linked'), 'junction')
        } catch {
          return // no permission to create links on this machine: the case cannot be staged
        }
        beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'forged' })
        forgeRecord('forged', 'linked/secret.txt', 'EVIL', 'agent-version')
        const outcome = await revertAgentCheckpoint(dir, USER, CONVERSATION, 'forged')
        expect(!outcome.ok && outcome.code).toBe('path-outside-project')
        expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('agent-version')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})

/** Write a checkpoint entry by hand, as something other than the capture functions might. */
function forgeRecord(turnId: string, rel: string, pre: string, post: string): void {
  const filesDir = path.join(dir, '.studio', 'agent-checkpoints', USER, turnId, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const key = createHash('sha256').update(rel).digest('hex').slice(0, 24)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(filesDir, `${key}.pre`), pre)
  fs.writeFileSync(path.join(filesDir, `${key}.json`), JSON.stringify({ path: rel, existed: true, hash: hash(pre), bytes: pre.length, tooLarge: false, atMs: 1 }))
  fs.writeFileSync(path.join(filesDir, `${key}.post`), post)
  fs.writeFileSync(path.join(filesDir, `${key}.post.json`), JSON.stringify({ hash: hash(post), bytes: post.length, tooLarge: false, added: null, removed: null, atMs: 2 }))
}

describe('agentCheckpoints — kept out of git', () => {
  it('this repository ignores a project\'s .studio/agent-checkpoints/', () => {
    const repoRoot = path.resolve(import.meta.dir, '../../..')
    const probe = 'studio-workspace/__canonical-fixture/.studio/agent-checkpoints/0123456789abcdef/turn1/files/x.pre'
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd: repoRoot })
    expect(result.status).toBe(0)
  })

  it("Studio's own commit staging never offers a checkpoint file", async () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
    write('pages/Home.tsx', 'x')
    beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
    agentWrite('pages/Home.tsx', 'y')
    const status = await readGitStatus(dir)
    expect('entries' in status).toBe(true)
    if (!('entries' in status)) return
    expect(status.entries.map((e) => e.path)).toEqual(['pages/'])
    expect(status.entries.some((e) => e.path.startsWith('.studio'))).toBe(false)
    expect(status.excludedCount).toBeGreaterThan(0)
  })
})
