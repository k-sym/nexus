import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on 5173, exposed on the LAN (--host) so the Even app / simulator
// can reach it. The hub base URL + token are entered at runtime (Connect screen).
//
// base: default '/' for the gateway-hosted build (served at the origin root). The
// `.ehpk` package build sets VITE_BASE=./ so assets resolve relative to the package
// root when the Even app serves the bundle locally (there's no origin to anchor
// an absolute '/assets/…' path against).
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: { port: 5173, host: true },
})
