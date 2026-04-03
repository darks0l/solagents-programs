import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: '../site',
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
});
