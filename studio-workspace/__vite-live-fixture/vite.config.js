import { defineConfig } from 'vite'

// The presence of this file is the first of `resolveLiveCapability`'s two
// conditions (`framework: 'vite'`). Its contents are never executed by Studio —
// `projectProbe.ts` reads the config statically and says so in as many words.
export default defineConfig({
  server: { port: 5199 },
})
