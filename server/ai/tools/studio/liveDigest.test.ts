/**
 * `buildStudioLiveDigest` (WS-12 §2.1) — cost discipline (trap #11: never
 * walk every page's nodes) exercised directly, against a real multi-page
 * fixture, so the "only the active page, never the whole project" claim is
 * checked by CORRECTNESS (does another page's data leak in) rather than by a
 * timing benchmark, which is a flaky signal in a shared CI environment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStudioLiveDigest, buildStudioCapabilityDigest } from './liveDigest'
import { createStalenessTracker } from './staleness'
import type { StudioAgentSnapshot } from './snapshot'

/** `n` distinct buttons with `{...spreadProps}` — a reliable, already-verified way to manufacture N nodes with a real `lockReason` ("spread props", `checkNoSpreadProps`'s own rule) per page. */
function pageWithLockedButtons(n: number): string {
  const buttons = Array.from({ length: n }, (_, i) => `      <button {...spreadProps${i}}>Go</button>`).join('\n')
  const consts = Array.from({ length: n }, (_, i) => `const spreadProps${i} = { label: 'Go' }`).join('\n')
  return [
    consts,
    'export default function Page() {',
    '  return (',
    '    <div className="hero">',
    buttons,
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

describe('buildStudioLiveDigest — cost discipline (trap #11)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-livedigest-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the fidelity digest reflects ONLY the active page — a heavier sibling page never leaks in', async () => {
    // Active page: 2 code-valued nodes. Sibling: 40 — if the digest ever
    // summed across pages, this test would catch it immediately.
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(2))
    writeFileSync(join(dir, 'pages', 'Big.tsx'), pageWithLockedButtons(40))

    const { loadStudioPages } = await import('../../../handlers/studioPageLoad')
    const { pages } = await loadStudioPages(dir)
    const small = pages.find((p) => p.id === 'small')
    if (!small) throw new Error('fixture page "small" did not parse')

    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId: 'small', x: 0, y: 0 }, { pageId: 'big', x: 400, y: 0 }],
      activePageId: 'small',
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-1', { staleness: createStalenessTracker() })
    expect(digest.fidelity?.locked).toBe(2)
    // Board metadata (titles) is fine to include for every frame — that's
    // bounded by frame count, not node count, and IS part of the design
    // (WS-12 §2.1: "the snapshot reads board metadata... only").
    expect(digest.board.frames).toHaveLength(2)
  })

  it('the selection lookup never scans a page other than the active one', async () => {
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(1))
    writeFileSync(join(dir, 'pages', 'Big.tsx'), pageWithLockedButtons(40))

    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId: 'small', x: 0, y: 0 }],
      activePageId: 'small',
      // A node id shaped like it belongs to the OTHER page — must not resolve.
      selectedNodeId: 'pages/Big.tsx:1:1',
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-2', { staleness: createStalenessTracker() })
    expect(digest.selection).toBeNull()
  })

  it('never throws when the active page id names a page that does not exist', async () => {
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(1))
    const snapshot: StudioAgentSnapshot = {
      activeBoardId: null,
      frames: [],
      activePageId: 'does-not-exist',
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-3', { staleness: createStalenessTracker() })
    expect(digest.activePage).toBeNull()
    expect(digest.fidelity).toBeNull()
  })
})

/**
 * The capability digest (mcp-tooling task) — `StudioLiveDigest.capabilities`.
 * Every probe here is a cheap, synchronous, disk-only check (see
 * `liveDigest.ts`'s module doc); these tests exercise the real fixtures the
 * probes read (`.studio/meta.json`, `.mcp.json`, `tsconfig.json`,
 * `node_modules/typescript/bin/tsc`) rather than mocking the probe
 * functions, so a change to what they actually check is caught here too.
 */
describe('buildStudioLiveDigest — capabilities', () => {
  let dir: string
  const emptySnapshot: StudioAgentSnapshot = {
    activeBoardId: null,
    frames: [],
    activePageId: null,
    selectedNodeId: null,
    axes: { direction: 'ltr', colorScheme: 'light' },
  }
  // Hermetic against the developer's own shell/`.env` — same concern
  // `remoteAssetFetch.test.ts` documents for this exact var.
  let previousLoopbackEnv: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-livedigest-caps-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
    previousLoopbackEnv = process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
    delete process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previousLoopbackEnv === undefined) delete process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
    else process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH = previousLoopbackEnv
  })

  it('figma: the shipped REMOTE built-in reports "needs-approval" until a human approves it', async () => {
    // It is declared in every project, but it carries a credential, so it is
    // listed unapproved and cannot reach a turn. "Declared but unusable" is
    // not configured, and saying otherwise would be the digest claiming a
    // capability the agent does not have.
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-figma-default', { staleness: createStalenessTracker() })
    expect(digest.capabilities.figma.status).toBe('needs-approval')
    expect(digest.capabilities.figma.loopbackAssetFetchBlocked).toBe(false)
  })

  it('figma: an approved remote built-in is "configured", and its assets are never loopback-blocked', async () => {
    // The side benefit of moving off the desktop server: its asset URLs were
    // loopback (`http://localhost:3845/assets/...`) and the SSRF guard
    // refused them unless STUDIO_ALLOW_LOOPBACK_ASSET_FETCH was set. The
    // remote server hands out ordinary figma.com URLs, so that whole
    // exception stops applying — asserted with the env var explicitly
    // deleted (the afterEach above restores it).
    delete process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ approvedRegisteredMcpServers: ['figma'] }))
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-figma-approved', { staleness: createStalenessTracker() })
    expect(digest.capabilities.figma.status).toBe('configured')
    expect(digest.capabilities.figma.loopbackAssetFetchBlocked).toBe(false)
  })

  it('figma: reports "not-configured" when the built-in is disabled and nothing else is approved', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ disabledBuiltInMcpServers: ['figma'] }))
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-figma-disabled', { staleness: createStalenessTracker() })
    expect(digest.capabilities.figma.status).toBe('not-configured')
    expect(digest.capabilities.figma.loopbackAssetFetchBlocked).toBe(false)
  })

  it('figma: an approved, non-loopback project .mcp.json entry is "configured" with asset fetch never blocked', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(
      join(dir, '.studio', 'meta.json'),
      JSON.stringify({ disabledBuiltInMcpServers: ['figma'], approvedMcpServers: ['figma'] }),
    )
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } } }))
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-figma-cloud', { staleness: createStalenessTracker() })
    expect(digest.capabilities.figma.status).toBe('configured')
    expect(digest.capabilities.figma.loopbackAssetFetchBlocked).toBe(false)
  })

  it('figma + typecheck: both degrade to "unknown" rather than throwing when .studio/meta.json cannot be read as a file', () => {
    // `readStudioMeta` has no try/catch of its own around this read — making
    // the path a DIRECTORY forces a real EISDIR throw, which both
    // `listRegisteredMcpServers` (figma probe) and the typecheck probe call
    // directly and must catch. Exercised through `buildStudioCapabilityDigest`
    // directly (not the full `buildStudioLiveDigest` pipeline): the pipeline
    // resolves the project's pages directory through this SAME
    // `readStudioMeta(dir)` first (`loadStudioPages` -> `projectPagesDir`),
    // so a fixture broken this way never reaches the capability probes under
    // the full pipeline at all — that earlier, pre-existing gap is not this
    // task's to fix, and is unrelated to whether these two probes themselves
    // degrade honestly.
    mkdirSync(join(dir, '.studio', 'meta.json'), { recursive: true })
    const capabilities = buildStudioCapabilityDigest(dir)
    expect(capabilities.figma).toEqual({ status: 'unknown', loopbackAssetFetchBlocked: false })
    expect(capabilities.typecheck).toEqual({ available: false, reason: 'unknown' })
  })

  it('typecheck: unavailable with reason "trust-tier" on a fresh (default static-trust) project', async () => {
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-tsc-trust', { staleness: createStalenessTracker() })
    expect(digest.capabilities.typecheck).toEqual({ available: false, reason: 'trust-tier' })
  })

  it('typecheck: unavailable with reason "no-tsconfig" once promoted past Tier 0 but no tsconfig.json exists', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ trust: 'render-packages' }))
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-tsc-no-tsconfig', { staleness: createStalenessTracker() })
    expect(digest.capabilities.typecheck).toEqual({ available: false, reason: 'no-tsconfig' })
  })

  it('typecheck: unavailable with reason "typescript-not-installed" once promoted with a tsconfig but no installed compiler', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ trust: 'render-packages' }))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-tsc-no-compiler', { staleness: createStalenessTracker() })
    expect(digest.capabilities.typecheck).toEqual({ available: false, reason: 'typescript-not-installed' })
  })

  it('typecheck: available once promoted, with a tsconfig, and with the project\'s own tsc installed', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ trust: 'render-packages' }))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
    mkdirSync(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n')
    const digest = await buildStudioLiveDigest(dir, emptySnapshot, 'conv-tsc-available', { staleness: createStalenessTracker() })
    expect(digest.capabilities.typecheck).toEqual({ available: true })
  })
})

/**
 * `pageWriteVerification`/`figmaReferenceNudge` (verification-gate item 1/4) —
 * exercised against a real scaffolded page, a real turn-write log, and a
 * real registered reference, the same fixtures `pageWriteVerification.test.ts`
 * uses, so this proves the WIRING into the digest rather than re-testing the
 * shared computation itself.
 */
describe('buildStudioLiveDigest — page write verification + Figma nudge', () => {
  let dir: string
  const baseSnapshot: StudioAgentSnapshot = {
    activeBoardId: 'board-1',
    frames: [],
    activePageId: null,
    selectedNodeId: null,
    axes: { direction: 'ltr', colorScheme: 'light' },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-livedigest-writes-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is empty when nothing was written since the last reset', async () => {
    const { createScaffoldedPage } = await import('../../../handlers/studio/pageScaffold')
    createScaffoldedPage(dir, 'Onboarding')
    const digest = await buildStudioLiveDigest(dir, baseSnapshot, 'conv-writes-empty', { staleness: createStalenessTracker() })
    expect(digest.pageWriteVerification).toEqual([])
  })

  it('reports a page written since the last turn boundary, unverified', async () => {
    const { createScaffoldedPage } = await import('../../../handlers/studio/pageScaffold')
    const { resolvePageSourceFile } = await import('../../../handlers/studio/pageSourceFile')
    const { appendTurnWrite } = await import('../../../handlers/studio/turnWriteLog')
    const { loadStudioPages } = await import('../../../handlers/studioPageLoad')

    const scaffolded = createScaffoldedPage(dir, 'Onboarding')
    if (!scaffolded.ok) throw new Error(scaffolded.conflict)
    const { pages } = await loadStudioPages(dir)
    const page = pages.find((p) => p.id === scaffolded.pageId)!
    const rel = resolvePageSourceFile(page)!
    appendTurnWrite(dir, join(dir, ...rel.split('/')))

    const digest = await buildStudioLiveDigest(dir, baseSnapshot, 'conv-writes-unverified', { staleness: createStalenessTracker() })
    expect(digest.pageWriteVerification).toHaveLength(1)
    expect(digest.pageWriteVerification[0]!.pageId).toBe(scaffolded.pageId)
    expect(digest.pageWriteVerification[0]!.verifiedSinceWrite).toBe(false)
  })

  it('the Figma nudge fires only for the ACTIVE page, only with a URL in the message, and only when unarmed', async () => {
    const { createScaffoldedPage } = await import('../../../handlers/studio/pageScaffold')
    const scaffolded = createScaffoldedPage(dir, 'Onboarding')
    if (!scaffolded.ok) throw new Error(scaffolded.conflict)
    const snapshot: StudioAgentSnapshot = { ...baseSnapshot, activePageId: scaffolded.pageId }
    // The nudge points at the Figma connector, so it only fires when there IS
    // one — the shipped built-in ships unapproved, so approve it here.
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ approvedRegisteredMcpServers: ['figma'] }))

    const withUrl = await buildStudioLiveDigest(
      dir,
      snapshot,
      'conv-figma-nudge-1',
      { staleness: createStalenessTracker() },
      'match this: https://www.figma.com/file/abc123/Onboarding',
    )
    expect(withUrl.figmaReferenceNudge).toEqual({ pageId: scaffolded.pageId, pageTitle: 'Onboarding' })

    const withoutUrl = await buildStudioLiveDigest(
      dir,
      snapshot,
      'conv-figma-nudge-2',
      { staleness: createStalenessTracker() },
      'just build a signup screen',
    )
    expect(withoutUrl.figmaReferenceNudge).toBeNull()
  })

  it('the Figma nudge stays silent once a reference is armed for the active page', async () => {
    const { createScaffoldedPage } = await import('../../../handlers/studio/pageScaffold')
    const { registerDesignReference } = await import('../../../handlers/studio/designReferenceStore')
    const scaffolded = createScaffoldedPage(dir, 'Onboarding')
    if (!scaffolded.ok) throw new Error(scaffolded.conflict)
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const registered = await registerDesignReference(dir, onePixelPng, { pageId: scaffolded.pageId })
    if (!registered.ok) throw new Error(registered.error)

    const snapshot: StudioAgentSnapshot = { ...baseSnapshot, activePageId: scaffolded.pageId }
    const digest = await buildStudioLiveDigest(
      dir,
      snapshot,
      'conv-figma-nudge-armed',
      { staleness: createStalenessTracker() },
      'match this: https://www.figma.com/file/abc123/Onboarding',
    )
    expect(digest.figmaReferenceNudge).toBeNull()
  })
})
