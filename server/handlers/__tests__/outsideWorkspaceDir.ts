/**
 * `withOutsideWorkspaceDir` — a real directory that is genuinely OUTSIDE the
 * Studio workspace root, for the routes that must refuse one.
 *
 * Two facts make this awkward enough to be worth a helper:
 *
 *   1. The suite's workspace root IS the OS temp directory (see
 *      `src/__tests__/setup.ts`), because that is where every fixture project
 *      in this repo is built. So `mkdtempSync(join(tmpdir(), …))` — the
 *      obvious way to make an "outside" directory — produces one that is
 *      firmly *inside*, and the assertion silently stops testing anything.
 *   2. Since W10 the refusal is a THROW from `resolveProjectDir`, converted
 *      to a 404 by the router's single catch, not a per-route 404 branch. A
 *      test calling a handler directly therefore asserts a rejection.
 *
 * So this re-roots the workspace at a fresh, empty directory for the duration
 * of the call and hands back a sibling of it: outside on any machine, without
 * depending on what `/tmp` happens to be. `projectsRootDir()` re-reads the
 * environment on every call, which is exactly what makes that work.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withOutsideWorkspaceDir<T>(
  prefix: string,
  run: (outside: string) => Promise<T> | T,
): Promise<T> {
  const previousRoot = process.env.STUDIO_WORKSPACE_DIR
  const container = mkdtempSync(join(tmpdir(), `${prefix}-container-`))
  const root = join(container, 'workspace')
  const outside = join(container, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  process.env.STUDIO_WORKSPACE_DIR = root
  try {
    return await run(outside)
  } finally {
    if (previousRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
    else process.env.STUDIO_WORKSPACE_DIR = previousRoot
    rmSync(container, { recursive: true, force: true })
  }
}
