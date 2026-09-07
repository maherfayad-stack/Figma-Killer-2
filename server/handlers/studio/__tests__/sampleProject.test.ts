/**
 * sampleProject — unit tests for copying the checked-in sample repository.
 *
 * Three properties carry the weight. Everything copied must land INSIDE the
 * projects root and nowhere else (this writes a whole repository to disk from
 * a path the server chose, and the containment story is what makes that safe).
 * Calling it twice must produce two projects rather than replacing the first —
 * a user who has already edited their sample must not lose that work to a
 * second click. And the new project must carry `sample: true`, which is what
 * lets the launcher treat it as disposable.
 *
 * The real `examples/studio-sample-project/` is exercised too — its shape is
 * a contract (`pages/` with `.tsx` + co-located `.module.css`, exactly one
 * dependency), and a test that only ever ran against a temp fixture would not
 * notice that tree being renamed or emptied.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listStudioProjects } from '../../studioProjects'
import { SampleProjectError, createSampleProject, resolveSampleProjectDir } from '../sampleProject'
import { readStudioMeta } from '../studioMeta'

let root: string
let sample: string
let originalSampleDir: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-project-root-'))
  sample = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-project-src-'))
  fs.mkdirSync(path.join(sample, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(sample, 'pages', 'Home.tsx'), 'export default function Home() { return <div /> }\n')
  fs.writeFileSync(path.join(sample, 'pages', 'Home.module.css'), '.page { margin: 0; }\n')
  // A real manifest, so `generateStudioProjectGuide` does not fall back to
  // seeding the design system into the copy (which would be correct for a
  // project with no manifest, and would drown these assertions).
  fs.writeFileSync(path.join(sample, 'package.json'), JSON.stringify({ name: 'sample', dependencies: {} }))

  originalSampleDir = process.env.STUDIO_SAMPLE_PROJECT_DIR
  process.env.STUDIO_SAMPLE_PROJECT_DIR = sample
})

afterEach(() => {
  if (originalSampleDir === undefined) delete process.env.STUDIO_SAMPLE_PROJECT_DIR
  else process.env.STUDIO_SAMPLE_PROJECT_DIR = originalSampleDir
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(sample, { recursive: true, force: true })
})

describe('createSampleProject', () => {
  it('copies the sample into the projects root and marks it as a sample', () => {
    const project = createSampleProject(root)

    expect(project.name).toBe('Sample project')
    expect(fs.existsSync(path.join(project.dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(project.dir, 'pages', 'Home.module.css'))).toBe(true)
    // The marker the launcher reads to know this project has another copy in
    // Studio's own repository and can be thrown away.
    expect(readStudioMeta(project.dir).sample).toBe(true)
    expect(readStudioMeta(project.dir).displayName).toBe('Sample project')
    // Never opened by anyone yet — the onboarding checklist's step 2 reads
    // this field, and a copy that claimed to have been opened would tick it.
    expect(readStudioMeta(project.dir).lastOpenedAt).toBeUndefined()
  })

  it('writes only inside the projects root', () => {
    const project = createSampleProject(root)

    // Containment: an immediate child of the root, nothing above it.
    expect(path.dirname(path.resolve(project.dir))).toBe(path.resolve(root))
    expect(fs.readdirSync(root)).toEqual(['sample-project'])
  })

  it('makes a second project rather than replacing the first', () => {
    const first = createSampleProject(root)
    fs.writeFileSync(path.join(first.dir, 'pages', 'Home.tsx'), '// the user edited this\n')

    const second = createSampleProject(root)

    expect(second.name).toBe('Sample project 2')
    expect(second.dir).not.toBe(first.dir)
    // The first copy's edit survived — a second click is a second sample, not
    // a reset of the one the user has been working in.
    expect(fs.readFileSync(path.join(first.dir, 'pages', 'Home.tsx'), 'utf8')).toContain('the user edited this')
    expect(listStudioProjects(root).map((p) => p.name)).toEqual(['Sample project', 'Sample project 2'])
  })

  it('skips node_modules and .git if a developer left them in the source tree', () => {
    for (const skipped of ['node_modules', '.git']) {
      fs.mkdirSync(path.join(sample, skipped), { recursive: true })
      fs.writeFileSync(path.join(sample, skipped, 'marker'), 'x')
    }

    const project = createSampleProject(root)

    for (const skipped of ['node_modules', '.git']) {
      expect([skipped, fs.existsSync(path.join(project.dir, skipped))]).toEqual([skipped, false])
    }
  })

  it('refuses with `missing-source` when the sample is not on disk', () => {
    process.env.STUDIO_SAMPLE_PROJECT_DIR = path.join(sample, 'does-not-exist')

    expect(() => createSampleProject(root)).toThrow(SampleProjectError)
    // Nothing half-written: a failed copy leaves the workspace as it was.
    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe('the checked-in sample tree', () => {
  it('is a real, dependency-light React project', () => {
    delete process.env.STUDIO_SAMPLE_PROJECT_DIR
    const dir = resolveSampleProjectDir()

    expect(fs.existsSync(dir)).toBe(true)
    const pages = fs.readdirSync(path.join(dir, 'pages'))
    // More than one page: a board with a single frame cannot show what a board
    // is for, and the prototype step needs two frames to link between.
    expect(pages.filter((name) => name.endsWith('.tsx')).length).toBeGreaterThan(1)
    // Co-located CSS Modules — the same shape `pageTemplates.ts` scaffolds, so
    // an agent reading this project continues Studio's own convention.
    expect(pages.some((name) => name.endsWith('.module.css'))).toBe(true)

    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {}
    // Exactly `react`. Anything else is a package that has to be INSTALLED
    // before the project builds, and Studio copies rather than installing.
    expect(Object.keys(dependencies)).toEqual(['react'])
    // No `.studio/` sidecar: the meta is written by the copy, so there is one
    // place that decides what a fresh sample's meta says.
    expect(fs.existsSync(path.join(dir, '.studio'))).toBe(false)
  })
})
