// Generates ui/.dev-data.json for `npm run dev` (UI development with live reload).
// Usage: node scripts/dev-data.mjs [projectRoot]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? process.env.CV_DEV_ROOT ?? path.join(here, '..'));
const out = path.join(here, '..', 'ui', 'dev-data.json');
const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'dump-json.ts'), root, out], {
  stdio: 'inherit',
  cwd: path.join(here, '..'),
});
process.exit(result.status ?? 1);
