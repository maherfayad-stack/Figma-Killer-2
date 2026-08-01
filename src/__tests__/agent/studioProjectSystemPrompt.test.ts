/**
 * `buildStudioProjectSystemPrompt` (WS-12 §4) — the real Studio-project
 * prompt path in `server/ai/handlers/chat.ts`, exercised against a real
 * temp-dir fixture (a fresh, empty "project") rather than a mocked probe, so
 * a genuine wiring break (a typo'd import, a wrong field name against
 * `ProjectProfile`) fails here instead of only at runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStudioProjectSystemPrompt } from '../../../server/ai/handlers/chat'

describe('buildStudioProjectSystemPrompt', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-prompt-'))
    mkdirSync(join(dir, 'src', 'pages'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', dependencies: { react: '^18.0.0', vite: '^5.0.0' } }),
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds the cacheable 3-element form from a real project probe, never the CMS/site prompt', () => {
    const prompt = buildStudioProjectSystemPrompt(dir)
    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    // The CMS prompt's own vocabulary must never leak into a Studio-project turn.
    expect(prompt.join(' ')).not.toContain('site_insert_html')
    expect(prompt.join(' ')).not.toContain('studio-outlet')
    // The Studio prompt's own tool vocabulary must be present.
    expect(prompt[0]).toContain('studio_create_page')
    expect(prompt[0]).toContain('studio_apply_edits')
  })

  it('the dynamic suffix carries the real dir, never a placeholder', () => {
    const prompt = buildStudioProjectSystemPrompt(dir)
    expect(prompt[2]).toContain(dir)
  })

  it('never throws for a directory a real probe cannot make sense of, and degrades honestly', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'studio-prompt-empty-'))
    try {
      expect(() => buildStudioProjectSystemPrompt(emptyDir)).not.toThrow()
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
