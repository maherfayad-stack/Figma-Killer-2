import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './shell.css'
import { STUDIO_RUNTIME_CONFIG } from 'virtual:studio-runtime'
import { createStudioRuntimeBridge, resolveParentOrigin } from './studioRuntimeBridge.generated.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Boots the live-canvas runtime bridge only when THIS dev server was
// spawned under Studio's own supervision (server/handlers/studio/devServer.ts
// sets STUDIO_PARENT_ORIGINS on the process only then — never for a plain
// 'npm run dev', including every copy Studio hands out via 'Download the
// code'), this document is actually embedded in a frame, AND the document
// that framed it is one of the origins Studio said may do so. The parent is
// read off the browser's own record of who framed this document
// (location.ancestorOrigins, which survives a Vite full reload) or, where a
// browser lacks that, document.referrer, and checked against that list — the
// list says who may be a parent, the browser says which one is. A supervised
// dev server opened directly in a normal browser tab has neither and boots
// no bridge, because there is nothing to talk to.
const studioParentOrigin = resolveParentOrigin(STUDIO_RUNTIME_CONFIG.parentOrigins, document.referrer)
if (studioParentOrigin && window.parent !== window) {
  createStudioRuntimeBridge({
    parentOrigin: studioParentOrigin,
    hot: import.meta.hot,
  })
}
