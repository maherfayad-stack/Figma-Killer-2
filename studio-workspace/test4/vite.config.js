import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The workspace root IS the app root: pages/, components/ and i18n/ sit
// beside this file, exactly as Studio reads them.
export default defineConfig({
  plugins: [react()],
  server: { open: true },
})
