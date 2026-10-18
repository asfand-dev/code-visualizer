import fs from 'node:fs';
import path from 'node:path';
import type { CustomTour } from '../shared/types.js';
import { readJson, toPosix } from './project.js';

const TOUR_DIRS = ['.tours', '.vscode/tours', '.github/tours'];

interface CodeTourFile {
  title?: string;
  description?: string;
  steps?: { title?: string; description?: string; file?: string; line?: number; directory?: string; selection?: { start?: { line?: number } } }[];
}

/** Read VS Code CodeTour files so team tours show up in the report. */
export function loadTours(root: string): CustomTour[] {
  const tours: CustomTour[] = [];
  for (const dir of TOUR_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.tour')) continue;
      const data = readJson<CodeTourFile>(path.join(abs, name));
      if (!data?.steps?.length) continue;
      tours.push({
        title: data.title ?? name.replace(/\.tour$/, ''),
        description: data.description,
        source: toPosix(path.join(dir, name)),
        steps: data.steps.slice(0, 100).map((s) => ({
          title: s.title,
          description: (s.description ?? '').slice(0, 4000),
          file: s.file ? toPosix(s.file).replace(/^\.\//, '') : undefined,
          line: s.line ?? s.selection?.start?.line,
          directory: s.directory,
        })),
      });
    }
  }
  return tours.slice(0, 50);
}

/** Serialize a tour in CodeTour format (https://github.com/microsoft/codetour). */
export function toCodeTour(tour: Omit<CustomTour, 'source'>): string {
  return `${JSON.stringify(
    {
      $schema: 'https://aka.ms/codetour-schema',
      title: tour.title,
      description: tour.description,
      steps: tour.steps.map((s) => ({ title: s.title, description: s.description, file: s.file, line: s.line, directory: s.directory })),
    },
    null,
    2,
  )}\n`;
}
