/**
 * iconCatalog — `GET /admin/api/studio/icons`, the answer to "what icons can
 * this project actually put in an icon slot?".
 *
 * ## Why a route, when the design system already exports icon components
 *
 * The slot picker's first icon source was the module registry: every
 * `*Icon`-suffixed export a registered design-system bundle carries
 * (`slotCandidates.ts`). For `@alm-design/design-system` that is TEN icons —
 * the chevrons, checkmarks and radio glyphs its own components draw with. The
 * package's real icon set is 568 SVG FILES under `src/icons/`, published
 * deliberately (`package.json#exports` maps `"./src/icons/*"`), and none of
 * them is a React export, so none of them could ever appear in the picker. A
 * user filling `<Cell icon={…}/>` was offered ten arrows for a set that
 * contains `wifi`, `passport`, `bed` and 300 more.
 *
 * This route reads that set off disk.
 *
 * ## What is returned, and what is deliberately left out
 *
 * `markup` rides along with each entry rather than sitting behind a second
 * per-icon request, because every consumer needs it immediately: the picker
 * PREVIEWS each icon, and picking one WRITES it. A metadata-only list would
 * force a fetch per visible row and still not let the user see what they are
 * choosing.
 *
 * That is affordable only because of {@link MAX_ICON_BYTES}. A 4 KB ceiling
 * takes 402 of this package's 568 files (651 KB total, fetched once per
 * project and cached client-side) and excludes exactly the ones that have no
 * business being inlined into a `.tsx` file anyway — the country flags run to
 * 93 KB apiece. An over-cap file is not an error and not a broken row; it is
 * simply not an icon this picker offers, which is the honest answer for a
 * graphic that would bury the user's own JSX.
 *
 * **Markup is returned RAW, unsanitised.** `sanitizeSvg` needs a DOM, and Bun
 * has none — calling it here returns the empty string for every icon, silently
 * emptying the catalog. The browser is where a DOM exists, so the browser is
 * where sanitisation happens (`iconCatalog.ts` client-side, before both the
 * preview and the JSX conversion), which is also where it has to happen
 * regardless: the same code path sanitises an SVG the user UPLOADS, which
 * never passes through this route at all.
 *
 * **Parse, never execute** holds trivially — this is `readdir` + `readFile`
 * over files in `node_modules`. Nothing is imported, bundled, or evaluated,
 * so unlike `componentBundle.ts` this route needs no trust tier.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { jsonResponse } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { resolveProjectProfile } from './projectProbe'
import { readTextCapped } from './cappedFileRead'
import { resolveAppRoot } from './appRoot'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/icons'

/**
 * Where a package keeps shipped SVG assets. Checked in order; every one that
 * exists is walked. Not a recursive search from the package root — a design
 * system's `node_modules` entry holds thousands of files, and no package
 * ships its icon set somewhere other than a conventional directory. Same
 * reasoning as `colorSchemeDetect.ts`'s `PACKAGE_CSS_DIRS`.
 */
const ICON_ROOTS = ['src/icons', 'icons', 'dist/icons', 'assets/icons', 'lib/icons', 'es/icons'] as const

/**
 * How deep a walk goes below an icon root. Two levels covers the real
 * shapes — `icons/<glyph>.svg` and `icons/<group>/<glyph>.svg` — plus one
 * more for a group that subdivides (`icons/logotypes/flags/<glyph>.svg`).
 */
const MAX_DEPTH = 3

/** Per-file ceiling. See the module doc — this is what keeps `markup` inline. */
const MAX_ICON_BYTES = 4096

/** Ceiling on the whole catalog, so a pathological dependency cannot turn one request into a full directory walk. */
const MAX_ICONS = 600

export interface StudioIcon {
  /** Stable identity: `<package>:<path below the icon root>`. */
  id: string
  /** The file's basename without `.svg` — what the picker shows and searches. */
  name: string
  /** Directory below the icon root (`line-icons`, `logotypes/flags`), or `''` at the root. Groups the picker. */
  group: string
  /** The package that ships it. */
  pkg: string
  /** Raw file text — sanitised by the CLIENT, see the module doc. */
  markup: string
}

/** Directory entries, sorted for a stable catalogue. Never throws — an absent or unreadable directory contributes nothing. */
function readDirSorted(absDir: string) {
  try {
    return readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** Every `.svg` at or below `absDir`, depth-capped, appended to `out`. */
function collectSvgFiles(absDir: string, relPrefix: string, depth: number, out: { rel: string; abs: string }[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_ICONS) return
  for (const entry of readDirSorted(absDir)) {
    if (out.length >= MAX_ICONS) return
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      collectSvgFiles(join(absDir, entry.name), rel, depth + 1, out)
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
      out.push({ rel, abs: join(absDir, entry.name) })
    }
  }
}

/** The icons one installed package ships, in `ICON_ROOTS` order. */
function packageIcons(appRootAbs: string, pkg: string, budget: number): StudioIcon[] {
  const pkgRoot = join(appRootAbs, 'node_modules', ...pkg.split('/'))
  const icons: StudioIcon[] = []
  for (const root of ICON_ROOTS) {
    if (icons.length >= budget) break
    const files: { rel: string; abs: string }[] = []
    collectSvgFiles(join(pkgRoot, ...root.split('/')), '', 1, files)
    for (const file of files) {
      if (icons.length >= budget) break
      const markup = readTextCapped(file.abs, MAX_ICON_BYTES)
      // Over-cap, unreadable, or not an SVG document at all — not an error,
      // just not an icon this picker offers. See the module doc.
      if (markup === undefined || !markup.includes('<svg')) continue
      const slash = file.rel.lastIndexOf('/')
      icons.push({
        id: `${pkg}:${file.rel}`,
        name: file.rel.slice(slash + 1).replace(/\.svg$/i, ''),
        group: slash === -1 ? '' : file.rel.slice(0, slash),
        pkg,
        markup,
      })
    }
  }
  return icons
}

/** `GET /admin/api/studio/icons?dir=<abs>` — see module doc for the full contract. */
export async function tryServeStudioIcons(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'GET') return null

  try {
    const dir = resolveProjectDir(url.searchParams.get('dir'))
    if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

    // The same package list `componentBundle.ts` bundles from, so the picker
    // can never offer an icon out of a package the canvas does not know.
    const appRootAbs = resolveAppRoot(dir)
    const icons: StudioIcon[] = []
    for (const pkg of [...resolveProjectProfile(dir).componentPackages].sort()) {
      icons.push(...packageIcons(appRootAbs, pkg, MAX_ICONS - icons.length))
    }
    return jsonResponse({ icons })
  } catch (err) {
    console.error('[studio:icons]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
