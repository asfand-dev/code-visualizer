// Adds the shebang to the CLI entry and makes it executable.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/cli.js', import.meta.url);
const code = readFileSync(file, 'utf8');
if (!code.startsWith('#!')) writeFileSync(file, `#!/usr/bin/env node\n${code}`);
chmodSync(file, 0o755);
