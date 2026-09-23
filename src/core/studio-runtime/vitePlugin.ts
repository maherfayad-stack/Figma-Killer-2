/**
 * vitePlugin — the workspace-side Vite plugin that stamps `data-node-id` on
 * every host JSX element (`idStamp.ts`) and injects `virtual:studio-runtime`
 * (`runtimeConfig.ts`) into the app's entry.
 *
 * This file is never imported by Studio's own admin bundle — see this
 * module's barrel (`index.ts`) for why, and
 * `src/__tests__/architecture/babel-not-in-admin-bundle.test.ts` for the gate.
 * It reaches a user's workspace only as the BUNDLED artifact
 * `scripts/sync-studio-runtime.ts` produces (mirroring
 * `scripts/sync-plugin-bootstrap.ts`'s QuickJS-bootstrap bundling) — the
 * workspace has its own, unrelated `node_modules`, so the plugin has to carry
 * `@babel/core` with it rather than depend on it being installed there.
 *
 * ## What it stamps, and what it deliberately does not
 *
 * Only `.jsx`/`.tsx` modules, mirroring (not importing —
 * `EXCLUDED_WORKSPACE_DIR_NAMES`'s own doc comment states why:
 * `@core/page-parser`'s barrel drags ts-morph into a bundle that must stay
 * ts-morph-free) the same directory exclusions the parser's own workspace walk
 * uses, PLUS the prototype shell directory itself (`PROTOTYPE_SHELL_DIR`,
 * mirrored the same way) — App.jsx/ScreenFrame.jsx/CanvasPanel are Studio's
 * own scaffold, not a page the user designed, and the parser never produces a
 * tree node at any position inside them.
 *
 * `apply: 'serve'` on the ID-STAMP HALF ONLY — that half never runs during
 * `vite build`. "Download the code" and any project-level `npm run build`
 * both go through `vite build`, and the shipped output has to stay clean
 * HTML/CSS/TS with no Studio-only markup baked in (`CLAUDE.md`'s publishing
 * rule). `data-node-id` is a live-editing aid, not something that belongs in
 * code a user hands to someone else. This is also why `playerTemplate.ts`'s
 * exported-app link resolution still has to use `indexPath` rather than a
 * node id — the downloaded app genuinely has none, by design, not by
 * omission.
 *
 * ## Two plugin objects, not one
 *
 * `studioRuntimeIdPlugin()` returns `Plugin[]` — Vite/Rollup flattens one
 * level of nested arrays wherever a `plugins: [...]` config lists a
 * `PluginOption`, so `plugins: [react(), studioRuntimeIdPlugin()]` needs no
 * edit to keep working. The two objects exist because `apply: 'serve'` is a
 * PLUGIN-level field in this installed Vite (confirmed against
 * `node_modules/vite/dist/node/index.d.ts`'s own `Plugin`/`ObjectHook`
 * types — there is no per-hook `apply`), and it disables `resolveId`/`load`
 * along with `transform`, not just `transform`. `main.jsx` imports
 * `virtual:studio-runtime` UNCONDITIONALLY (`createStudioRuntimeBridge`'s
 * boot gate needs it every time, including a plain `npm run build`, where it
 * resolves to inert `{ parentOrigins: [], projectKey: 'unknown' }` data) —
 * so the half that resolves/loads that virtual module (`runtimeConfigPlugin`)
 * must run at build time too, while the half that stamps `data-node-id`
 * (`idStampPlugin`) must not. One `apply: 'serve'`-scoped plugin object
 * cannot do both.
 */
import { relative, sep } from 'node:path'
import type { Plugin } from 'vite'
import { stampHostElementIds } from './idStamp'
import { readStudioRuntimeConfigFromEnv, STUDIO_PARENT_ORIGINS_ENV, STUDIO_PROJECT_KEY_ENV } from './runtimeConfig'

/** Mirrors `EXCLUDED_WORKSPACE_DIR_NAMES` (`@core/page-parser`) — see this file's header for why it is copied rather than imported. Keep the two lists in sync by hand. */
const EXCLUDED_DIR_NAMES = new Set(['.studio', '.git', 'node_modules', 'dist', '.next', '.turbo'])

/** Mirrors `PROTOTYPE_SHELL_DIR` (`@core/page-parser`) — see this file's header. */
const PROTOTYPE_SHELL_DIR = 'prototype'

const VIRTUAL_MODULE_ID = 'virtual:studio-runtime'
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`

const STAMPABLE_EXTENSIONS = ['.jsx', '.tsx']

/** Strips Vite's own query-string suffixes (`?v=…`, CSS-module markers, …) off a module id before treating it as a plain file path. */
function stripQuery(id: string): string {
  const i = id.indexOf('?')
  return i === -1 ? id : id.slice(0, i)
}

function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/)
  if (segments[0] === PROTOTYPE_SHELL_DIR) return true
  return segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))
}

/**
 * The Vite plugins the shell scaffolds into every workspace's `vite.config.js`
 * (as the always-regenerated bundle `prototype/studioRuntime.generated.js` —
 * see `server/handlers/studio/prototypeShell/`).
 *
 * `nodeIdAttr` is exposed as an option (default `data-node-id`, `idStamp.ts`'s
 * own constant) purely so a test can inject a distinct value without touching
 * a module-level constant; every real caller uses the default.
 *
 * Returns two plugin objects (see file header for why one cannot do both):
 * a config-resolver that is unconditional (works at `vite build` time too)
 * and the id-stamper that stays `apply: 'serve'`-only.
 */
export function studioRuntimeIdPlugin(options?: { nodeIdAttr?: string }): Plugin[] {
  const nodeIdAttr = options?.nodeIdAttr ?? 'data-node-id'
  let root = process.cwd()

  const runtimeConfigPlugin: Plugin = {
    name: 'studio-runtime-config',
    // Deliberately NO `apply` restriction — main.jsx imports
    // `virtual:studio-runtime` unconditionally, so this half must resolve
    // during `vite build` too (Download the code / preview deploys), not
    // only `vite dev`. Always safe: outside a dev server `devServer.ts`
    // itself spawned, `STUDIO_PARENT_ORIGINS_ENV`/`STUDIO_PROJECT_KEY_ENV`
    // are simply unset, so a build always resolves to
    // `{ parentOrigins: [], projectKey: 'unknown' }` — inert data.
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID
      return undefined
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined
      const config = readStudioRuntimeConfigFromEnv(process.env, nodeIdAttr)
      return `export const STUDIO_RUNTIME_CONFIG = ${JSON.stringify(config)}\n`
    },
  }

  const idStampPlugin: Plugin = {
    name: 'studio-runtime-id-plugin',
    // Runs before Vite's own esbuild JSX/TS transform, so it sees the
    // author's original TSX/JSX text — not already-compiled JS with no JSX
    // elements left to find.
    enforce: 'pre',
    // Dev server only — see this file's header on why a build/download must
    // never carry `data-node-id`.
    apply: 'serve',

    configResolved(config) {
      root = config.root
    },

    transform(code, id) {
      const filePath = stripQuery(id)
      if (!STAMPABLE_EXTENSIONS.some((ext) => filePath.endsWith(ext))) return undefined

      const relFile = relative(root, filePath).split(sep).join('/')
      if (relFile.startsWith('..') || isExcludedPath(relFile)) return undefined

      const result = stampHostElementIds(code, relFile)
      if (!result.changed) return undefined
      // No source map: this transform only ADDS attributes to existing JSX
      // opening tags, never moves or deletes source text, so a missing map
      // degrades dev-tool line mapping for this one pass rather than breaking
      // it — an accepted trade documented in this module's `STATE.md` handoff.
      return { code: result.code, map: null }
    },
  }

  // A peer resetting a socket is not a reason for the dev server to exit.
  // Studio frames this server through `server/liveOrigin.ts`, whose outbound
  // WebSocket client (Bun's) tears its TCP connection down with a RST rather
  // than a closing handshake — on `.close()`, and again when an abandoned
  // socket is finally collected. Vite's HMR server has no `'error'` listener
  // on the raw `net.Socket` at that moment, so Node treats the `ECONNRESET`
  // as an unhandled `'error'` event and the whole process exits (reproduced
  // on Vite 8 / Node 24 every time a live frame re-navigated). Listening —
  // and doing nothing — on every connection makes the reset what it is: one
  // client gone. `server.httpServer` is `null` in middleware mode, where no
  // socket is ours to guard.
  const socketGuardPlugin: Plugin = {
    name: 'studio-runtime-socket-guard',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('connection', (socket) => {
        socket.on('error', () => {})
      })
    },
  }

  return [runtimeConfigPlugin, idStampPlugin, socketGuardPlugin]
}

export { VIRTUAL_MODULE_ID, STUDIO_PARENT_ORIGINS_ENV, STUDIO_PROJECT_KEY_ENV }
