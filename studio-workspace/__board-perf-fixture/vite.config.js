import { defineConfig } from 'vite'
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
//
// 'server.host' is pinned to 127.0.0.1 on purpose. Vite's default host,
// 'localhost', makes Node bind only the FIRST address the name resolves to —
// ::1 on a modern macOS/Linux — so a port another server already holds on
// 127.0.0.1 looks free, Vite takes it on IPv6, and Studio's live-origin proxy
// (which resolves 'localhost' to 127.0.0.1) then talks to the wrong server.
// Pinning IPv4 makes the port probe, the printed URL and the proxy agree.
// 'server.open' stays on for your own 'npm run dev' and is off when Studio
// spawns this process — a canvas opening must not open a browser tab.
export default defineConfig({
  plugins: [react(), studioRuntimeIdPlugin()],
  base: process.env.STUDIO_LIVE_BASE_PATH || '/',
  server: { host: '127.0.0.1', open: !process.env.STUDIO_LIVE_BASE_PATH },
})
