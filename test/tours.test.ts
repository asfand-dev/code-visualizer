import { afterAll, describe, expect, it } from 'vitest';
import { loadTours, toCodeTour } from '../src/analyzer/tours.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

describe('toCodeTour / loadTours', () => {
  const tour = {
    title: 'Getting started',
    description: 'First steps in the codebase',
    steps: [
      { title: 'Entry', description: 'The app starts here.', file: 'src/main.tsx', line: 3 },
      { description: 'All reusable components.', directory: 'src/components' },
    ],
  };

  it('writes CodeTour JSON', () => {
    const text = toCodeTour(tour);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ $schema: 'https://aka.ms/codetour-schema', ...tour });
  });

  it('round-trips a tour through a .tours/*.tour file', () => {
    const root = makeTempDir('cv-tours-');
    writeFile(root, '.tours/getting-started.tour', toCodeTour(tour));
    expect(loadTours(root)).toEqual([{ ...tour, source: '.tours/getting-started.tour' }]);
  });

  it('reads .tours, .vscode/tours and .github/tours, and skips files that are not usable tours', () => {
    const root = makeTempDir('cv-tours-');
    writeFile(root, '.tours/a.tour', toCodeTour({ title: 'A', steps: [{ description: 'a' }] }));
    writeFile(root, '.vscode/tours/untitled.tour', JSON.stringify({ steps: [{ description: 'no title' }] }));
    writeFile(root, '.github/tours/c.tour', toCodeTour({ title: 'C', steps: [{ description: 'c', file: 'x.ts' }] }));
    writeFile(root, '.tours/empty.tour', JSON.stringify({ title: 'Empty', steps: [] }));
    writeFile(root, '.tours/broken.tour', '{ this is not json');
    writeFile(root, '.tours/notes.md', '# not a tour');
    const tours = loadTours(root);
    expect(tours.map((t) => [t.source, t.title]).sort()).toEqual([
      ['.github/tours/c.tour', 'C'],
      ['.tours/a.tour', 'A'],
      ['.vscode/tours/untitled.tour', 'untitled'],
    ]);
  });

  it('normalizes steps written by VS Code CodeTour (./ paths, selections, missing text) and caps sizes', () => {
    const root = makeTempDir('cv-tours-');
    const steps = [
      { file: './src/app.ts', selection: { start: { line: 7, character: 1 }, end: { line: 9, character: 1 } } },
      { title: 'Long', description: 'x'.repeat(5000), file: 'src/b.ts', line: 2, selection: { start: { line: 40 } } },
      ...Array.from({ length: 120 }, (_, i) => ({ description: `step ${i}` })),
    ];
    writeFile(root, '.tours/raw.tour', JSON.stringify({ title: 'Raw', steps }));
    const [loaded] = loadTours(root);
    expect(loaded.steps).toHaveLength(100);
    expect(loaded.steps[0]).toEqual({ title: undefined, description: '', file: 'src/app.ts', line: 7, directory: undefined });
    expect(loaded.steps[1].description).toHaveLength(4000);
    expect(loaded.steps[1].line).toBe(2); // an explicit line wins over the selection
  });

  it('returns at most 50 tours and nothing for projects without tours', () => {
    const root = makeTempDir('cv-tours-');
    expect(loadTours(root)).toEqual([]);
    for (let i = 0; i < 60; i++) writeFile(root, `.tours/t${String(i).padStart(2, '0')}.tour`, toCodeTour({ title: `T${i}`, steps: [{ description: 'x' }] }));
    expect(loadTours(root)).toHaveLength(50);
  });
});
