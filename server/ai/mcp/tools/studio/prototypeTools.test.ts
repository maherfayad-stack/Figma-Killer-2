/**
 * The agent's interaction tools.
 *
 * The refusal tests are the reason this file exists. A prototype link is a
 * persisted claim about an element the agent cannot see, written against a
 * node id that rots on nearly every edit — so the tool's job is to refuse the
 * link the agent cannot justify, not to store whatever it was handed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPrototypeFile } from '../../../../handlers/studio/prototypeStore'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { studioPrototypeMcpTools } from './prototypeTools'

const listTool = studioPrototypeMcpTools.find((t) => t.name === 'studio_list_prototype_links')!
const setTool = studioPrototypeMcpTools.find((t) => t.name === 'studio_set_prototype_link')!
const deleteTool = studioPrototypeMcpTools.find((t) => t.name === 'studio_delete_prototype_link')!

let dir: string

/** Two real pages, so `loadStudioPages` has something to parse and to target. */
function seedProject(): void {
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(
    join(dir, 'pages', 'SignUp.tsx'),
    'export default function SignUp() {\n  return (\n    <div>\n      <button>Continue</button>\n    </div>\n  )\n}\n',
  )
  writeFileSync(
    join(dir, 'pages', 'Sms.tsx'),
    'export default function Sms() {\n  return <div>Enter code</div>\n}\n',
  )
  mkdirSync(join(dir, '.studio'), { recursive: true })
}

function ctx() {
  return {
    userId: 'u1',
    capabilities: ['studio.write'],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    db: undefined,
  } as never
}

/** The page ids this fixture actually parsed to, and a real node id on one. */
async function fixtureIds(): Promise<{ signUpId: string; smsId: string; buttonNodeId: string }> {
  const loaded = await loadStudioPages(dir)
  const signUp = loaded.pages.find((page) => page.id === 'sign-up')
  const sms = loaded.pages.find((page) => page.id === 'sms')
  if (!signUp || !sms) throw new Error('fixture pages did not parse')

  // Found by module, not by a hard-coded line:col, so a parser change moves
  // this fixture with it instead of breaking it.
  const buttonNodeId = Object.keys(signUp.nodes).find(
    (id) => signUp.nodes[id]?.moduleId === 'base.button',
  )
  if (!buttonNodeId) throw new Error('fixture button node not found')
  return { signUpId: signUp.id, smsId: sms.id, buttonNodeId }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-prototype-tools-'))
  seedProject()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('studio_set_prototype_link', () => {
  it('captures the durable anchor itself from a bare node id', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()

    const out = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'overlay', targetPageId: smsId, transition: 'sheet' },
      ctx(),
    )) as { ok: boolean; created: boolean }

    expect(out.ok).toBe(true)
    expect(out.created).toBe(true)

    // The agent supplied no index path; the tool wrote a complete hint.
    const stored = readPrototypeFile(dir).links[0]
    expect(stored?.source.node.nodeId).toBe(buttonNodeId)
    expect(stored?.source.node.indexPath.length).toBeGreaterThan(0)
    expect(stored?.source.node.moduleId).toBeTruthy()
    expect(stored?.action).toBe('overlay')
    expect(stored?.transition).toBe('sheet')
  })

  it('refuses a node id that is not in the page rather than storing a dead anchor', async () => {
    const { signUpId, smsId } = await fixtureIds()

    const out = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: 'pages/SignUp.tsx:999:9', action: 'navigate', targetPageId: smsId },
      ctx(),
    )) as { ok: boolean; code: string }

    expect(out.ok).toBe(false)
    expect(out.code).toBe('no-such-node')
    expect(readPrototypeFile(dir).links).toHaveLength(0)
  })

  it('refuses a target that is not a page in this project', async () => {
    const { signUpId, buttonNodeId } = await fixtureIds()

    const out = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: 'checkout' },
      ctx(),
    )) as { ok: boolean; code: string; availablePageIds: string[] }

    expect(out.ok).toBe(false)
    expect(out.code).toBe('no-such-target')
    // Names what DOES exist, so a wrong guess costs one round trip.
    expect(out.availablePageIds.length).toBeGreaterThan(0)
  })

  it('refuses a transition the action cannot wear instead of silently repairing it', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()

    const out = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: smsId, transition: 'sheet' },
      ctx(),
    )) as { ok: boolean; code: string; allowedTransitions: string[] }

    expect(out.ok).toBe(false)
    expect(out.code).toBe('bad-transition')
    expect(out.allowedTransitions).toContain('instant')
  })

  it('requires a target for navigate and refuses one for back', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()

    const missing = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate' },
      ctx(),
    )) as { ok: boolean; code: string }
    expect(missing.code).toBe('target-required')

    const extra = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'back', targetPageId: smsId },
      ctx(),
    )) as { ok: boolean; code: string }
    expect(extra.code).toBe('target-refused')
  })

  it('defaults the transition to the action\'s first legal value, and gives back/close none', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()

    await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: smsId },
      ctx(),
    )
    expect(readPrototypeFile(dir).links[0]?.transition).toBe('instant')

    await setTool.handler({ dir, pageId: signUpId, nodeId: buttonNodeId, action: 'back' }, ctx())
    const back = readPrototypeFile(dir).links.find((link) => link.action === 'back')
    expect(back?.transition).toBeUndefined()
    expect(back?.targetPageId).toBeNull()
  })

  it('updates in place when given a linkId, rather than adding a second link', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()

    const created = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: smsId },
      ctx(),
    )) as { link: { linkId: string } }

    const updated = (await setTool.handler(
      {
        dir,
        linkId: created.link.linkId,
        pageId: signUpId,
        nodeId: buttonNodeId,
        action: 'overlay',
        targetPageId: smsId,
        transition: 'popup',
      },
      ctx(),
    )) as { ok: boolean; created: boolean }

    expect(updated.ok).toBe(true)
    expect(updated.created).toBe(false)
    const links = readPrototypeFile(dir).links
    expect(links).toHaveLength(1)
    expect(links[0]?.action).toBe('overlay')
  })
})

describe('studio_list_prototype_links', () => {
  it('reports the source element and the target page by name', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()
    await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'overlay', targetPageId: smsId, transition: 'sheet' },
      ctx(),
    )

    const out = (await listTool.handler({ dir }, ctx())) as {
      ok: boolean
      links: Array<{ action: string; anchorConfidence: string; source: { nodeId: string }; targetPageId: string }>
    }

    expect(out.ok).toBe(true)
    expect(out.links).toHaveLength(1)
    expect(out.links[0]?.action).toBe('overlay')
    expect(out.links[0]?.targetPageId).toBe(smsId)
    // Freshly written against the live tree, so it must resolve exactly.
    expect(out.links[0]?.anchorConfidence).toBe('exact')
  })

  it('reports a link whose element has gone as detached rather than dropping it', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()
    await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: smsId },
      ctx(),
    )

    // The element the link was drawn on is deleted from the user's source.
    writeFileSync(
      join(dir, 'pages', 'SignUp.tsx'),
      'export default function SignUp() {\n  return <div />\n}\n',
    )

    const out = (await listTool.handler({ dir }, ctx())) as {
      links: Array<{ anchorConfidence: string }>
    }

    expect(out.links).toHaveLength(1)
    expect(out.links[0]?.anchorConfidence).toBe('detached')
  })
})

describe('studio_delete_prototype_link', () => {
  it('removes a link, and succeeds without writing when it is already gone', async () => {
    const { signUpId, smsId, buttonNodeId } = await fixtureIds()
    const created = (await setTool.handler(
      { dir, pageId: signUpId, nodeId: buttonNodeId, action: 'navigate', targetPageId: smsId },
      ctx(),
    )) as { link: { linkId: string } }

    const first = (await deleteTool.handler({ dir, linkId: created.link.linkId }, ctx())) as {
      ok: boolean
      removed: boolean
    }
    expect(first.ok).toBe(true)
    expect(first.removed).toBe(true)
    expect(readPrototypeFile(dir).links).toHaveLength(0)

    const second = (await deleteTool.handler({ dir, linkId: created.link.linkId }, ctx())) as {
      ok: boolean
      removed: boolean
    }
    expect(second.ok).toBe(true)
    expect(second.removed).toBe(false)
  })
})
