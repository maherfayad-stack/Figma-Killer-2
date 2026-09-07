/**
 * onboardingFacts — unit tests for the five booleans behind the launcher's
 * onboarding checklist.
 *
 * The property that matters most is not "does it say true when it should" but
 * **what it says when it cannot tell**. A checklist that ticks a step nobody
 * did is worse than one that never ticks: it tells the user they have already
 * done a thing they have not, and the step's CTA is then the only route to
 * doing it. So every probe soft-fails to `false`, and there is a test for it.
 *
 * The `db` here is a hand-rolled stand-in rather than a real client: these
 * facts are four filesystem reads and two `select`s, and standing up SQLite to
 * assert "an empty result means false" would test the database, not this.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DbClient } from '../../../db/client'
import { readOnboardingFacts } from '../onboardingFacts'
import { writeStudioMeta } from '../studioMeta'

let root: string
let originalWorkspaceDir: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-facts-'))
  originalWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
  process.env.STUDIO_WORKSPACE_DIR = root
})

afterEach(() => {
  if (originalWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = originalWorkspaceDir
  fs.rmSync(root, { recursive: true, force: true })
})

function makeProject(folder: string): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <div /> }\n')
  return dir
}

/**
 * A `DbClient` that answers every tagged-template query with `rows`.
 *
 * Both AI queries go through the same call shape, so one canned answer covers
 * "has a credential" and "has a conversation" alike — which is exactly what
 * the fact under test collapses them to.
 */
function stubDb(rows: unknown[]): DbClient {
  const client = () => Promise.resolve({ rows })
  return client as unknown as DbClient
}

/** A `DbClient` whose every query rejects — the "the database is broken" case. */
function failingDb(): DbClient {
  const client = () => Promise.reject(new Error('database is down'))
  return client as unknown as DbClient
}

describe('readOnboardingFacts', () => {
  it('reports every step as not done for a fresh install', async () => {
    const facts = await readOnboardingFacts(stubDb([]), 'user-1')

    expect(facts).toEqual({
      projectCreated: false,
      projectOpened: false,
      styleEdited: false,
      aiConfigured: false,
      prototypeLinked: false,
    })
  })

  it('ticks `projectCreated` as soon as one project directory exists', async () => {
    makeProject('acme')

    const facts = await readOnboardingFacts(stubDb([]), 'user-1')

    expect(facts.projectCreated).toBe(true)
    // …and nothing else. Creating a project is not opening one.
    expect(facts.projectOpened).toBe(false)
  })

  it('ticks `projectOpened` from `lastOpenedAt`, not from the project existing', async () => {
    const dir = makeProject('acme')
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).projectOpened).toBe(false)

    writeStudioMeta(dir, { lastOpenedAt: Date.now() })

    expect((await readOnboardingFacts(stubDb([]), 'user-1')).projectOpened).toBe(true)
  })

  it('ticks `styleEdited` from a page-verification cache at either path', async () => {
    const dir = makeProject('acme')
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).styleEdited).toBe(false)

    // Today's project-wide location.
    const cacheDir = path.join(dir, '.studio', 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pageVerification.json'), '{"version":1,"pages":{}}')
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).styleEdited).toBe(true)

    // The per-user location W10 moves it to. Both are globbed, so the step
    // does not silently un-tick the day that move lands.
    fs.rmSync(path.join(cacheDir, 'pageVerification.json'))
    const agentDir = path.join(cacheDir, 'agent', 'abc123')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'pageVerification.json'), '{"version":1,"pages":{}}')
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).styleEdited).toBe(true)
  })

  it('ticks `prototypeLinked` only when a project has at least one link', async () => {
    const dir = makeProject('acme')
    const prototypeFile = path.join(dir, '.studio', 'prototype.json')
    fs.mkdirSync(path.dirname(prototypeFile), { recursive: true })

    // A prototype file with no links is what every project that has merely
    // entered prototype mode has. It is not the step.
    fs.writeFileSync(prototypeFile, JSON.stringify({ version: 1, links: [] }))
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).prototypeLinked).toBe(false)

    fs.writeFileSync(
      prototypeFile,
      JSON.stringify({
        version: 1,
        links: [
          {
            id: 'l1',
            source: {
              pageId: 'p1',
              node: { nodeId: 'n1', indexPath: [0], moduleId: 'base.text', textSnippet: 'Go' },
            },
            trigger: 'click',
            action: 'navigate',
            targetPageId: 'p2',
            transition: 'instant',
          },
        ],
      }),
    )
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).prototypeLinked).toBe(true)
  })

  it('ticks `aiConfigured` when the user has any credential or conversation row', async () => {
    expect((await readOnboardingFacts(stubDb([]), 'user-1')).aiConfigured).toBe(false)
    expect((await readOnboardingFacts(stubDb([{ id: 'row' }]), 'user-1')).aiConfigured).toBe(true)
  })

  it('soft-fails a broken database to "not done" instead of throwing', async () => {
    makeProject('acme')

    const facts = await readOnboardingFacts(failingDb(), 'user-1')

    // The one fact that needed the database reads as not done…
    expect(facts.aiConfigured).toBe(false)
    // …and the four that did not are still answered. One broken probe must not
    // take the panel down with it.
    expect(facts.projectCreated).toBe(true)
  })

  it('soft-fails an unreadable project sidecar to "not done"', async () => {
    const dir = makeProject('acme')
    const metaFile = path.join(dir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    // Not JSON at all. `readStudioMeta` degrades to `{}` rather than throwing,
    // so the fact is false — the honest answer for a sidecar that cannot say
    // whether the project was ever opened.
    fs.writeFileSync(metaFile, 'not json {{{')

    const facts = await readOnboardingFacts(stubDb([]), 'user-1')

    expect(facts.projectOpened).toBe(false)
    expect(facts.projectCreated).toBe(true)
  })
})
