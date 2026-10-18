import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = fileURLToPath(new URL('.', import.meta.url));

// The report UI is built into ONE self-contained HTML file (dist/report/index.html).
// At runtime the CLI injects the analysis data into it, so reports work offline and can be shared.
export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: fileURLToPath(new URL('../dist/report', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
  },
  server: { port: 5175, open: false },
});
