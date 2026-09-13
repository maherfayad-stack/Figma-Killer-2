/**
 * Architecture gate — live origin isolation.
 *
 * `server/liveOrigin.ts` is a second, independent `Bun.serve` listener that
 * proxies a Tier 2 project's own dev server. Its entire security value rests
 * on physically being unable to touch the admin session: no import of
 * `server/router.ts` (`handleServerRequest`) or any cookie/session helper
 * from `server/auth/security.ts`, no `Set-Cookie` write, and exactly one call
 * site for `startLiveOriginServer` (`server/index.ts`) — a second call site
 * would mean a second listener silently started, doubling the exposure.
 *
 * Modeled on `ai-driver-isolation.test.ts`'s scan-plus-static-assertion
 * pattern: this is a structural gate proven by import graph and grep, not a
 * running-server test (that lives in `server/liveOrigin.test.ts`).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const LIVE_ORIGIN_FILE = join(REPO_ROOT, 'server/liveOrigin.ts')

function collectServerFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tmp' || entry === 'dist') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectServerFiles(full))
    } else if (['.ts', '.tsx', '.js', '.mts', '.mjs'].includes(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

/**
 * Blank out comment characters (block `/* *\/` and line `//`) while
 * preserving every newline and column position, so line numbers computed
 * against the result still line up with the original source. This is what
 * lets the "cookie" scan below ignore prose in doc comments — like this
 * very sentence — while still catching the word in actual code.
 */
function stripComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  return blanked.replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
}

/**
 * Find the line range `[startLine, endLine]` (0-based, inclusive) of a
 * top-level function declaration by brace-depth counting from its opening
 * `{`. Returns `null` if the function isn't found.
 */
function functionLineRange(lines: string[], functionNamePattern: RegExp): [number, number] | null {
  const startIndex = lines.findIndex((line) => functionNamePattern.test(line))
  if (startIndex === -1) return null
  let depth = 0
  let seenOpenBrace = false
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        seenOpenBrace = true
      } else if (ch === '}') {
        depth--
      }
    }
    if (seenOpenBrace && depth === 0) {
      return [startIndex, i]
    }
  }
  return null
}

describe('live-origin isolation gate', () => {
  const source = readFileSync(LIVE_ORIGIN_FILE, 'utf8')

  it('never imports server/router.ts (handleServerRequest)', () => {
    const bannedImportRe = /from\s+['"]\.\/router['"]|require\s*\(\s*['"]\.\/router['"]\s*\)|import\s*\(\s*['"]\.\/router['"]\s*\)/
    expect(bannedImportRe.test(source)).toBe(false)
  })

  it('never imports server/auth/security.ts (admin cookie/session helpers)', () => {
    const bannedImportRe = /from\s+['"]\.\/auth\/security['"]|require\s*\(\s*['"]\.\/auth\/security['"]\s*\)|import\s*\(\s*['"]\.\/auth\/security['"]\s*\)/
    expect(bannedImportRe.test(source)).toBe(false)
  })

  it('never writes a Set-Cookie header', () => {
    const setCookieWriteRe = /\.set\(\s*['"]set-cookie['"]/i
    expect(setCookieWriteRe.test(source)).toBe(false)
  })

  it('the word "cookie" appears in code only inside the two named stripping functions', () => {
    // Comments (including this file's own prose about cookies) are blanked
    // out first — this checks CODE, not documentation. A future header-copy
    // helper that forwards `Cookie`/`Set-Cookie` by accident is what this
    // guards against, not a doc comment explaining why one doesn't.
    const codeOnly = stripComments(source)
    const codeLines = codeOnly.split('\n')
    const originalLines = source.split('\n')

    const hopByHopRange = functionLineRange(codeLines, /function\s+stripHopByHopAndCookies\s*\(/)
    const setCookieRange = functionLineRange(codeLines, /function\s+stripSetCookie\s*\(/)
    expect(hopByHopRange).not.toBeNull()
    expect(setCookieRange).not.toBeNull()

    const allowedRanges = [hopByHopRange!, setCookieRange!]
    // A call site referencing one of the two sanctioned function names by
    // identifier (e.g. `stripSetCookie(upstreamRes.headers)`) is not itself
    // a new place the word "cookie" does anything — only the two function
    // BODIES are allowed to touch a header literally.
    const sanctionedIdentifierRe = /\bstripHopByHopAndCookies\b|\bstripSetCookie\b/

    const violations: string[] = []
    codeLines.forEach((line, index) => {
      const insideAllowedBody = allowedRanges.some(([s, e]) => index >= s && index <= e)
      if (insideAllowedBody) return
      if (sanctionedIdentifierRe.test(line)) return
      if (/cookie/i.test(line)) {
        violations.push(`  line ${index + 1}: ${originalLines[index]?.trim()}`)
      }
    })

    if (violations.length > 0) {
      throw new Error(
        `[live-origin-isolation] "cookie" found in code outside stripHopByHopAndCookies/stripSetCookie:\n${violations.join('\n')}`,
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('the HTTP proxy path strips cookies and Set-Cookie before returning a response', () => {
    expect(source).toContain('stripHopByHopAndCookies(req.headers')
    expect(source).toContain('stripSetCookie(upstreamRes.headers)')
  })

  it('startLiveOriginServer has exactly one PRODUCTION call site: server/index.ts', () => {
    // `.test.ts` files are excluded: `liveOrigin.test.ts` legitimately calls
    // `startLiveOriginServer` directly to exercise the real WebSocket bridge
    // against a genuine bound listener — that is a test invoking the
    // constructor under test, not a second production listener silently
    // starting. What this gate actually guards against is a SECOND boot-path
    // call site in the running server.
    const allFiles = collectServerFiles(join(REPO_ROOT, 'server'))
      .filter((f) => f !== LIVE_ORIGIN_FILE)
      .filter((f) => !f.endsWith('.test.ts'))
    const callSites = allFiles.filter((file) => {
      const content = readFileSync(file, 'utf8')
      return /startLiveOriginServer\s*\(/.test(content)
    })
    const relCallSites = callSites.map((f) => relative(REPO_ROOT, f).replaceAll('\\', '/'))
    expect(relCallSites).toEqual(['server/index.ts'])
  })
})
