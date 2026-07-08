import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on 5173, exposed on the LAN (--host) so the Even app / simulator
// can reach it. The hub base URL + token are entered at runtime (Connect screen).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
})
