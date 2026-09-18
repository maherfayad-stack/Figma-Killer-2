/**
 * bootstrapTemplates — the three files that make a scaffolded workspace
 * actually START: the HTML document, the Vite config, and the entry module
 * that mounts `<App/>` and boots the live-canvas runtime bridge.
 *
 * Split out of `shellFiles.ts` (module-size-budgets gate, and the split that
 * file's own grandfather note already named: "per-screen vs. bootstrap
 * template generators"). They belong together and apart from the rest: these
 * three are about the PROCESS — how the dev server is configured, what the
 * browser loads first, what runs before anything renders — while `App.jsx`,
 * `ScreenFrame.jsx` and the canvas templates are about the board a user looks
 * at. Every one of them is still "written once, then yours"; `shellFiles.ts`'s
 * module doc is the contract for all of it.
 *
 * ## No backticks below, on purpose
 *
 * Same rule as `shellFiles.ts`: these templates are themselves template
 * literals, so every backtick and every `${` in the emitted source would need
 * escaping, and an escaping slip produces a file that is broken in the user's
 * project rather than in a test.
 */
import { STUDIO_LIVE_BASE_PATH_ENV } from '../devServer'

/** Where {@link VITE_CONFIG} lands — exported so `index.ts` can name it specifically when reporting `viteConfigEditedByUser`, without a second string literal to keep in sync. */
export const VITE_CONFIG_REL_PATH = 'vite.config.js'

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prototype</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/prototype/main.jsx"></script>
  </body>
</html>
`

export const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { studioRuntimeIdPlugin } from './prototype/studioRuntime.generated.js'

// The workspace root IS the app root: pages/, components/ and i18n/ sit
// beside this file, exactly as Studio reads them.
//
// studioRuntimeIdPlugin() stamps every host JSX element with the same
// data-node-id the Studio parser mints for it, so a live frame's DOM can be
// matched back to the exact source position an edit should land on. It lives
// in prototype/studioRuntime.generated.js, not inline here, because that file
// is rewritten on every project open — this file is written once and then
// left alone the moment you edit it (see Studio's prototype-shell docs).
//
// 'base' comes from STUDIO_LIVE_BASE_PATH, an env var the dev-server manager
// (server/handlers/studio/devServer.ts) sets only when it spawns this process
// FOR Studio's own live-origin proxy — '/p/<projectKey>/', so every asset URL
// Vite serves ('/@vite/client', the HMR websocket, index.html's own
// root-absolute script src) carries the same prefix the proxy forwards
// requests under. index.html deliberately does NOT also spell this out with
// '%BASE_URL%' — Vite's dev/build HTML transform already rewrites every
// root-absolute src/href it finds to carry 'base' automatically; adding
// '%BASE_URL%' on top of an already-root-absolute path double-prefixes it
// (confirmed empirically against a real running dev server — see live-06,
// STATE.md — before this comment was written the wrong way). A bare
// 'npm run dev' never sets this env var, so 'base' defaults to '/' and
// nothing here changes for that case.
//
// Vite's own error overlay is left ENABLED (it is on by default; nothing here
// sets 'server.hmr.overlay: false'), deliberately. When this app is running
// inside a Studio live frame, a compile error is your app telling you the
// truth in your app's own words, in the frame where it happened — Studio adds
// a quiet badge beside it rather than replacing it. Do not switch it off to
// make the canvas look tidier.
export default defineConfig({
  plugins: [react(), studioRuntimeIdPlugin()],
  base: process.env.${STUDIO_LIVE_BASE_PATH_ENV} || '/',
  server: { open: true },
})
`

export const MAIN_JSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './shell.css'
import { STUDIO_RUNTIME_CONFIG } from 'virtual:studio-runtime'
import { createStudioRuntimeBridge } from './studioRuntimeBridge.generated.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Boots the live-canvas runtime bridge only when THIS dev server was
// spawned under Studio's own supervision (server/handlers/studio/devServer.ts
// sets STUDIO_PARENT_ORIGIN_ENV on the process only then — never for a
// plain 'npm run dev', including every copy Studio hands out via
// 'Download the code') AND this document is actually embedded in a frame.
// Neither check alone is enough: a supervised dev server opened directly in
// a normal browser tab must not boot a bridge with nothing to talk to.
if (STUDIO_RUNTIME_CONFIG.parentOrigin && window.parent !== window) {
  createStudioRuntimeBridge({
    parentOrigin: STUDIO_RUNTIME_CONFIG.parentOrigin,
    hot: import.meta.hot,
  })
}
`
