import { StrictMode } from 'react'
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
