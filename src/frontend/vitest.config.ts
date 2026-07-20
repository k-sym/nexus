import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    exclude: [...configDefaults.exclude, 'visual/**'],
  },
  resolve: {
    alias: {
      '@nexus/shared': path.resolve(__dirname, '../shared/index.ts'),
    },
  },
});
