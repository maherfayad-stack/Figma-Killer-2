/**
 * Prompt ⇄ registry parity gate (WS-12 §9) — mirrors
 * `mcp/tools/studio/fidelityCodes.test.ts`'s doc⇄code pattern. Every
 * `studio_*`-shaped token in the Studio system prompt's static prefix must
 * be a REAL tool name in `studioAgentTools` — a prompt naming a renamed or
 * removed tool is invisible until an agent fails at runtime, exactly the
 * failure mode this gate exists to catch before it ships.
 */
import { describe, expect, it } from 'bun:test'
import { buildStudioAgentSystemPrompt, type StudioPromptContext } from './systemPrompt'
import { studioAgentTools } from './index'
import type { StudioLiveDigest } from './liveDigest'

/** Every `studio_snake_case` token appearing anywhere in `text`, de-duplicated. */
function extractToolLikeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/\bstudio_[a-z_]+\b/g)) {
    tokens.add(match[0])
  }
  return tokens
}

describe('Studio system prompt — tool registry parity', () => {
  it('builds the cacheable 3-element form', () => {
    const prompt = buildStudioAgentSystemPrompt(null, studioAgentTools)
    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  })

  it('every studio_* token named in the static prefix is a real registered tool', () => {
    const [prefix] = buildStudioAgentSystemPrompt(null, studioAgentTools)
    const named = extractToolLikeTokens(prefix!)
    const registered = new Set(studioAgentTools.map((t) => t.name))
    // The prefix must actually reference tools — an empty extraction would
    // make every assertion below vacuously true and hide a real drift.
    expect(named.size).toBeGreaterThan(0)
    for (const name of named) {
      expect(registered.has(name)).toBe(true)
    }
  })

  it('the "Tools available" line lists every registered tool by name', () => {
    const [prefix] = buildStudioAgentSystemPrompt(null, studioAgentTools)
    for (const tool of studioAgentTools) {
      expect(prefix).toContain(tool.name)
    }
  })

  it('has no duplicate tool names in the registry', () => {
    const names = studioAgentTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('studio_fidelity_report is offered to the agent and resolves to a real tool (0.12)', () => {
    // Array membership alone would not catch a name the resolver drops —
    // `studioAgentTools` is the throw-on-missing resolution (`./index.ts`),
    // so its presence here proves the name actually resolves through the
    // registry, not just that a string was added to the source list.
    expect(studioAgentTools.some((t) => t.name === 'studio_fidelity_report')).toBe(true)
    const [prefix] = buildStudioAgentSystemPrompt(null, studioAgentTools)
    expect(prefix).toContain('studio_fidelity_report')
  })
})

describe('Studio system prompt — capability-aware "Tools available" line (0.11)', () => {
  it('never names a tool that was filtered out of the resolved list handed in', () => {
    // Simulates what `selectStudioTools` does for a caller without
    // `studio.run.project`: `studio_render_reference` is dropped from the
    // array BEFORE this function ever sees it.
    const filtered = studioAgentTools.filter((t) => t.name !== 'studio_render_reference')
    const [prefix] = buildStudioAgentSystemPrompt(null, filtered)
    expect(prefix).not.toContain('studio_render_reference')
  })

  it('names every tool that IS in the resolved list handed in', () => {
    const [prefix] = buildStudioAgentSystemPrompt(null, studioAgentTools)
    expect(prefix).toContain('studio_render_reference')
  })
})

// ---------------------------------------------------------------------------
// Capability digest (mcp-tooling task) — asymmetric rendering
// ---------------------------------------------------------------------------

const FIXTURE_CTX: StudioPromptContext = {
  dir: '/tmp/fixture',
  name: 'fixture',
  trust: 'static',
  framework: 'react',
  pagesDir: 'pages',
  packageManager: 'bun',
  styleToolchain: { tailwind: false, sass: false, cssModules: true },
  componentPackages: [],
  warningCount: 0,
}

function baseLiveDigest(capabilities: StudioLiveDigest['capabilities']): StudioLiveDigest {
  return {
    board: { activeBoardId: null, frames: [] },
    activePage: null,
    selection: null,
    fidelity: null,
    install: { hasPackageJson: true, hasNodeModules: true, dependencyCount: 3 },
    axes: { direction: 'ltr', colorScheme: 'light' },
    designReferences: [],
    staleWarning: null,
    capabilities,
    pageWriteVerification: [],
    figmaReferenceNudge: null,
  }
}

describe('Studio system prompt — capability digest (mcp-tooling task)', () => {
  it('needs-approval: says the connector is one human action away, never that it is missing', () => {
    // The default state of every fresh project now that Studio ships the
    // REMOTE Figma server unapproved. Telling the agent "not configured for
    // this project" here would be false and would make it give up, when the
    // one thing that can surface the fix is the agent saying so.
    const live = baseLiveDigest({
      figma: { status: 'needs-approval', loopbackAssetFetchBlocked: false },
      typecheck: { available: true },
    })
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)

    expect(suffix).toContain('declared for this project but NOT approved')
    expect(suffix).toContain('Settings')
    expect(suffix).toContain('OAuth-only')
    expect(suffix).not.toContain('not configured for this project')
  })

  it('all-available: emits no "unavailable"/"not configured" wording, and the figma line stays terse', () => {
    const live = baseLiveDigest({
      figma: { status: 'configured', loopbackAssetFetchBlocked: false },
      typecheck: { available: true },
    })
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)

    // Typecheck is fully available: no line about it at all — the terse/
    // omitted half of the asymmetry.
    expect(suffix).not.toContain('studio_typecheck: unavailable')
    expect(suffix).not.toContain('typecheck')

    // Figma is configured with nothing blocking it: one short, non-actionable
    // line, not the longer "not configured" fallback instructions.
    expect(suffix).toContain('Figma MCP connector: configured.')
    expect(suffix).not.toContain('not configured for this project')
    expect(suffix).not.toContain('asset downloads from it are blocked')
  })

  it('degraded: figma not configured produces an actionable line naming the fallback tool', () => {
    const live = baseLiveDigest({
      figma: { status: 'not-configured', loopbackAssetFetchBlocked: false },
      typecheck: { available: true },
    })
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)

    expect(suffix).toContain('Figma MCP connector: not configured for this project')
    expect(suffix).toContain('studio_measure_reference')
  })

  it('degraded: a configured but asset-blocked figma connector names the loopback env var and the fallback tool', () => {
    const live = baseLiveDigest({
      figma: { status: 'configured', loopbackAssetFetchBlocked: true },
      typecheck: { available: true },
    })
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)

    expect(suffix).toContain('STUDIO_ALLOW_LOOPBACK_ASSET_FETCH')
    expect(suffix).toContain('studio_extract_reference_asset')
  })

  it('degraded: figma probe degraded to "unknown" still tells the agent to fall back rather than staying silent', () => {
    const live = baseLiveDigest({
      figma: { status: 'unknown', loopbackAssetFetchBlocked: false },
      typecheck: { available: true },
    })
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)

    expect(suffix).toContain('Figma MCP connector: status unknown')
    expect(suffix).toContain('studio_measure_reference')
  })

  it('degraded: each typecheck unavailability reason renders its own actionable fix, and stays out of the prompt when available', () => {
    const reasons = [
      { reason: 'trust-tier' as const, expectSubstring: 'ask the user to promote it' },
      { reason: 'no-tsconfig' as const, expectSubstring: 'no tsconfig.json' },
      { reason: 'typescript-not-installed' as const, expectSubstring: 'studio_install_deps' },
      { reason: 'unknown' as const, expectSubstring: 'availability probe failed' },
    ]
    for (const { reason, expectSubstring } of reasons) {
      const live = baseLiveDigest({
        figma: { status: 'configured', loopbackAssetFetchBlocked: false },
        typecheck: { available: false, reason },
      })
      const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
      expect(suffix).toContain('studio_typecheck: unavailable')
      expect(suffix).toContain(expectSubstring)
    }
  })

  it('no live digest at all (no browser snapshot posted): the suffix still builds and says nothing about capabilities', () => {
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, null)
    expect(suffix).not.toContain('Figma MCP connector')
    expect(suffix).not.toContain('studio_typecheck: unavailable')
  })
})

/**
 * Per-page write/verify digest lines + the Figma nudge (the write-verification
 * gate, items 1/3/4). The required silent case — an armed, passing, non-thrashing
 * page — gets its own test: a gate a model can learn to ignore because it
 * never actually goes quiet is not a gate.
 */
describe('Studio system prompt — page write verification + Figma nudge (the write-verification gate)', () => {
  const configuredCapabilities: StudioLiveDigest['capabilities'] = {
    figma: { status: 'configured', loopbackAssetFetchBlocked: false },
    typecheck: { available: true },
  }

  it('an armed, passing, non-thrashing page renders as a single quiet word — the gate stays silent', () => {
    const live: StudioLiveDigest = {
      ...baseLiveDigest(configuredCapabilities),
      pageWriteVerification: [
        {
          pageId: 'onboarding',
          title: 'Onboarding',
          writeCount: 1,
          lastWrittenAtMs: 1000,
          hasReference: true,
          referenceId: 'ref-1',
          passingCompareAtMs: 2000,
          verifiedSinceWrite: true,
        },
      ],
    }
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
    expect(suffix).toContain('"Onboarding": verified.')
    expect(suffix).not.toContain('has NO design reference')
    expect(suffix).not.toContain('call studio_compare(')
  })

  it('an unverified page names the exact next call', () => {
    const live: StudioLiveDigest = {
      ...baseLiveDigest(configuredCapabilities),
      pageWriteVerification: [
        {
          pageId: 'onboarding',
          title: 'Onboarding',
          writeCount: 2,
          lastWrittenAtMs: 1000,
          hasReference: false,
          verifiedSinceWrite: false,
        },
      ],
    }
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
    expect(suffix).toContain('Onboarding')
    expect(suffix).toContain('studio_register_design_reference')
  })

  it('nothing written this turn: the digest carries no write-verification line at all', () => {
    const live: StudioLiveDigest = { ...baseLiveDigest(configuredCapabilities), pageWriteVerification: [] }
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
    expect(suffix).not.toContain('verified.')
    expect(suffix).not.toContain('has NO design reference')
  })

  it('the Figma nudge names the page and the exact registration call', () => {
    const live: StudioLiveDigest = {
      ...baseLiveDigest(configuredCapabilities),
      figmaReferenceNudge: { pageId: 'onboarding', pageTitle: 'Onboarding' },
    }
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
    expect(suffix).toContain('Figma link in this message')
    expect(suffix).toContain('"Onboarding"')
    expect(suffix).toContain('studio_register_design_reference')
  })

  it('no nudge, no line', () => {
    const live: StudioLiveDigest = { ...baseLiveDigest(configuredCapabilities), figmaReferenceNudge: null }
    const [, , suffix] = buildStudioAgentSystemPrompt(FIXTURE_CTX, studioAgentTools, live)
    expect(suffix).not.toContain('Figma link in this message')
  })
})
