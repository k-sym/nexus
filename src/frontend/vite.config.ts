import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Honor PORT when set (e.g. the preview tool's auto-assigned port);
    // default to 5173 for the normal `npm run dev` workflow.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      // Object form with ws:true so the PTY WebSocket (/api/threads/:id/pty)
      // upgrade is proxied to the backend, not just plain HTTP requests.
      '/api': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@nexus/shared': path.resolve(__dirname, '../shared/index.ts'),
    },
  },
});
