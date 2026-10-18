import { defineConfig } from 'vite';

// The browser app lives in web/ (web/index.html → web/src/main.tsx).
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web' },
});
