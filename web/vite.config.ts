import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  // `npm run dev` expects `codecity serve` running on :8080 (the page talks to its /api)
  server: { proxy: { '/api': 'http://127.0.0.1:8080', '/city.json': 'http://127.0.0.1:8080' } },
});
