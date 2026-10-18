import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { renderReportHtml, writeReport } from '../src/report/html.js';
import { fixturePath } from './helpers.js';

const template = fileURLToPath(new URL('../dist/report/index.html', import.meta.url));
const hasTemplate = fs.existsSync(template);

function embeddedData(html: string): unknown {
  const match = html.match(/<script id="cv-data" type="application\/octet-stream" data-encoding="gzip-base64">([^<]+)<\/script>/);
  if (!match) throw new Error('data script not found');
  return JSON.parse(zlib.gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8'));
}

describe.skipIf(!hasTemplate)('report HTML (requires `npm run build:ui`)', () => {
  it('embeds the analysis as gzip+base64 and sets the title', async () => {
    const data = await analyze({ root: fixturePath('react-vite-ts'), git: false });
    const html = renderReportHtml(data, template);
    expect(html).toContain('<title>react-vite-ts · Code Visualizer</title>');
    expect(html).not.toContain('<!--CODE_VISUALIZER_DATA-->');
    const decoded = embeddedData(html) as typeof data;
    expect(decoded.project.name).toBe('react-vite-ts');
    expect(decoded.files.length).toBe(data.files.length);
  });

  it('escapes project names in the title', async () => {
    const data = await analyze({ root: fixturePath('express-api'), git: false, includeSource: false });
    data.project.name = '<script>alert(1)</script>';
    const html = renderReportHtml(data, template);
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt; · Code Visualizer</title>');
  });

  it('writes the report, a .gitignore for the default folder and optional JSON', async () => {
    const data = await analyze({ root: fixturePath('vue-app'), git: false, includeSource: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-report-'));
    const out = path.join(dir, '.code-visualizer', 'report.html');
    const result = writeReport(data, out, { json: true, templatePath: template });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.code-visualizer', '.gitignore'), 'utf8')).toContain('*');
    expect(result.jsonPath && JSON.parse(fs.readFileSync(result.jsonPath, 'utf8')).project.name).toBe('vue-app');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scopes', () => {
  it('--file keeps the focus file, its dependencies and dependents', async () => {
    const root = fixturePath('react-vite-ts');
    const data = await analyze({ root, file: path.join(root, 'src/components/Card.tsx'), git: false, includeSource: false });
    expect(data.scope).toEqual({ type: 'file', path: 'src/components/Card.tsx' });
    const roles = new Map(data.files.map((f) => [f.id, f.scope]));
    expect(roles.get('src/components/Card.tsx')).toBe('focus');
    expect([...roles.values()]).toContain('dependent');
    expect(data.files.length).toBeLessThan(28);
  });

  it('--directory keeps members and marks outside neighbours as context', async () => {
    const root = fixturePath('react-vite-ts');
    const data = await analyze({ root, directory: path.join(root, 'src/components'), git: false, includeSource: false });
    const members = data.files.filter((f) => f.scope === 'member');
    expect(members.length).toBeGreaterThan(3);
    expect(members.every((f) => f.id.startsWith('src/components/'))).toBe(true);
    expect(data.files.some((f) => f.scope === 'context')).toBe(true);
    expect(data.stats.files).toBe(members.length);
  });

  it('rejects paths outside of the project', async () => {
    await expect(analyze({ root: fixturePath('react-vite-ts'), file: '/etc/hosts', git: false })).rejects.toThrow(/outside of the project root/);
  });
});
