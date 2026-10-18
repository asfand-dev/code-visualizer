import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateRules, loadConfig, normalizeConfig, type CodeVisualizerConfig } from '../src/analyzer/config.js';
import { analyze } from '../src/analyzer/index.js';
import type { DependencyEdge } from '../src/shared/types.js';
import { fixtureDir, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

function edge(source: string, target: string, overrides: Partial<DependencyEdge> = {}): DependencyEdge {
  return { source, target, kind: 'import', typeOnly: false, names: ['x'], line: 3, specifier: `./${target}`, ...overrides };
}

const edges: DependencyEdge[] = [
  edge('src/ui/Button.tsx', 'src/db/client.ts', { line: 7 }),
  edge('src/ui/List.tsx', 'src/db/types.ts', { typeOnly: true }),
  edge('src/ui/Card.tsx', 'src/db/schema.ts', { typeOnly: true, line: 2 }),
  edge('src/ui/Button.tsx', 'src/shared/format.ts'),
  edge('src/api/users.ts', 'src/db/client.ts'),
];

describe('evaluateRules: forbidden dependencies', () => {
  it('flags imports from `from` files to `to` files with defaults for name and severity', () => {
    const v = evaluateRules({ rules: [{ from: 'src/ui/**', to: 'src/db/**' }] }, edges);
    expect(v).toEqual([
      { rule: 'rule-1', severity: 'error', source: 'src/ui/Button.tsx', target: 'src/db/client.ts', line: 7, message: undefined },
      { rule: 'rule-1', severity: 'error', source: 'src/ui/List.tsx', target: 'src/db/types.ts', line: 3, message: undefined },
      { rule: 'rule-1', severity: 'error', source: 'src/ui/Card.tsx', target: 'src/db/schema.ts', line: 2, message: undefined },
    ]);
  });

  it('honours `allow`, `severity`, `message`, `name` and `includeTypes: false`', () => {
    const config: CodeVisualizerConfig = {
      rules: [
        { name: 'ui-no-db', from: 'src/ui/**', to: 'src/db/**', allow: 'src/db/types.ts', severity: 'warn', message: 'UI must go through the API', includeTypes: false },
      ],
    };
    expect(evaluateRules(config, edges)).toEqual([
      { rule: 'ui-no-db', severity: 'warn', source: 'src/ui/Button.tsx', target: 'src/db/client.ts', line: 7, message: 'UI must go through the API' },
    ]);
  });

  it('accepts lists of globs, "./" prefixes and several rules', () => {
    const config: CodeVisualizerConfig = {
      rules: [
        { name: 'a', from: ['./src/ui/Button.tsx', './src/api/**'], to: ['src/db/client.ts'] },
        { name: 'b', from: 'src/ui/**', to: 'src/shared/**', allow: ['src/shared/format.ts'] },
      ],
    };
    expect(evaluateRules(config, edges).map((v) => `${v.rule}:${v.source}->${v.target}`)).toEqual(['a:src/ui/Button.tsx->src/db/client.ts', 'a:src/api/users.ts->src/db/client.ts']);
  });

  it('ignores rules without `from` or `to` and configs without rules', () => {
    expect(evaluateRules({ rules: [{ from: 'src/**', to: [] }, { from: '', to: 'src/**' }] }, edges)).toEqual([]);
    expect(evaluateRules({}, edges)).toEqual([]);
  });
});

describe('evaluateRules: layers', () => {
  const layered: DependencyEdge[] = [
    edge('src/app/main.ts', 'src/features/cart/Cart.ts'), // down: fine
    edge('src/features/cart/Cart.ts', 'src/shared/money.ts'), // down: fine
    edge('src/features/cart/Cart.ts', 'src/features/user/User.ts'), // same layer: fine
    edge('src/shared/money.ts', 'src/features/cart/Cart.ts', { line: 9 }), // up: violation
    edge('src/lib/http.ts', 'src/app/main.ts', { line: 4 }), // up two layers: violation
    edge('scripts/seed.ts', 'src/app/main.ts'), // outside any layer: ignored
  ];
  const config: CodeVisualizerConfig = { layers: ['src/app/**', 'src/features/**', ['src/shared/**', 'src/lib/**']] };

  it('reports lower layers that import higher ones', () => {
    expect(evaluateRules(config, layered)).toEqual([
      {
        rule: 'layers',
        severity: 'error',
        source: 'src/shared/money.ts',
        target: 'src/features/cart/Cart.ts',
        line: 9,
        message: '“src/shared/**, src/lib/**” must not depend on the higher layer “src/features/**”',
      },
      {
        rule: 'layers',
        severity: 'error',
        source: 'src/lib/http.ts',
        target: 'src/app/main.ts',
        line: 4,
        message: '“src/shared/**, src/lib/**” must not depend on the higher layer “src/app/**”',
      },
    ]);
  });

  it('combines rule and layer violations', () => {
    const v = evaluateRules({ ...config, rules: [{ name: 'no-cart-in-app', from: 'src/app/**', to: 'src/features/cart/**' }] }, layered);
    expect(v.map((x) => x.rule).sort()).toEqual(['layers', 'layers', 'no-cart-in-app']);
  });
});

describe('loadConfig', () => {
  const pkg = (extra: object = {}) => JSON.stringify({ name: 'x', ...extra });

  it('prefers code-visualizer.config.json, then .code-visualizerrc.json, .code-visualizerrc and package.json', () => {
    const root = makeTempDir('cv-config-');
    writeFile(root, 'package.json', pkg({ codeVisualizer: { base: 'from-package' } }));
    expect(loadConfig(root)).toEqual({ file: 'package.json#codeVisualizer', config: { base: 'from-package' } });
    writeFile(root, '.code-visualizerrc', '// comments and trailing commas are fine\n{ "base": "from-rc", }\n');
    expect(loadConfig(root)).toEqual({ file: '.code-visualizerrc', config: { base: 'from-rc' } });
    writeFile(root, '.code-visualizerrc.json', '{ "base": "from-rc-json" }');
    expect(loadConfig(root)).toEqual({ file: '.code-visualizerrc.json', config: { base: 'from-rc-json' } });
    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ base: 'main', rules: [{ from: 'a/**', to: 'b/**' }], layers: ['a/**', 'b/**'], check: { maxCycles: 0 } }));
    expect(loadConfig(root)).toEqual({
      file: 'code-visualizer.config.json',
      config: { base: 'main', rules: [{ from: 'a/**', to: 'b/**' }], layers: ['a/**', 'b/**'], check: { maxCycles: 0 } },
    });
  });

  it('returns an empty config when there is none', () => {
    const root = makeTempDir('cv-config-');
    expect(loadConfig(root)).toEqual({ config: {} });
    writeFile(root, 'package.json', pkg());
    expect(loadConfig(root)).toEqual({ config: {} });
  });

  it('reports syntax errors with file, line and column (and does not fall back to another file)', () => {
    const root = makeTempDir('cv-config-');
    writeFile(root, 'code-visualizer.config.json', '{\n  "rules": [\n    { "from": "src/a.ts" "to": "src/b.ts" }\n  ]\n}\n');
    writeFile(root, '.code-visualizerrc.json', '{ "base": "main" }');
    expect(loadConfig(root)).toEqual({ file: 'code-visualizer.config.json', config: {}, error: "code-visualizer.config.json:3:26: ',' expected." });
  });

  it('requires the configuration to be an object', () => {
    const root = makeTempDir('cv-config-');
    writeFile(root, 'code-visualizer.config.json', '[{ "from": "a/**", "to": "b/**" }]');
    expect(loadConfig(root)).toEqual({ file: 'code-visualizer.config.json', config: {}, error: 'code-visualizer.config.json must contain a JSON object.' });
    const pkgRoot = makeTempDir('cv-config-');
    writeFile(pkgRoot, 'package.json', pkg({ codeVisualizer: ['a/**'] }));
    expect(loadConfig(pkgRoot)).toEqual({ file: 'package.json#codeVisualizer', config: {}, error: '"codeVisualizer" in package.json must be an object.' });
  });

  it('accepts comments, trailing commas and an empty file without an error', () => {
    const root = makeTempDir('cv-config-');
    writeFile(root, '.code-visualizerrc', '/* layers */\n{ "layers": ["src/app/**", "src/lib/**",], }\n');
    expect(loadConfig(root)).toEqual({ file: '.code-visualizerrc', config: { layers: ['src/app/**', 'src/lib/**'] } });
    writeFile(root, 'code-visualizer.config.json', '');
    expect(loadConfig(root)).toEqual({ file: 'code-visualizer.config.json', config: {} });
  });

  it('makes analyze() warn about an invalid config and ignore its rules', async () => {
    const root = makeTempDir('cv-config-');
    writeFile(root, 'package.json', pkg());
    writeFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    writeFile(root, 'src/b.ts', 'export const b = 1;\n');
    writeFile(root, 'code-visualizer.config.json', '{ "rules": [{ "from": "src/a.ts", "to": "src/b.ts" }] ');
    const data = await analyze({ root, git: false, includeSource: false, history: false });
    expect(data.config).toEqual({ file: 'code-visualizer.config.json', rules: 0, error: expect.stringMatching(/^code-visualizer\.config\.json:1:\d+: /) });
    expect(data.warnings).toContain(`Ignored the configuration — ${data.config!.error}`);
    expect(data.insights.ruleViolations).toEqual([]);
    expect(data.files).toHaveLength(2);
  });

  // The config is hand-written JSON, so a single value where a list is expected is an easy mistake.
  // Either accept it or reject it with an error that names the key — but never crash or drop every file.
  it.each([
    ['exclude', { exclude: 'dist/**' }],
    ['rules', { rules: { from: 'src/a.ts', to: 'src/b.ts' } }],
    ['layers', { layers: 'src/**' }],
  ])('handles a single value instead of a list for "%s"', async (key, config) => {
    const root = makeTempDir('cv-config-');
    writeFile(root, 'package.json', pkg());
    writeFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    writeFile(root, 'src/b.ts', 'export const b = 1;\n');
    writeFile(root, 'code-visualizer.config.json', JSON.stringify(config));
    const outcome = await analyze({ root, git: false, includeSource: false, history: false }).then(
      (data) => ({ files: data.files.length, error: undefined as string | undefined }),
      (error: Error) => ({ files: 0, error: `${error.constructor.name}: ${error.message}` }),
    );
    const deliberateError = outcome.error !== undefined && !/^(TypeError|ReferenceError|RangeError)\b/.test(outcome.error) && outcome.error.includes(key);
    expect(outcome.files === 2 || deliberateError, JSON.stringify(outcome)).toBe(true);
  });
});

describe('normalizeConfig', () => {
  it('accepts single values where lists are expected', () => {
    expect(normalizeConfig({ exclude: 'dist/**', rules: { from: 'a/**', to: 'b/**' }, layers: 'src/**' }).config).toEqual({
      exclude: ['dist/**'],
      rules: [{ from: 'a/**', to: 'b/**' }],
      layers: ['src/**'],
    });
  });

  it.each([
    [{ exclude: 42 }, '"exclude"'],
    [{ base: ['main'] }, '"base"'],
    [{ rules: ['src/**'] }, 'rules[0]'],
    [{ rules: [{ from: 'a/**' }] }, 'rules[0]'],
    [{ rules: [{ from: 'a/**', to: 'b/**', severity: 'fatal' }] }, 'rules[0].severity'],
    [{ layers: [1, 2] }, '"layers"'],
    [{ check: { maxCycles: 'zero' } }, 'check.maxCycles'],
    [{ check: { allowRuleViolations: 1 } }, 'check.allowRuleViolations'],
  ])('rejects %j with an error that names %s', (raw, key) => {
    const result = normalizeConfig(raw as Record<string, unknown>);
    expect(result.config).toEqual({});
    expect(result.error).toContain(key);
  });
});

describe('fixture config files are valid', () => {
  it('fullstack-next ships a parseable config', () => {
    const file = path.join(fixtureDir('fullstack-next'), 'code-visualizer.config.json');
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });
});
