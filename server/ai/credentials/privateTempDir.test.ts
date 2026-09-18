/**
 * privateTempDir — "a directory only this OS user can open", asserted in the
 * terms the RUNNING platform actually enforces.
 *
 * The point of this file is that it does not skip on Windows. The guarantee
 * differs by platform (mode bits vs. an NTFS DACL) but it exists on both, and
 * a test that asserted only the POSIX half was the reason `claudeCli.test.ts`
 * sat in the pre-existing-failure bucket (`standing-01`). Nothing here mocks
 * the platform call: on Windows the real `icacls` runs.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileProtection } from './fileProtection.testHelpers'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  createPrivateTempDir,
  ensurePrivateDirectory,
  restrictDirectoryToCurrentUser,
  writePrivateFileExclusive,
  writePrivateFileReplacing,
} from './privateTempDir'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'

const created: string[] = []

async function makeDir(): Promise<string> {
  const { dir } = await createPrivateTempDir('studio-private-temp-test-')
  created.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A stand-in for `icacls` that reports whatever exit code the test wants, and records the argv it was given. */
function fakeIcacls(exitCode: number): { spawn: SubprocessSpawnFn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SubprocessSpawnFn = (argv) => {
    calls.push([...argv])
    const proc: SpawnedProcessLike = {
      stdout: streamOf(''),
      stderr: streamOf(exitCode === 0 ? '' : 'Access is denied.'),
      exited: Promise.resolve(exitCode),
      kill() {
        // the fake process has already finished
      },
    }
    return proc
  }
  return { spawn, calls }
}

describe('createPrivateTempDir', () => {
  it('creates the directory inside os.tmpdir() and reports the restriction as applied', async () => {
    const dir = await makeDir()
    expect(existsSync(dir)).toBe(true)
    expect(dir.startsWith(tmpdir())).toBe(true)

    // The value the product hands its caller — `false` would mean the secret
    // file is protected only by whatever `%TEMP%`/`/tmp` inherits.
    const { dir: second, restricted } = await createPrivateTempDir('studio-private-temp-test-')
    created.push(second)
    expect(restricted).toBe(true)
  })

  it('protects the directory in whatever terms this platform enforces', async () => {
    const dir = await makeDir()
    // Written INTO the directory, as the real caller does, so this asserts
    // the protection the SECRET inherits rather than the directory's alone.
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{"token":"not-a-real-token"}', { mode: PRIVATE_FILE_MODE })
    const protection = readFileProtection(file)

    if (process.platform === 'win32') {
      // Exactly one access-control entry, inherited from the directory:
      // `SYSTEM` and `BUILTIN\Administrators` are gone, and so is anyone else.
      expect(protection.acl).toHaveLength(1)
      expect(protection.acl[0]).toEndWith(`${userInfo().username}:(I)(F)`)
    } else {
      expect(protection.dirMode).toBe(PRIVATE_DIR_MODE)
      expect(protection.fileMode).toBe(PRIVATE_FILE_MODE)
    }
  })

  it('leaves nothing readable behind from an earlier run — each call gets its own directory', async () => {
    const a = await makeDir()
    const b = await makeDir()
    expect(a).not.toBe(b)
    expect(dirname(a)).toBe(dirname(b))
  })
})

describe('writePrivateFileExclusive — the pre-create attack, driven', () => {
  it('refuses a name that already exists instead of truncating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-temp-exists-'))
    created.push(dir)
    const path = join(dir, 'mcp-config.json')
    // The attacker's object: it exists BEFORE the secret is written, which in
    // the real race is the `mkdtemp` → `icacls` window.
    writeFileSync(path, 'PLANTED')

    expect(() => {
      writePrivateFileExclusive(path, '{"token":"sk-live-not-a-real-token"}')
    }).toThrow(/EEXIST/)

    // The whole point: the secret is NOT in the attacker's file.
    expect(readFileSync(path, 'utf8')).toBe('PLANTED')
  })

  it('writes normally when the name is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-temp-free-'))
    created.push(dir)
    const path = join(dir, 'mcp-config.json')
    writePrivateFileExclusive(path, '{"ok":true}')
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}')
    if (process.platform !== 'win32') expect(readFileProtection(path).fileMode).toBe(PRIVATE_FILE_MODE)
  })

  it('refuses a name taken by a DIRECTORY too — a planted directory is not a write target either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-temp-dirname-'))
    created.push(dir)
    const path = join(dir, 'mcp-config.json')
    mkdirSync(path)
    expect(() => {
      writePrivateFileExclusive(path, '{"token":"sk-live-not-a-real-token"}')
    }).toThrow()
  })
})

describe('the pre-created file keeps its own DACL through the parent restriction', () => {
  const windowsOnly = process.platform === 'win32' ? it : it.skip

  // This is the measurement that makes the exclusive create load-bearing
  // rather than defensive styling: `/inheritance:r` on the PARENT does not
  // remove an explicit ACE from a child that already exists, so if the write
  // were a plain `'w'` truncate, the secret would land in an object another
  // principal can read.
  windowsOnly('so a plain truncating write would put the secret in a readable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-temp-dacl-'))
    created.push(dir)
    const path = join(dir, 'mcp-config.json')
    writeFileSync(path, 'PLANTED')
    // `BUILTIN\Users` stands in for "some other principal on this machine".
    const granted = Bun.spawnSync(['icacls', path, '/grant', 'BUILTIN\\Users:(R)'])
    expect(granted.exitCode).toBe(0)

    expect(await restrictDirectoryToCurrentUser(dir)).toBe(true)

    // The directory is single-ACE — the restriction worked…
    expect(readFileProtection(dir).acl).toHaveLength(1)
    // …and the planted FILE still grants the other principal read anyway.
    expect(readFileProtection(path).acl.some((ace) => ace.startsWith('BUILTIN\\Users:'))).toBe(true)

    // Which is exactly why the write refuses this name.
    expect(() => {
      writePrivateFileExclusive(path, '{"token":"sk-live-not-a-real-token"}')
    }).toThrow(/EEXIST/)
    expect(readFileSync(path, 'utf8')).toBe('PLANTED')
  })
})

describe('restrictDirectoryToCurrentUser — the Windows branch, driven explicitly', () => {
  const windowsOnly = process.platform === 'win32' ? it : it.skip

  windowsOnly('runs icacls as an argv array with no shell and no interpolated command string', async () => {
    const dir = await makeDir()
    const { spawn, calls } = fakeIcacls(0)
    expect(await restrictDirectoryToCurrentUser(dir, { spawn })).toBe(true)

    expect(calls).toHaveLength(1)
    const argv = calls[0]!
    expect(argv[0]).toBe('icacls')
    expect(argv[1]).toBe(dir)
    // `/inheritance:r` is what removes the ACEs inherited from %TEMP%;
    // without it `/grant:r` would ADD an entry to a list that still names
    // SYSTEM and Administrators, and the directory would not be private.
    expect(argv).toContain('/inheritance:r')
    expect(argv).toContain('/grant:r')
    expect(argv[argv.length - 1]).toBe(`${userInfo().username}:(OI)(CI)(F)`)
    // Nothing is a command string; every element is a separate token.
    expect(argv.some((token) => token.includes('&&') || token.includes('|'))).toBe(false)
  })

  windowsOnly('reports failure rather than throwing when icacls refuses', async () => {
    const dir = await makeDir()
    const { spawn } = fakeIcacls(5)
    const originalError = console.error
    const logged: unknown[][] = []
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      // Fail-soft: the caller writes its file anyway (the directory is still
      // inside %TEMP%), but it is TOLD the restriction did not apply.
      expect(await restrictDirectoryToCurrentUser(dir, { spawn })).toBe(false)
    } finally {
      console.error = originalError
    }
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[ai/privateTempDir]')
    // The log says what happened and names no secret and no account.
    expect(String(logged[0]?.[0])).toContain('inherited ACL')
  })
})

/**
 * `sec-18` — the persistent-directory and rewritable-file halves, added so
 * `mcpServerSecretStore.ts`, `cliMcpConnectionProbe.ts` and `claudeCliEnv.ts`
 * stop each rolling their own `mkdirSync({ mode })` + `chmodSync`, which is
 * the POSIX-only protection this whole module exists because of.
 */
describe('ensurePrivateDirectory', () => {
  it('creates every missing level and protects the leaf in the terms this platform enforces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-private-ensure-'))
    created.push(root)
    const leaf = join(root, 'user-123', 'project-key')

    expect(await ensurePrivateDirectory(leaf)).toBe(true)
    expect(existsSync(leaf)).toBe(true)

    const file = join(leaf, 'server.json')
    writePrivateFileExclusive(file, '{"ciphertext":"not-a-real-secret"}')
    const protection = readFileProtection(file)
    if (process.platform === 'win32') {
      expect(protection.acl).toHaveLength(1)
      expect(protection.acl[0]).toEndWith(`${userInfo().username}:(I)(F)`)
    } else {
      expect(protection.dirMode).toBe(PRIVATE_DIR_MODE)
      expect(protection.fileMode).toBe(PRIVATE_FILE_MODE)
    }
  })

  it('is a no-op that spawns nothing when the directory already exists', async () => {
    const dir = await makeDir()
    const { spawn, calls } = fakeIcacls(0)
    expect(await ensurePrivateDirectory(dir, { spawn })).toBe(true)
    // The steady-state path: the second and every later secret write creates
    // no directory, so it must not pay for a subprocess either.
    expect(calls).toHaveLength(0)
  })

  it('reports failure when the platform call refuses, so the caller can fail closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-private-ensure-fail-'))
    created.push(root)
    const { spawn } = fakeIcacls(5)
    const originalError = console.error
    console.error = () => {
      // the refusal's own log is asserted elsewhere
    }
    try {
      const applied = await ensurePrivateDirectory(join(root, 'leaf'), { spawn })
      // On POSIX `chmodSync` really runs and really succeeds, so the injected
      // `icacls` failure only reaches the answer on Windows.
      expect(applied).toBe(process.platform !== 'win32')
    } finally {
      console.error = originalError
    }
  })
})

describe('writePrivateFileReplacing — a secret store that is legitimately rewritten', () => {
  it('replaces the previous contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-replace-'))
    created.push(dir)
    const path = join(dir, 'server.json')
    writePrivateFileReplacing(path, '{"v":1}')
    writePrivateFileReplacing(path, '{"v":2}')
    expect(readFileSync(path, 'utf8')).toBe('{"v":2}')
    if (process.platform !== 'win32') expect(readFileProtection(path).fileMode).toBe(PRIVATE_FILE_MODE)
  })

  it('leaves no staging file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-replace-clean-'))
    created.push(dir)
    writePrivateFileReplacing(join(dir, 'server.json'), '{"v":1}')
    expect(readdirSync(dir)).toEqual(['server.json'])
  })

  it('never writes into a file another principal already owns — the rename brings its OWN object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-private-replace-dacl-'))
    created.push(dir)
    const path = join(dir, 'server.json')
    writeFileSync(path, 'PLANTED')
    if (process.platform === 'win32') {
      expect(Bun.spawnSync(['icacls', path, '/grant', 'BUILTIN\\Users:(R)']).exitCode).toBe(0)
      expect(readFileProtection(path).acl.some((ace) => ace.startsWith('BUILTIN\\Users:'))).toBe(true)
    }

    writePrivateFileReplacing(path, '{"ciphertext":"not-a-real-secret"}')

    expect(readFileSync(path, 'utf8')).toBe('{"ciphertext":"not-a-real-secret"}')
    // A plain truncating write would have kept the planted DACL. The rename
    // replaces the OBJECT, so the attacker's ACE is gone with it.
    if (process.platform === 'win32') {
      expect(readFileProtection(path).acl.some((ace) => ace.startsWith('BUILTIN\\Users:'))).toBe(false)
    }
  })
})
