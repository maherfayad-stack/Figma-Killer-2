/**
 * prototypeCodeFlow — the flow map Studio derives from the user's own source.
 *
 * `STUDIO-PROTOTYPE-PLAN.md` §1: connectors the designer drew are a design
 * layer, and that is honest as far as it goes, but a board that only shows what
 * somebody drew is a board Figma already has. This module is the other half —
 * it reads the navigation the code ALREADY performs and hands it back as
 * read-only edges, so the flow map is true before anyone has drawn anything.
 *
 * It is DERIVED, never stored. `.studio/prototype.json` holds authored links
 * only; a persisted copy of this would go stale the first time the user edited
 * a handler, and a stale claim about the code is worse than no claim.
 *
 * WHY IT IS ITS OWN PARSE AND NOT A FIELD ON THE PAGE PARSER'S OUTPUT
 * ──────────────────────────────────────────────────────────────────
 * The page parser answers "what does this render". It sees `onClick` and
 * records only that a handler EXISTS (`ParsedNode.codeProps` /
 * `codeFunctionPaths`), because a function has no value the canvas can hold —
 * and that is correct for its job. "Where does this go" is a different
 * question, project-wide rather than per-node (it needs every page's routes to
 * answer at all), and wanted at a different time (a board-level view, not a
 * frame render). Bolting it onto the render parse would put a whole-project
 * concern inside a per-page function and make every page render pay for it.
 *
 * COST
 * ────
 * One purely syntactic ts-morph parse per page file — no type checker, no
 * tsconfig, no cross-file resolution — memoized on the page files' mtimes, so
 * a board load after an unrelated edit is a `statSync` per page and nothing
 * else. The page parser's own cache (`pageParseCache.ts`) is keyed on far more
 * and cannot be shared: it is invalidated by things (compiled CSS, preview
 * locale) that cannot change a single navigation target.
 */
import { existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Project } from 'ts-morph'
import type { SourceFile } from 'ts-morph'
import { codeFlowEdgeId, createCodeFlow, type CodeFlow, type CodeFlowEdge } from '@core/studio-prototype'
import {
  discoverAppRouterRoutes,
  discoverPageFiles,
  projectPagesDir,
} from '../studioProjects'
import { assignAppRouterPageIds, assignPageIds } from '../studioPageIds'
import { readStudioMeta } from './studioMeta'
import { buildRouteIndex, resolveNavTarget, type RoutePage } from './prototypeRouteIndex'
import { scanNavCandidates } from './prototypeNavScan'

/** A page file, with everything the scan needs to name and place it. */
interface FlowPage extends RoutePage {
  /** Absolute path to the file. */
  file: string
  /** POSIX path relative to the PROJECT dir — the prefix of every node id in this file. */
  relFile: string
}

/**
 * Discover the project's pages exactly the way `loadStudioPages` does, so the
 * page ids here are the same strings the board's frames carry. Any divergence
 * would silently produce edges pointing at pages that do not exist on the
 * board, which is indistinguishable from "this project has no flows".
 */
function discoverFlowPages(dir: string): FlowPage[] {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return []

  const toFlowPage = (relPath: string, pageId: string): FlowPage => {
    const file = join(pagesDir, ...relPath.split('/'))
    return { pageId, relPath, file, relFile: relative(dir, file).split(sep).join('/') }
  }

  if (readStudioMeta(dir).profile?.framework === 'next-app') {
    const routes = discoverAppRouterRoutes(pagesDir)
    const ids = assignAppRouterPageIds(routes)
    return routes.map(({ relPath }) => toFlowPage(relPath, ids.get(relPath)!))
  }

  const relPaths = discoverPageFiles(pagesDir)
  const ids = assignPageIds(relPaths)
  return relPaths.map((relPath) => toFlowPage(relPath, ids.get(relPath)!))
}

/**
 * Derive the flow map for one project.
 *
 * Every candidate whose target does not resolve to exactly one page is dropped
 * — an external URL, a `#anchor`, a template literal with a substitution, or a
 * spelling two pages both answer to. The result is only ever edges Studio can
 * name both ends of.
 */
export function deriveCodeFlow(dir: string): CodeFlow {
  const pages = discoverFlowPages(dir)
  if (pages.length === 0) return createCodeFlow()

  const index = buildRouteIndex(pages)
  // Syntax-only: no tsconfig, no type checker, no file globbing. Every file is
  // added by hand below, so this Project never touches anything but the pages.
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true })
  const edges: CodeFlowEdge[] = []
  const seen = new Set<string>()

  for (const page of pages) {
    let sourceFile: SourceFile
    try {
      sourceFile = project.getSourceFile(page.file) ?? project.addSourceFileAtPath(page.file)
    } catch (err) {
      // One unreadable or unparseable page must not blank the whole board's
      // flow map — the same posture every Studio serializer takes on a bad
      // entry. It is logged because a page that cannot be read at all is also
      // a page that will not render.
      console.error('[studio:prototype-flow]', err)
      continue
    }

    for (const candidate of scanNavCandidates(sourceFile, page.relFile)) {
      const targetPageId = resolveNavTarget(index, candidate.target)
      if (targetPageId === null) continue

      const edge = {
        sourcePageId: page.pageId,
        sourceNodeId: candidate.sourceNodeId,
        targetPageId,
        via: candidate.via,
        evidence: candidate.evidence,
      }
      const id = codeFlowEdgeId(edge)
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, ...edge })
    }
  }

  return { edges }
}

/** `relPath:mtimeMs` for every page file — the whole of what can change an edge. */
function pagesFingerprint(dir: string): string {
  try {
    return discoverFlowPages(dir)
      .map((page) => {
        try {
          return `${page.relPath}:${statSync(page.file).mtimeMs}`
        } catch {
          // A file that vanished between discovery and stat is a real change.
          return `${page.relPath}:gone`
        }
      })
      .join('|')
  } catch (err) {
    console.error('[studio:prototype-flow]', err)
    return ''
  }
}

const cache = new Map<string, { fingerprint: string; flow: CodeFlow }>()

/**
 * `deriveCodeFlow`, memoized per project on the page files' mtimes.
 *
 * One entry per project directory rather than an LRU: the map is bounded by how
 * many projects one server has ever served, each entry is a handful of small
 * objects, and evicting a project a user is actively working in to make room
 * for one they opened once would trade the only case that matters for the one
 * that does not.
 */
export function readCodeFlow(dir: string): CodeFlow {
  const fingerprint = pagesFingerprint(dir)
  const cached = cache.get(dir)
  if (cached && cached.fingerprint === fingerprint) return cached.flow

  const flow = deriveCodeFlow(dir)
  cache.set(dir, { fingerprint, flow })
  return flow
}
