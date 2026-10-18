import fs from 'node:fs';
import { analyze } from '../src/analyzer/index.js';

const [root, out] = process.argv.slice(2);
const started = Date.now();
const data = await analyze({ root, toolVersion: 'dev' });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`Analyzed ${data.stats.files} files in ${Date.now() - started}ms → ${out}`);
