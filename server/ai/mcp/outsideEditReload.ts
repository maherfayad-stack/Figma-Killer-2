/**
 * outsideEditReload — while a project is open in an editor tab, a file that
 * changes on disk WITHOUT Studio writing it reaches that tab's board (P1-D,
 * closes ERR-19).
 *
 * Before this the board noticed only its own writes and the agent's MCP
 * writes. An edit in VS Code, a `git pull`, or the Claude CLI's own Edit tool
 * left the canvas showing the previous file until someone reloaded by hand —
 * and every `line:col` it held below the change named a different element, so
 * the next gesture posted a stale id (WB-1, compounding ERR-4).
 *
 * This is the glue and nothing more:
 *
 *   - `projectWatch.ts` owns watching — the debounce, the ignored paths, and
 *     telling Studio's own writes (`origin: 'studio'`) from everyone else's;
 *   - `liveReloadPush.ts` owns the push — the same `studio_live_reload` relay
 *     the MCP write tools use, sent to every tab on the project;
 *   - the browser owns what to re-read (`agent/studioLiveReload.ts` hands the
 *     files to `studioBoardResync.ts`, which asks `/reload-scope` how narrow a
 *     re-read can honestly be).
 *
 * What this module decides is which changes are worth a push:
 *
 *   - only `outside` ones. Studio's own writes are already followed by the
 *     writer's own resync, which is ordered against its save baselines; a
 *     second, unordered reload would race it;
 *   - only files the board is built from ({@link BOARD_INPUT}): source,
 *     stylesheets, JSON (dictionaries, `tsconfig.json`, `package.json`), SVG
 *     (`?raw` icons), and anything under `.studio/canvas/`. A README or an
 *     image does not change a single frame, and asking for a reload for one
 *     would re-read the whole board, because no page depends on it;
 *   - an overflow (the watch itself failed) names nothing at all, so it
 *     pushes an empty list, which the board answers with a full re-read.
 *
 * ## Lifetime
 *
 * `handlers/editorBridge.ts` retains the project for as long as a tab's bridge
 * stream is open. The stream is re-established every two minutes by design
 * (`STREAM_LEASE_MS`), with a three-second gap, so the watcher outlives its
 * last tab by {@link LINGER_MS} rather than closing and re-walking the tree on
 * every lease renewal.
 */
import { extname } from 'node:path'
import { subscribeProjectChanges, type ProjectChange, type ProjectChangeBatch } from '../../handlers/studio/projectWatch'
import { pushStudioDiskChange } from './tools/studio/liveReloadPush'
import { CANVAS_LAYER_DIR } from '@core/studio-board'

/** How long the watcher outlives the last tab — longer than a bridge lease renewal's reconnect gap. */
export const LINGER_MS = 15_000

/** Extensions of the files a board is built from — see this module's doc. */
const BOARD_INPUT = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.css', '.scss', '.sass', '.less', '.json', '.svg'])

/** Package-manager output: rewritten by every install, read by no frame. */
const NOT_BOARD_INPUT = new Set(['package-lock.json'])

function isBoardInput(change: ProjectChange): boolean {
  if (change.rel.startsWith(`${CANVAS_LAYER_DIR}/`)) return true
  const name = change.rel.slice(change.rel.lastIndexOf('/') + 1)
  return BOARD_INPUT.has(extname(name).toLowerCase()) && !NOT_BOARD_INPUT.has(name)
}

/**
 * The files to push for one watcher batch: `null` for nothing to push, `[]`
 * for "re-read everything" — see this module's doc.
 */
export function outsideChangesToPush(batch: ProjectChangeBatch): string[] | null {
  if (batch.overflow) return []
  const files = batch.changes
    .filter((change) => change.origin === 'outside' && isBoardInput(change))
    .map((change) => change.rel)
  return files.length > 0 ? files : null
}

interface Retained {
  holders: number
  unsubscribe: () => void
  linger: ReturnType<typeof setTimeout> | null
}

const retained = new Map<string, Retained>()

/**
 * Keep the outside-edit reload running for `projectDir` until the returned
 * function is called. `projectDir` must already be validated (the bridge
 * handler's `resolveValidatedWorkspaceDir`); it is also the `dir` the push
 * names, so it must be the spelling the tab knows the project by.
 */
export function retainOutsideEditReload(projectDir: string): () => void {
  let entry = retained.get(projectDir)
  if (!entry) {
    entry = {
      holders: 0,
      linger: null,
      unsubscribe: subscribeProjectChanges(projectDir, (batch) => {
        const files = outsideChangesToPush(batch)
        if (files !== null) pushStudioDiskChange(projectDir, files)
      }),
    }
    retained.set(projectDir, entry)
  }
  if (entry.linger) clearTimeout(entry.linger)
  entry.linger = null
  entry.holders += 1

  const held = entry
  let released = false
  return () => {
    if (released) return
    released = true
    held.holders -= 1
    if (held.holders > 0) return
    held.linger = setTimeout(() => {
      if (held.holders > 0 || retained.get(projectDir) !== held) return
      held.unsubscribe()
      retained.delete(projectDir)
    }, LINGER_MS)
  }
}
