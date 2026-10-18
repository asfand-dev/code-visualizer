import path from 'node:path';
import ignore from 'ignore';
import { projectFiles, type ProjectFiles } from './readtext.js';

export interface CodeOwners {
  file: string;
  ownersOf(id: string): string[] | undefined;
}

const LOCATIONS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS', '.bitbucket/CODEOWNERS'];

/**
 * Parse a CODEOWNERS file (GitHub / GitLab syntax). The last matching rule wins.
 * `gitPrefix` is the analyzed root relative to the repository root (e.g. `apps/web/`);
 * `files` reads from a snapshot instead of the disk.
 */
export function loadCodeOwners(searchRoots: string[], gitPrefix = '', files: ProjectFiles = projectFiles('')): CodeOwners | undefined {
  for (const dir of searchRoots) {
    for (const rel of LOCATIONS) {
      const text = files.read(path.join(dir, rel));
      if (text === undefined) continue;
      const rules: { matcher: ReturnType<typeof ignore>; owners: string[] }[] = [];
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#') || /^\^?\[.*\]/.test(line)) continue; // comments, GitLab sections
        const [pattern, ...owners] = line.split(/\s+/);
        if (!pattern) continue;
        try {
          rules.push({ matcher: ignore().add(pattern), owners: owners.filter((o) => o.startsWith('@') || o.includes('@')) });
        } catch {
          // invalid pattern — skip it
        }
      }
      if (!rules.length) continue;
      const cache = new Map<string, string[] | undefined>();
      return {
        file: rel,
        ownersOf(id: string) {
          if (cache.has(id)) return cache.get(id);
          const full = `${gitPrefix}${id}`;
          let owners: string[] | undefined;
          for (const rule of rules) if (rule.matcher.ignores(full)) owners = rule.owners;
          const value = owners?.length ? owners : undefined;
          cache.set(id, value);
          return value;
        },
      };
    }
  }
  return undefined;
}
