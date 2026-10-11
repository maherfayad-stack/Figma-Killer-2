import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('Circular dependencies', () => {
  it('keeps the tsconfig-aware source graph cycle-free', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        'x',
        'madge',
        '--circular',
        '--ts-config',
        'tsconfig.json',
        '--extensions',
        'ts,tsx',
        'src',
        'server',
      ],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const output = `${decode(result.stdout)}${decode(result.stderr)}`
    if (result.exitCode !== 0) {
      throw new Error(
        `Circular dependencies found. Run the same command locally for the full graph:\n` +
          `bun x madge --circular --ts-config tsconfig.json --extensions ts,tsx src server\n\n` +
          output,
      )
    }

    expect(output).toContain('No circular dependency found')
    // madge walks the whole ~5k-file src+server graph from cold; it costs
    // ~13s of pure analysis on an idle dev machine and measured 2m09s while
    // several agents were building. The budget is a hang guard, not a perf
    // assertion — keep it well clear of the real cost so a legitimately
    // growing graph or a busy machine doesn't turn a green gate red.
  }, 300_000)
})
