/**
 * Release fixes for the warm engine: what-ifs detect copy-paste clones only when the comparison needs
 * them, and a live guard that starts on work that already breaks something reports it open at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEngine, type Engine } from '../src/server/engine.js';
import { commitAll, copyFixture, daysAgo, hasGit, initRepo, isolateGit, removeTempDirs, writeFile } from './companion-helpers.js';

/** Calls of `projectClones`: the clone module is wrapped so the engine's analyses can be counted. */
const detections = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/analyzer/clones.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/analyzer/clones.js')>();
  return {
    ...actual,
    projectClones: (...args: Parameters<typeof actual.projectClones>) => {
      detections.count++;
      return actual.projectClones(...args);
    },
  };
});

afterAll(removeTempDirs);

const ANALYSIS = { git: false, history: false, includeSource: false } as const;
const engines: Engine[] = [];
afterAll(() => engines.forEach((e) => e.close()));

describe('Engine.whatIf and clone detection', () => {
  it('skips projectClones unless a clone gate is configured or the caller asks', async () => {
    const root = copyFixture('react-vite-ts', 'cv-whatif-');
    const engine = createEngine({ root, options: ANALYSIS, watch: false });
    engines.push(engine);
    const current = await engine.current();
    expect(current.insights.clones).toEqual([]);
    const file = 'src/utils/math.ts';
    const text = `${fs.readFileSync(path.join(root, file), 'utf8')}\nexport const EXTRA = 1;\n`;

    let before = detections.count;
    const plain = await engine.whatIf(file, text);
    expect(detections.count).toBe(before);
    expect(plain.insights.clones).toBeUndefined();
    expect(plain.health.categories.map((c) => c.id)).not.toContain('duplication');

    // The post-edit radar asks for them (copies an agent pasted are findings).
    before = detections.count;
    const asked = await engine.whatIf({ [file]: text }, undefined, { clones: true });
    expect(detections.count).toBe(before + 1);
    expect(asked.insights.clones).toEqual([]);

    // A clone gate in the configuration (check.maxNewClones) needs new clones in every comparison.
    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ check: { maxNewClones: 0 } }));
    before = detections.count;
    await engine.whatIf(file, text);
    expect(detections.count).toBe(before + 1);
  });
});

describe.skipIf(!hasGit)('Engine live guard on work that already breaks something', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => restoreEnv?.());

  it('reports a new cycle of the work as open after the first analysis, with no event', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'Initial import' });
    // Uncommitted work that closes a cycle (compared with HEAD).
    const client = path.join(repo, 'src/api/client.ts');
    fs.appendFileSync(client, "import { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n");
    const updates: { events?: unknown[] }[] = [];
    const engine = createEngine({ root: repo, options: { history: false, includeSource: false, compare: true }, events: true, watch: false });
    engines.push(engine);
    engine.onUpdate((u) => updates.push(u));
    const first = await engine.current();
    expect(first.changes?.delta?.newCycles).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].events).toBeUndefined();
    const feed = engine.feed();
    expect(feed.events).toEqual([]);
    expect(feed.open).toEqual([expect.objectContaining({ kind: 'cycle-added', severity: 'error', message: expect.stringMatching(/^new cycle: /) })]);
  });
});
