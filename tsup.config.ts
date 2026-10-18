import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli/bin.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: false,
  // Clean only the CLI's own outputs; dist/report (the UI template) is built separately.
  clean: ['!report/**'],
  splitting: true,
  shims: false,
  banner: ({ format }) => (format === 'esm' ? { js: '' } : {}),
  define: { __CV_VERSION__: JSON.stringify(pkg.version) },
  external: ['typescript'],
  onSuccess: 'node scripts/postbuild.mjs',
});
