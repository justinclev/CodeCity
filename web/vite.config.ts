import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  // `npm run dev` expects `codecity serve <repo>` running on :8080 for /city.json
  server: { proxy: { '/city.json': 'http://127.0.0.1:8080' } },
});
