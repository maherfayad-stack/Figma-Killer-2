/**
 * sampleProject — copying the checked-in sample repository into the user's
 * workspace, on request.
 *
 * ## Why a real repository and not a scaffold
 *
 * "New project" scaffolds one starter page. That is the right thing when the
 * user has something in mind, and useless when they do not: a board with one
 * screen on it cannot show what a board is for, and nothing on it is worth
 * editing. The sample is three pages of plain React with co-located CSS
 * Modules (`examples/studio-sample-project/`) — enough for a real board, a
 * real selection, and a prototype link between two frames.
 *
 * ## Copied, never installed, never automatic
 *
 * Same posture as `./projectSeed.ts`, for the same two reasons: a copy runs
 * nothing, so it is Tier-0-safe by construction, and it needs no registry and
 * takes no install time. The sample's only declared dependency is `react`, so
 * there is nothing here that a missing `node_modules` makes wrong.
 *
 * It is also never created for the user. It appears as a third path in the
 * launcher's no-projects empty state and copies only when clicked — a
 * workspace that silently grows a project nobody asked for is a workspace the
 * user cannot trust to be theirs.
 *
 * ## `sample: true`
 *
 * The new project's `.studio/meta.json` records that it came from here, so the
 * launcher can say a sample can be deleted without ceremony — it is the one
 * project in the workspace with another copy of itself in the repository. The
 * checked-in tree carries no `.studio/` of its own: the meta is written here,
 * so one place decides what a fresh sample's meta says.
 */
import { cpSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { frameDefaultsForPlatform } from '@core/studio-board'
import {
  listStudioProjects,
  safeProjectFolderName,
  studioProjectSummary,
  type StudioProjectSummary,
} from '../studioProjects'
import { generateStudioProjectGuide } from './projectGuide'
import { writeStudioMeta } from './studioMeta'

/**
 * Why the sample could not be copied. `missing-source` is an install problem
 * (the repository was deployed without `examples/`), `name-taken` means a
 * thousand samples already exist, which is not a real case.
 */
export type SampleProjectFailure = 'missing-source' | 'name-taken'

export class SampleProjectError extends Error {
  // Declared and assigned rather than a constructor parameter property:
  // `erasableSyntaxOnly` is on, and a parameter property is syntax that has to
  // be compiled away rather than erased.
  readonly reason: SampleProjectFailure

  constructor(reason: SampleProjectFailure, message: string) {
    super(message)
    this.name = 'SampleProjectError'
    this.reason = reason
  }
}

/** The display name the first copy takes; later copies get ` 2`, ` 3`, …. */
const SAMPLE_DISPLAY_NAME = 'Sample project'

/** The form factor the sample is drawn for — three desktop-width marketing pages. */
const SAMPLE_PLATFORM = 'web' as const

/** How many `Sample project N` candidates to try. Reaching this is not a real case. */
const MAX_NAME_ATTEMPTS = 1000

/**
 * Directory names never copied out of the sample. Build output and
 * `node_modules` should never be in the checked-in tree at all, so this is a
 * belt-and-braces filter rather than a load-bearing one — but a developer who
 * runs `bun install` inside `examples/studio-sample-project/` to try it should
 * not thereby make every copied sample 100 MB.
 */
const UNCOPIED_DIR_NAMES: ReadonlySet<string> = new Set([...EXCLUDED_WORKSPACE_DIR_NAMES, '.git'])

/**
 * Where the checked-in sample lives.
 *
 * `STUDIO_SAMPLE_PROJECT_DIR` relocates it, read per call so a test can point
 * it at a temp fixture — the same reason and the same shape as
 * `projectsRootDir`'s `STUDIO_WORKSPACE_DIR` and `resolveProjectSeedDir`'s
 * `STUDIO_PROJECT_SEED_DIR`.
 */
export function resolveSampleProjectDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_SAMPLE_PROJECT_DIR
  return configured ? resolve(configured) : join(process.cwd(), 'examples', 'studio-sample-project')
}

/**
 * The first display name of the form `Sample project`, `Sample project 2`, …
 * that no existing project uses AND whose slug is not already a folder on
 * disk. Both checks matter for the same reason `projectDuplicate.ts`'s
 * `availableCopyName` makes both: display names and folder slugs drift apart
 * the moment a project is renamed.
 */
function availableSampleName(projectsRoot: string): { displayName: string; folder: string } {
  const taken = new Set(listStudioProjects(projectsRoot).map((project) => project.name))
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const displayName = attempt === 1 ? SAMPLE_DISPLAY_NAME : `${SAMPLE_DISPLAY_NAME} ${attempt}`
    const folder = safeProjectFolderName(displayName)
    if (folder && !taken.has(displayName) && !existsSync(join(projectsRoot, folder))) {
      return { displayName, folder }
    }
  }
  throw new SampleProjectError('name-taken', `Could not find a free name based on "${SAMPLE_DISPLAY_NAME}".`)
}

/**
 * Copies the sample into `projectsRoot` under the first free name and returns
 * the new project's summary.
 *
 * Idempotent in the only sense that matters here: calling it twice never
 * overwrites the first copy — it makes a second project beside it, the same
 * way "Duplicate" does. A user who has already edited their sample and clicks
 * the button again gets a fresh one, not their work replaced.
 */
export function createSampleProject(projectsRoot: string): StudioProjectSummary {
  const source = resolveSampleProjectDir()
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new SampleProjectError(
      'missing-source',
      'This installation does not have the sample project on disk.',
    )
  }

  const root = resolve(projectsRoot)
  const { displayName, folder } = availableSampleName(root)
  // Built from a slug this module just checked is free inside `root`, so it is
  // an immediate child of the projects root by construction — there is no
  // caller-supplied path anywhere in this function to contain.
  const destination = join(root, folder)

  cpSync(source, destination, {
    recursive: true,
    // Never follow a symlink out of the source tree — the same rule every
    // other workspace copy applies, for the same reason.
    dereference: false,
    filter: (src) => !UNCOPIED_DIR_NAMES.has(basename(src)),
  })

  // A whole write, not a merge: the sample carries no `.studio/` of its own,
  // so there is nothing on disk to preserve and every field below is decided
  // here. `lastOpenedAt` is deliberately absent — nobody has opened it yet.
  writeStudioMeta(destination, {
    displayName,
    sample: true,
    platform: SAMPLE_PLATFORM,
    frameDefaults: frameDefaultsForPlatform(SAMPLE_PLATFORM),
  })
  // `CLAUDE.md` + the design-system references, same call and same reason as
  // the create and duplicate routes: the agent reads the guide first, and a
  // project without one is a project it has to rediscover.
  generateStudioProjectGuide(destination)

  return studioProjectSummary(destination)
}
