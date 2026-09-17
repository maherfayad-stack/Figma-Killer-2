/**
 * builtinDesignSystem — the three facts the server half needs about Studio's
 * built-in design system, and the one thing nothing else can check.
 *
 * The folder name is declared TWICE on purpose: here for the server, and as
 * `PROJECT_DESIGN_SYSTEM_DIR` in `src/core/page-parser/designSystemDir.ts` for
 * the parser (the browser core cannot import `server/` — the same reason
 * `fsCodemodAdapter.ts` mirrors `INLINE_ID_SEPARATOR` as a literal). If the two
 * ever drift, the parser stops recognising the very folder the server writes:
 * every design-system import silently reclassifies as a LOCAL component, gets
 * inlined, drags forty nodes of Studio's own code onto the user's page, and
 * pulls its stylesheets into the editable class list. Nothing else in the
 * codebase holds them equal.
 *
 * The parity assertion lives on THIS side because a server test may import
 * `@core/*` freely, while nothing under `src/` imports `server/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_DESIGN_SYSTEM_DIR as PARSER_DESIGN_SYSTEM_DIR } from '@core/page-parser'
import { BUILTIN_DESIGN_SYSTEM_DIR, PROJECT_DESIGN_SYSTEM_DIR, isDesignSystemBacked } from '../builtinDesignSystem'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'builtin-ds-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('builtinDesignSystem', () => {
  it('agrees with the page-parser on the folder name, literally', () => {
    expect(PROJECT_DESIGN_SYSTEM_DIR).toBe(PARSER_DESIGN_SYSTEM_DIR)
  })

  it("points at Studio's own vendored copy, not at anything in a project", () => {
    expect(BUILTIN_DESIGN_SYSTEM_DIR.endsWith(join('vendor', 'alm-design-system'))).toBe(true)
  })

  it('calls a project DS-backed only when the folder has an entry file', () => {
    expect(isDesignSystemBacked(dir)).toBe(false)

    // A half-written copy is not a design system — `ensureDesignSystemFiles`
    // writes `index.js`, and everything downstream (module mapping, the icon
    // catalog, the agent guide, token extraction) keys on that one file.
    mkdirSync(join(dir, PROJECT_DESIGN_SYSTEM_DIR, 'components'), { recursive: true })
    writeFileSync(join(dir, PROJECT_DESIGN_SYSTEM_DIR, 'components', 'Button.jsx'), 'export function Button() { return null }\n')
    expect(isDesignSystemBacked(dir)).toBe(false)

    writeFileSync(join(dir, PROJECT_DESIGN_SYSTEM_DIR, 'index.js'), 'export {}\n')
    expect(isDesignSystemBacked(dir)).toBe(true)
  })
})
