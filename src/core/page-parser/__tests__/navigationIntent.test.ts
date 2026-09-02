/**
 * Reading a screen destination out of a click handler, without executing it.
 *
 * These tests are mostly about REFUSAL. A derived connector is presented as a
 * fact about the user's source, so the bar is not "find as many flows as
 * possible" — it is "never claim a flow the code does not unconditionally
 * have". Every refusal below costs the user drawing one link by hand; the
 * alternative costs them believing their app does something it does not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPageEvalBudget, createWorkspaceProject, parsePageFile, type ParsedNode, type StaticEvalOptions } from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-intent-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** Parse a page whose only button carries `handler`, and return its targets. */
function targetsFor(handler: string): Record<string, string> | undefined {
  const rel = 'pages/Screen.jsx'
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(
    full,
    [
      'export default function Screen() {',
      '  return (',
      `    <button onClick={${handler}}>Continue</button>`,
      '  )',
      '}',
    ].join('\n'),
    'utf8',
  )

  const project = createWorkspaceProject(tmpDir)
  const nodes = Object.values(parsePageFile(full, tmpDir, project, evalOptions()).nodes) as ParsedNode[]
  const button = nodes.find((node) => node.name === 'button')
  return button?.codeNavigationTargets
}

describe('destinations it reads', () => {
  it('a bare navigate call', () => {
    expect(targetsFor("() => navigate('/sign-in')")).toEqual({ onClick: '/sign-in' })
  })

  it('a router or history push', () => {
    expect(targetsFor("() => router.push('/sign-in')")).toEqual({ onClick: '/sign-in' })
    expect(targetsFor("() => history.push('/otp')")).toEqual({ onClick: '/otp' })
  })

  it('the local-state idiom Studio-authored screens use', () => {
    expect(targetsFor("() => setScreen('otp')")).toEqual({ onClick: 'otp' })
  })

  it('a call buried in a block body among other statements', () => {
    expect(targetsFor("() => { track('cta'); navigate('/otp') }")).toEqual({ onClick: '/otp' })
  })

  it('a plain function expression, not just an arrow', () => {
    expect(targetsFor("function () { navigate('/otp') }")).toEqual({ onClick: '/otp' })
  })
})

describe('what it refuses, and why refusing is the point', () => {
  it('a computed destination — a template literal has no single answer', () => {
    expect(targetsFor('() => navigate(`/user/${id}`)')).toBeUndefined()
  })

  it('a destination held in a variable — following it would mean evaluating', () => {
    expect(targetsFor('() => navigate(target)')).toBeUndefined()
  })

  it('two destinations in one handler — that is a branch, not a flow', () => {
    expect(targetsFor("() => { if (ok) navigate('/otp'); else navigate('/sign-in') }")).toBeUndefined()
  })

  it('a call that is not navigation at all', () => {
    expect(targetsFor("() => submitForm('/api/session')")).toBeUndefined()
  })

  it('a handler that does something other than navigate', () => {
    expect(targetsFor('() => setOpen(true)')).toBeUndefined()
  })

  it('an empty destination string', () => {
    expect(targetsFor("() => navigate('')")).toBeUndefined()
  })

  it('a handler passed by reference — the body is not at this call site', () => {
    // Following an identifier to its declaration is the beginning of
    // evaluating the user's code, which is the invariant this whole parser
    // exists to hold.
    expect(targetsFor('onContinue')).toBeUndefined()
  })
})
