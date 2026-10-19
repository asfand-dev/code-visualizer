import { describe, expect, it } from 'vitest';
import { parseYaml, yamlLine } from '../src/shared/yaml.js';

const read = (source: string): unknown => {
  const result = parseYaml(source);
  expect(result.error).toBeUndefined();
  return result.value;
};

describe('parseYaml scalars', () => {
  it('types plain scalars like YAML 1.2', () => {
    expect(read('a: 1\nb: 1.5\nc: true\nd: False\ne: null\nf: ~\ng: text\nh: yes\ni: on\nj: 0123abc\nk:\n')).toEqual({
      a: 1,
      b: 1.5,
      c: true,
      d: false,
      e: null,
      f: null,
      g: 'text',
      h: 'yes',
      i: 'on',
      j: '0123abc',
      k: null,
    });
  });

  it('keeps integers that are too large for a number as text', () => {
    expect(read('id: 12345678901234567890')).toEqual({ id: '12345678901234567890' });
  });

  it('reads quoted strings with escapes', () => {
    expect(read('a: "tab\\there"\nb: \'it\'\'s\'\nc: "x: y # not a comment"\nd: "\\u0041\\x42"\ne: "C:\\Users\\me"')).toEqual({
      a: 'tab\there',
      b: "it's",
      c: 'x: y # not a comment',
      d: 'AB',
      e: 'C:\\Users\\me',
    });
  });

  it('keeps `!cancelled()` and expressions as text', () => {
    expect(read('if: !cancelled()\nname: ${{ matrix.os }}-build')).toEqual({ if: '!cancelled()', name: '${{ matrix.os }}-build' });
  });

  it('joins a plain scalar that continues on indented lines', () => {
    expect(read('desc: one\n  two\n  three\nnext: x')).toEqual({ desc: 'one two three', next: 'x' });
  });

  it('reads a quoted scalar over several lines', () => {
    expect(read('msg: "first\n  second"\nnext: 1')).toEqual({ msg: 'first second', next: 1 });
  });
});

describe('parseYaml comments', () => {
  it('cuts comments after whitespace but not inside URLs or quotes', () => {
    expect(read('a: 1 # one\nb: http://x.dev/#frag\nc: "q # q" # trailing\n# whole line\nd: 2')).toEqual({ a: 1, b: 'http://x.dev/#frag', c: 'q # q', d: 2 });
  });

  it('treats a quote inside plain text as text, so a later # still starts a comment', () => {
    expect(read('run: echo "a # b"')).toEqual({ run: 'echo "a' });
  });
});

describe('parseYaml block scalars', () => {
  it('keeps lines, # characters and blank lines of a literal block', () => {
    const doc = read('run: |\n  echo one\n  # not a comment\n\n  echo two\nafter: 1\n');
    expect(doc).toEqual({ run: 'echo one\n# not a comment\n\necho two\n', after: 1 });
  });

  it('applies the chomping indicators', () => {
    expect(read('a: |-\n  x\n  y\n\nb: |+\n  z\n\nc: |\n  w\n')).toEqual({ a: 'x\ny', b: 'z\n\n', c: 'w\n' });
  });

  it('folds a folded block into lines', () => {
    expect(read('text: >\n  one\n  two\n\n  three\n')).toEqual({ text: 'one two\nthree\n' });
  });

  it('reads a block scalar as a list item', () => {
    expect(read('- |\n  a\n  b\n- next')).toEqual(['a\nb\n', 'next']);
  });

  it('keeps deeper indentation inside the block', () => {
    expect(read('script: |\n  if x; then\n    echo y\n  fi\n')).toEqual({ script: 'if x; then\n  echo y\nfi\n' });
  });

  it('reads an empty block as an empty string', () => {
    expect(read('a: |\nb: 1')).toEqual({ a: '', b: 1 });
  });
});

describe('parseYaml collections', () => {
  it('reads nested mappings and lists', () => {
    expect(read('a:\n  b:\n    - 1\n    - two\n  c: x\n')).toEqual({ a: { b: [1, 'two'], c: 'x' } });
  });

  it('reads a list at the same indentation as its key', () => {
    expect(read('steps:\n- run: a\n  name: A\n- uses: b\nnext: 1')).toEqual({ steps: [{ run: 'a', name: 'A' }, { uses: 'b' }], next: 1 });
  });

  it('reads items that begin after the dash, including nested dashes', () => {
    expect(read('- name: x\n  with:\n    k: v\n-   other: y\n- - a\n  - b\n')).toEqual([{ name: 'x', with: { k: 'v' } }, { other: 'y' }, ['a', 'b']]);
  });

  it('reads a null item and an empty list item value on the next line', () => {
    expect(read('-\n  a: 1\n-\n')).toEqual([{ a: 1 }, null]);
  });

  it('reads flow lists and mappings, also over several lines', () => {
    expect(read('os: [ubuntu-latest, "windows latest", 3]\nopts: {a: 1, b: [x, y], c}\nmulti: [\n  one,\n  two # cmt\n]\n')).toEqual({
      os: ['ubuntu-latest', 'windows latest', 3],
      opts: { a: 1, b: ['x', 'y'], c: null },
      multi: ['one', 'two'],
    });
  });

  it('keeps ${{ }} expressions together inside flow lists', () => {
    expect(read('runs-on: [self-hosted, ${{ matrix.os }}]')).toEqual({ 'runs-on': ['self-hosted', '${{ matrix.os }}'] });
  });

  it('reads quoted and special keys', () => {
    expect(read('"a b": 1\n\'c: d\': 2\non: push\n20: x\n')).toEqual({ 'a b': 1, 'c: d': 2, on: 'push', '20': 'x' });
  });

  it('does not let a key named __proto__ change the prototype', () => {
    const doc = read('__proto__:\n  polluted: true\nok: 1') as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['__proto__', 'ok']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('parseYaml anchors', () => {
  it('resolves aliases and merge keys, explicit keys winning', () => {
    const doc = read('base: &base\n  a: 1\n  b: 2\nuse:\n  <<: *base\n  b: 3\nlist: &l [x]\nagain: *l\n');
    expect(doc).toEqual({ base: { a: 1, b: 2 }, use: { a: 1, b: 3 }, list: ['x'], again: ['x'] });
  });

  it('gives each alias its own copy', () => {
    const doc = read('a: &a\n  k: 1\nb: *a\n') as { a: { k: number }; b: { k: number } };
    doc.b.k = 2;
    expect(doc.a.k).toBe(1);
  });
});

describe('parseYaml documents', () => {
  it('returns null for an empty document and skips the start marker', () => {
    expect(read('')).toBeNull();
    expect(read('# only a comment\n')).toBeNull();
    expect(read('---\na: 1\n')).toEqual({ a: 1 });
  });

  it('reads only the first document', () => {
    expect(read('a: 1\n---\nb: 2\n')).toEqual({ a: 1 });
  });

  it('accepts Windows line endings and a byte order mark', () => {
    expect(read('\uFEFFa: 1\r\nb:\r\n  - x\r\n')).toEqual({ a: 1, b: ['x'] });
  });

  it('reads a top-level scalar and a top-level list', () => {
    expect(read('just text')).toBe('just text');
    expect(read('- a\n- b')).toEqual(['a', 'b']);
  });
});

describe('parseYaml lines', () => {
  it('records the line of keys and list items', () => {
    const result = parseYaml('name: CI\njobs:\n  build:\n    steps:\n      - run: a\n      - uses: b\n');
    expect(yamlLine(result, 'name')).toBe(1);
    expect(yamlLine(result, 'jobs', 'build')).toBe(3);
    expect(yamlLine(result, 'jobs', 'build', 'steps', 0)).toBe(5);
    expect(yamlLine(result, 'jobs', 'build', 'steps', 1, 'uses')).toBe(6);
    expect(yamlLine(result, 'jobs', 'missing')).toBeUndefined();
  });
});

describe('parseYaml errors', () => {
  it('reports tabs used for indentation with the line', () => {
    const result = parseYaml('a:\n\tb: 1\n');
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ line: 2, message: expect.stringContaining('Tabs') });
  });

  it('reports bad indentation', () => {
    expect(parseYaml('a: 1\n  b: 2\n').error).toBeDefined();
    expect(parseYaml('a:\n    b: 1\n  c: 2\n').error?.line).toBe(3);
  });

  it('reports an unterminated quote, flow collection and block header', () => {
    expect(parseYaml('a: "open\n').error?.message).toContain('quoted');
    expect(parseYaml('a: [1, 2\n').error?.message).toContain('flow');
    expect(parseYaml('a: |zz\n  x\n').error?.message).toContain('block scalar');
  });

  it('reports text that is neither a key nor an item', () => {
    expect(parseYaml('a: 1\njust words\n').error?.line).toBe(2);
    expect(parseYaml('a: 1\n- b\n').error?.message).toContain('list item');
  });

  it('rejects a document nested too deeply instead of overflowing the stack', () => {
    const deep = Array.from({ length: 200 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
    expect(parseYaml(deep).error).toBeDefined();
  });
});

describe('parseYaml GitHub workflow', () => {
  const workflow = `# CI
name: CI
on:
  push:
    branches: [main]
    paths-ignore:
      - '**.md'
  pull_request:
  schedule:
    - cron: '0 3 * * 1'
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  test:
    runs-on: \${{ matrix.os }}
    needs: [lint]
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 22]
        include:
          - os: macos-latest
            node: 22
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - name: Test
        if: \${{ always() }}
        run: |
          npm ci
          npm test -- --coverage # coverage
`;

  it('reads the structure and the lines', () => {
    const result = parseYaml(workflow);
    expect(result.error).toBeUndefined();
    const doc = result.value as { on: Record<string, unknown>; jobs: { test: { steps: { run?: string }[]; strategy: { matrix: { include: unknown[] } } } } };
    expect(doc.on.push).toEqual({ branches: ['main'], 'paths-ignore': ['**.md'] });
    expect(doc.on.pull_request).toBeNull();
    expect(doc.jobs.test.strategy.matrix.include).toEqual([{ os: 'macos-latest', node: 22 }]);
    expect(doc.jobs.test.steps[2].run).toBe('npm ci\nnpm test -- --coverage # coverage\n');
    expect(yamlLine(result, 'jobs', 'test', 'steps', 2)).toBe(33);
  });
});
