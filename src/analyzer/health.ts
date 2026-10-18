import fs from 'node:fs';
import path from 'node:path';
import type { CloneFamily, FileInfo, HealthCategory, HealthReport, HistoryPoint, Improvement, Insights, Stats } from '../shared/types.js';
import { cloneSides, isSignificant, significantCopies, WHOLE_COPY } from '../shared/clones.js';
import { isTestableSource } from './tests.js';

interface HealthInput {
  files: FileInfo[];
  insights: Insights;
  stats: Stats;
  hasGit: boolean;
  testFiles: number;
  exportsTotal: number;
  /** Line coverage from a local coverage report (0..1), when there is one (test-intelligence). */
  lineCoverage?: number;
  // --- clone-radar ---
  /** Copy-paste clones: the share of source lines that are copies (0..1); absent when detection is off. */
  duplication?: { ratio: number; lines: number; families: number; minSimilarity?: number };
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/**
 * A 0–100 score with explainable categories. Weights favour things that slow teams down the most:
 * tangled modules, complex code and missing tests.
 */
/** ` from packages/a/package.json` (nothing for the root package.json). */
function inManifest(dir: string, word: string): string {
  return dir ? ` ${word} ${dir}/package.json` : '';
}

export function computeHealth(input: HealthInput): HealthReport {
  const { files, insights, stats } = input;
  const sources = files.filter(isTestableSource);
  const sourceCount = Math.max(1, sources.length);
  const categories: HealthCategory[] = [];
  const improvements: Improvement[] = [];
  // clone-radar: Duplication takes 10% of the score; the other categories keep their proportions.
  const scale = input.duplication ? 0.9 : 1;
  const weight = (w: number): number => Math.round(w * scale * 10) / 10;

  // Modularity: cycles and coupling.
  const inCycle = files.filter((f) => f.inCycle).length;
  const avgFanOut = sources.reduce((n, f) => n + f.metrics.fanOut, 0) / sourceCount;
  // Each category is a function of its inputs, so an improvement's gain is the real before/after difference.
  const modularityScore = (cycles: number, filesInCycles: number): number =>
    clamp(100 - Math.min(60, cycles * 10) - (filesInCycles / sourceCount) * 80 - (avgFanOut > 12 ? 10 : 0));
  const modularity = modularityScore(insights.cycles.length, inCycle);
  categories.push({
    id: 'modularity',
    label: 'Modularity',
    score: modularity,
    weight: weight(20),
    detail: insights.cycles.length ? `${insights.cycles.length} circular dependencies across ${inCycle} files` : 'No circular dependencies',
  });

  // Complexity.
  // A function is as complex as its worst part: its own code or its most complex inline callback.
  const fns = files
    .filter((f) => f.kind !== 'test')
    .flatMap((f) => f.symbols.filter((s) => (s.kind === 'function' || s.kind === 'component' || s.kind === 'hook') && s.complexity))
    .map((s) =>
      s.nested && s.nested.complexity > (s.complexity ?? 0)
        ? { id: s.id, name: `${s.name} › ${s.nested.name}`, complexity: s.nested.complexity }
        : { id: s.id, name: s.name, complexity: s.complexity ?? 0 },
    );
  const complexFns = fns.filter((s) => s.complexity > 15);
  const extreme = fns.filter((s) => s.complexity > 50).length;
  const complexityScore = (complex: number, extremeCount: number): number =>
    clamp(100 - (fns.length ? complex / fns.length : 0) * 250 - Math.min(20, extremeCount * 5));
  const complexity = complexityScore(complexFns.length, extreme);
  categories.push({
    id: 'complexity',
    label: 'Complexity',
    score: complexity,
    weight: weight(20),
    detail: fns.length ? `${complexFns.length} of ${fns.length} functions are complex (cyclomatic > 15)` : 'No functions analyzed',
  });

  // Size.
  const large = sources.filter((f) => f.loc > 500);
  const huge = large.filter((f) => f.loc > 1500).length;
  const sizeScore = (largeCount: number, hugeCount: number): number => clamp(100 - (largeCount / sourceCount) * 300 - Math.min(15, hugeCount * 5));
  const size = sizeScore(large.length, huge);
  categories.push({ id: 'size', label: 'File size', score: size, weight: weight(10), detail: large.length ? `${large.length} files are longer than 500 lines` : 'Files are small and focused' });

  // Dead code.
  const unused = insights.unusedExports.filter((u) => !u.typeOnly).length;
  const deadCodeScore = (unusedCount: number, orphanCount: number): number =>
    clamp(100 - (input.exportsTotal ? unusedCount / input.exportsTotal : 0) * 150 - (orphanCount / sourceCount) * 200);
  const deadCode = deadCodeScore(unused, insights.orphans.length);
  categories.push({
    id: 'dead-code',
    label: 'Dead code',
    score: deadCode,
    weight: weight(15),
    detail: `${unused} unused exports, ${insights.orphans.length} orphan files`,
  });

  // Dependency hygiene.
  const devInProduction = insights.devDependenciesInProduction ?? [];
  const deps = clamp(100 - insights.unusedDependencies.length * 8 - insights.missingDependencies.length * 12 - devInProduction.length * 8);
  categories.push({
    id: 'dependencies',
    label: 'Dependencies',
    score: deps,
    weight: weight(10),
    detail:
      `${insights.unusedDependencies.length} unused, ${insights.missingDependencies.length} missing from package.json` +
      (devInProduction.length ? `, ${devInProduction.length} devDependenc${devInProduction.length === 1 ? 'y' : 'ies'} used in production code` : ''),
  });

  // Tests: real line coverage when a coverage report exists (70%), import reach otherwise (and for the rest).
  // With a report the category is `coverage`: comparisons with an analysis without one (a base commit, a
  // what-if) treat a category only one side has as unchanged, so a report never reads as a health change.
  const coverage = input.lineCoverage;
  const testsId = coverage !== undefined ? 'coverage' : 'tests';
  const testsScore = (hasTests: boolean, reach: number): number =>
    !hasTests ? 0 : coverage !== undefined ? clamp(10 + 90 * (0.7 * coverage + 0.3 * reach)) : clamp(10 + reach * 90);
  const tests = testsScore(input.testFiles > 0, stats.testReach);
  const reachText = `${Math.round(stats.testReach * 100)}% of source files are reached by a test`;
  categories.push({
    id: testsId,
    label: coverage !== undefined ? 'Tests & coverage' : 'Test reach',
    score: tests,
    weight: weight(15),
    detail: !input.testFiles ? 'No test files found' : coverage !== undefined ? `${Math.round(coverage * 100)}% line coverage, ${reachText}` : reachText,
  });

  // Knowledge distribution (git only).
  const important = new Set(
    [...sources]
      .sort((a, b) => b.metrics.importance - a.metrics.importance)
      .slice(0, Math.max(5, Math.round(sources.length * 0.2)))
      .map((f) => f.id),
  );
  const knowledgeScore = (silos: number): number => clamp(100 - (important.size ? silos / important.size : 0) * 120);
  const importantSilos = insights.knowledgeSilos.filter((s) => important.has(s.file)).length;
  if (input.hasGit) {
    categories.push({
      id: 'knowledge',
      label: 'Knowledge spread',
      score: knowledgeScore(importantSilos),
      weight: weight(10),
      detail: insights.knowledgeSilos.length ? `${insights.knowledgeSilos.length} important files are known by only one person` : 'Knowledge is shared across the team',
    });
  }

  // --- clone-radar: Duplication — every 1% of copied source lines costs 4 points (25% copied scores 0) ---
  const dup = input.duplication;
  const duplicationScore = (ratio: number): number => clamp(100 - ratio * 400);
  if (dup) {
    const pct = Math.round(dup.ratio * 1000) / 10;
    categories.push({
      id: 'duplication',
      label: 'Duplication',
      score: duplicationScore(dup.ratio),
      weight: 10,
      detail: dup.lines ? `${pct}% of the source lines are copies (${dup.lines} lines in ${dup.families} clone ${dup.families === 1 ? 'family' : 'families'})` : 'No copy-paste clones',
    });
  }

  const totalWeight = categories.reduce((n, c) => n + c.weight, 0);
  const score = clamp(categories.reduce((n, c) => n + c.score * c.weight, 0) / totalWeight);
  const gainFor = (id: string, newScore: number): number => {
    const c = categories.find((x) => x.id === id);
    if (!c) return 0;
    return Math.round(((Math.min(100, newScore) - c.score) * c.weight) / totalWeight * 10) / 10;
  };

  if (insights.cycles.length) {
    const first = insights.cycles[0];
    improvements.push({
      id: 'cycles',
      title: `Break ${insights.cycles.length === 1 ? 'the circular dependency' : `${insights.cycles.length} circular dependencies`}`,
      detail: `Start with ${first.slice(0, 3).map((f) => f.split('/').pop()).join(' → ')}${first.length > 3 ? ' → …' : ''}`,
      gain: gainFor('modularity', modularityScore(0, 0)),
      files: first,
      view: 'insights',
    });
  }
  if (complexFns.length) {
    const top = [...complexFns].sort((a, b) => b.complexity - a.complexity).slice(0, 5);
    improvements.push({
      id: 'complexity',
      title: `Simplify the ${top.length} most complex functions`,
      detail: top.map((s) => `${s.name} (${s.complexity})`).join(', '),
      gain: gainFor('complexity', complexityScore(complexFns.length - top.length, extreme - top.filter((s) => s.complexity > 50).length)),
      files: [...new Set(top.map((s) => s.id.slice(0, s.id.indexOf('#'))))],
      view: 'insights',
    });
  }
  if (unused) {
    improvements.push({
      id: 'unused-exports',
      title: `Remove ${unused} unused exports`,
      detail: 'Exports that no other file imports are usually dead code',
      gain: gainFor('dead-code', deadCodeScore(0, insights.orphans.length)),
      files: [...new Set(insights.unusedExports.filter((u) => !u.typeOnly).map((u) => u.file))].slice(0, 20),
      view: 'insights',
    });
  }
  if (insights.orphans.length) {
    improvements.push({
      id: 'orphans',
      title: `Delete or wire up ${insights.orphans.length} orphan file${insights.orphans.length === 1 ? '' : 's'}`,
      detail: insights.orphans.slice(0, 3).join(', '),
      gain: gainFor('dead-code', deadCodeScore(unused, 0)),
      files: insights.orphans.slice(0, 20),
      view: 'insights',
    });
  }
  if (insights.unusedDependencies.length || insights.missingDependencies.length || devInProduction.length) {
    improvements.push({
      id: 'dependencies',
      title: 'Clean up package.json',
      detail: [
        // Name the package.json in monorepos / nested packages (the root one goes without saying).
        insights.unusedDependencies.length &&
          `remove ${(insights.unusedDeclarations ?? insights.unusedDependencies.map((name) => ({ name, manifest: '' })))
            .slice(0, 3)
            .map((u) => `${u.name}${inManifest(u.manifest, 'from')}`)
            .join(', ')}`,
        insights.missingDependencies.length &&
          `declare ${insights.missingDependencies
            .slice(0, 3)
            .map((m) => `${m.name}${m.manifests?.length === 1 ? inManifest(m.manifests[0], 'in') : ''}`)
            .join(', ')}`,
        devInProduction.length &&
          `move ${devInProduction
            .slice(0, 3)
            .map((d) => `${d.name}${d.declareIn !== undefined ? ` (of ${d.declareIn ? `${d.declareIn}/` : ''}package.json)` : ''}`)
            .join(', ')} to dependencies`,
      ]
        .filter(Boolean)
        .join('; '),
      gain: gainFor('dependencies', 100),
      view: 'packages',
    });
  }
  if (insights.untested.length) {
    const top = insights.untested.slice(0, 5);
    const newReach = Math.min(1, stats.testReach + top.length / sourceCount);
    improvements.push({
      id: 'tests',
      title: `Add tests for the ${top.length} most important untested files`,
      detail: top.map((f) => f.split('/').pop()).join(', '),
      gain: gainFor(testsId, testsScore(true, newReach)),
      files: top,
      view: 'insights',
    });
  }
  // --- clone-radar ---
  // The families the score counts (copies that are a real part of their declarations), most important first.
  const families = (insights.clones ?? []).filter((f) => isSignificant(f, dup?.minSimilarity));
  if (dup && dup.lines && families.length) {
    const top = families.slice(0, 3);
    // Merging a family removes all copies but one.
    const saved = top.reduce((n, f) => n + [...significantCopies(f, dup.minSimilarity)].slice(1).reduce((m, i) => m + f.fragments[i].end - f.fragments[i].start + 1, 0), 0);
    const perLine = dup.lines ? dup.ratio / dup.lines : 0;
    // "slugify exists 3 times" for whole copies; "a and b share a copied block" for parts of larger functions.
    const describe = (f: CloneFamily): string => {
      const { copy, original, similarity } = cloneSides(f);
      const names = [...new Set([copy, original].map((x) => x?.name).filter((x): x is string => !!x))];
      if (!names.length) return `a block in ${path.basename(f.fragments[0].file)} exists ${f.fragments.length === 2 ? 'twice' : `${f.fragments.length} times`}`;
      if (similarity >= WHOLE_COPY) return `${names[0]} exists ${f.fragments.length === 2 ? 'twice' : `${f.fragments.length} times`}`;
      return names.length === 2 ? `${names[0]} and ${names[1]} share a copied block` : `${names[0]} has a copied block`;
    };
    improvements.push({
      id: 'duplication',
      title: `Merge the ${top.length === 1 ? 'largest copy-paste clone' : `${top.length} most important copy-paste clones`}`,
      detail: top.map(describe).join('; '),
      gain: gainFor('duplication', duplicationScore(Math.max(0, dup.ratio - saved * perLine))),
      files: [...new Set(top.flatMap((f) => f.fragments.map((fr) => fr.file)))].slice(0, 20),
      view: 'insights',
    });
  }
  if (large.length) {
    const top = [...large].sort((a, b) => b.loc - a.loc).slice(0, 3);
    improvements.push({
      id: 'size',
      title: `Split ${top.length === 1 ? 'the largest file' : `the ${top.length} largest files`}`,
      detail: top.map((f) => `${f.name} (${f.loc} lines)`).join(', '),
      gain: gainFor('size', sizeScore(large.length - top.length, huge - top.filter((f) => f.loc > 1500).length)),
      files: top.map((f) => f.id),
      view: 'structure',
    });
  }
  if (insights.knowledgeSilos.length) {
    const top = insights.knowledgeSilos.slice(0, 3);
    improvements.push({
      id: 'knowledge',
      title: 'Spread knowledge of key files',
      detail: top.map((s) => `${s.file.split('/').pop()} (${Math.round(s.share * 100)}% ${s.author})`).join(', '),
      gain: gainFor('knowledge', knowledgeScore(importantSilos - top.filter((s) => important.has(s.file)).length)),
      files: top.map((s) => s.file),
      view: 'team',
    });
  }

  const grade: HealthReport['grade'] = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'E';
  return {
    score,
    grade,
    categories,
    improvements: improvements.filter((i) => i.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 8),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   History                                  */
/* -------------------------------------------------------------------------- */

export const HISTORY_FILE = 'history.json';

export function historyPath(root: string): string {
  return path.join(root, '.code-visualizer', HISTORY_FILE);
}

export function readHistory(root: string): HistoryPoint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath(root), 'utf8')) as { points?: HistoryPoint[] } | HistoryPoint[];
    const points = Array.isArray(parsed) ? parsed : parsed.points;
    return Array.isArray(points) ? points.filter((p) => typeof p?.date === 'number' && typeof p.score === 'number') : [];
  } catch {
    return [];
  }
}

/** Append the new point unless nothing meaningful changed since the last one. */
export function mergeHistory(points: HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  const last = points[points.length - 1];
  const same =
    last &&
    last.commit === point.commit &&
    !!last.dirty === !!point.dirty &&
    last.score === point.score &&
    last.files === point.files &&
    last.cycles === point.cycles &&
    point.date - last.date < 6 * 3600 * 1000;
  const next = same ? [...points.slice(0, -1), point] : [...points, point];
  return next.slice(-500);
}

/** Creates `.code-visualizer/` with its own `.gitignore`, so local state is never committed by accident. */
export function ensureStateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Generated by code-visualizer\n*\n');
}

export function writeHistory(root: string, points: HistoryPoint[]): void {
  const file = historyPath(root);
  ensureStateDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, points }, null, 0)}\n`);
}
