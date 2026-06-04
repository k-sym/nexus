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
    port: 5173,
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
