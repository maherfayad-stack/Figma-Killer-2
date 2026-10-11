/**
 * assetPrune — the two routes behind the Assets panel's "unused images"
 * (P5-B3, IMG-11):
 *
 *   - `GET  /admin/api/studio/asset-ledger?dir=` — which images Studio added
 *     that nothing references any more (`findUnusedLedgerAssets`). A read.
 *   - `POST /admin/api/studio/asset-prune { dir?, relPaths }` — delete the
 *     ones the user CONFIRMED. The only route in Studio that deletes a file a
 *     drop created, and it only ever runs because the user asked, behind a
 *     confirmation (`UnusedImagesFooter`). Nothing calls it on its own.
 *
 * ## What the prune refuses to delete (security review)
 *
 * The request names paths, and a path from a request is never trusted. A
 * file is deleted only when, at the moment of the request, ALL of these hold —
 * recomputed here, never taken from the report the browser was shown:
 *
 *   1. it is in the ledger, i.e. Studio itself CREATED it (a file the user or
 *      their repository put there is never a candidate, whatever its name);
 *   2. it is an image path, a regular file (not a link) whose real path is
 *      inside the project and outside every excluded directory, and its bytes
 *      still hash to what Studio wrote (`unchangedLedgerFile`) — a file the
 *      user has since replaced is theirs;
 *   3. nothing references it (`findUnusedLedgerAssets`, re-run now), and that
 *      scan completed — a partial scan prunes nothing;
 *   4. the request asked for it by exactly that path.
 *
 * Anything else is reported back as kept, with the reason. Declared in
 * `routeCapabilities.ts` (`asset-prune` a `studio.write`, `asset-ledger` a
 * `site.read`), so the gate's capability and CSRF checks ran first.
 */
import { unlinkSync } from 'node:fs'
import { Type } from '@core/utils/typeboxHelpers'
import { RequestBodyTooLargeError, badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { findUnusedLedgerAssets, readAssetLedger, unchangedLedgerFile, writeAssetLedger } from './assetLedger'

const LEDGER_PATH = '/admin/api/studio/asset-ledger'
const PRUNE_PATH = '/admin/api/studio/asset-prune'

/** A confirm dialog lists what it deletes; a request for more than this is not one. */
export const MAX_PRUNE_PATHS = 500

const AssetPruneBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  relPaths: Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: MAX_PRUNE_PATHS }),
})

export interface AssetPruneDeps {
  /** Test-only, mirroring `AssetDropDeps.resolveDir`. */
  resolveDir?: (requested: string | null | undefined) => string
}

export type PruneResult = {
  deleted: string[]
  kept: { relPath: string; reason: string }[]
}

/**
 * Delete every requested path that passes the module doc's four conditions,
 * and drop it from the ledger. Exported for its own test.
 */
export function pruneUnusedAssets(
  dir: string,
  requested: readonly string[],
  deps: { afterScan?: () => void } = {},
): PruneResult | { incomplete: true } {
  const report = findUnusedLedgerAssets(dir)
  if (report.incomplete) return { incomplete: true }
  const unused = new Set(report.unused.map((asset) => asset.relPath))
  const entries = new Map(readAssetLedger(dir).map((entry) => [entry.relPath, entry]))
  // Test seam: the reference scan above can take seconds, which is the window
  // the re-check below exists for (review of #275, N2).
  deps.afterScan?.()

  const deleted: string[] = []
  const kept: PruneResult['kept'] = []
  for (const relPath of new Set(requested)) {
    if (!unused.has(relPath)) {
      kept.push({ relPath, reason: 'Studio did not add this image, it changed since, or something still uses it.' })
      continue
    }
    // Re-checked IMMEDIATELY before the delete: a save to the image during the
    // scan makes it the user's again, and the delete targets the REAL path the
    // check just hashed — never the spelled one, which a directory swapped for
    // a junction in that window could redirect.
    const entry = entries.get(relPath)
    const file = entry ? unchangedLedgerFile(dir, entry) : null
    if (!file) {
      kept.push({ relPath, reason: 'The image changed while Studio was checking it, so it was kept.' })
      continue
    }
    try {
      unlinkSync(file.real)
      deleted.push(relPath)
    } catch (err) {
      console.error('[studio:asset-prune] could not delete', relPath, err)
      kept.push({ relPath, reason: 'The file could not be deleted.' })
    }
  }
  if (deleted.length > 0) {
    const gone = new Set(deleted)
    writeAssetLedger(dir, readAssetLedger(dir).filter((entry) => !gone.has(entry.relPath)))
  }
  return { deleted, kept }
}

export async function tryServeStudioAssetLedger(
  req: Request,
  url: URL,
  pathname: string,
  deps: AssetPruneDeps = {},
): Promise<Response | null> {
  const resolveDir = deps.resolveDir ?? resolveProjectDir
  if (pathname === LEDGER_PATH && req.method === 'GET') {
    try {
      return jsonResponse(findUnusedLedgerAssets(resolveDir(url.searchParams.get('dir'))))
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:asset-ledger]', err)
      return jsonResponse({ error: 'Studio could not work out which images are unused.' }, { status: 500 })
    }
  }
  if (pathname !== PRUNE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, AssetPruneBodySchema, { maxBytes: 256 * 1024 })
    if (!body) return badRequest('invalid asset-prune body')
    const result = pruneUnusedAssets(resolveDir(body.dir), body.relPaths)
    if ('incomplete' in result) {
      return jsonResponse(
        { error: 'This project has too much text for Studio to be sure nothing uses these images, so nothing was deleted.' },
        { status: 409 },
      )
    }
    return jsonResponse(result)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    if (err instanceof RequestBodyTooLargeError) return jsonResponse({ error: 'The request is too large.' }, { status: 413 })
    console.error('[studio:asset-prune]', err)
    return jsonResponse({ error: 'The unused images could not be deleted.' }, { status: 500 })
  }
}
