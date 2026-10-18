import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useModel } from '../data/context';
import { plural } from '../lib/format';
import { selectFile, selectSymbol, setState, useStore } from '../state/store';
import { KindDot, SymbolIcon } from '../components/ui';
import type { FileInfo } from '../types';

interface Hit {
  line: number;
  text: string;
  ranges: [number, number][];
}

interface FileHits {
  file: FileInfo;
  hits: Hit[];
}

const MAX_HITS = 3000;

function buildRegex(query: string, opts: { regex: boolean; caseSensitive: boolean; word: boolean }): RegExp | string {
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.word) source = `\\b${source}\\b`;
  try {
    return new RegExp(source, opts.caseSensitive ? 'g' : 'gi');
  } catch (error) {
    return (error as Error).message;
  }
}

function pathMatcher(filter: string): (id: string) => boolean {
  const parts = filter
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return () => true;
  const tests = parts.map((p) => {
    const negate = p.startsWith('!');
    const raw = negate ? p.slice(1) : p;
    const re = new RegExp(raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.'), 'i');
    return { negate, re };
  });
  return (id) => {
    const positives = tests.filter((t) => !t.negate);
    if (tests.some((t) => t.negate && t.re.test(id))) return false;
    return !positives.length || positives.some((t) => t.re.test(id));
  };
}

function renderHit(hit: Hit): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  const text = hit.text;
  // Trim very long lines around the first match.
  let offset = 0;
  if (text.length > 220 && hit.ranges[0]) offset = Math.max(0, hit.ranges[0][0] - 60);
  const shown = text.slice(offset, offset + 220);
  hit.ranges.forEach(([a, b], i) => {
    const s = a - offset;
    const e = b - offset;
    if (e <= 0 || s >= shown.length) return;
    if (s > last) out.push(shown.slice(last, s));
    out.push(<mark key={i}>{shown.slice(Math.max(0, s), e)}</mark>);
    last = e;
  });
  if (last < shown.length) out.push(shown.slice(last));
  return (
    <>
      {offset > 0 && '…'}
      {out}
    </>
  );
}

export function SearchView() {
  const model = useModel();
  const query = useStore((s) => s.searchQuery);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [word, setWord] = useState(false);
  const [paths, setPaths] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(query);
  const deferredPaths = useDeferredValue(paths);

  useEffect(() => inputRef.current?.focus(), []);

  const result = useMemo(() => {
    const q = deferred;
    if (!q || (!regex && q.length < 2)) return undefined;
    const started = performance.now();
    const re = buildRegex(q, { regex, caseSensitive, word });
    if (typeof re === 'string') return { error: re };
    const include = pathMatcher(deferredPaths);
    const files: FileHits[] = [];
    let total = 0;
    let truncated = false;
    let skipped = 0;
    for (const file of model.files) {
      if (!include(file.id)) continue;
      if (file.source === undefined) {
        skipped++;
        continue;
      }
      const text = file.source;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      const hits: Hit[] = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && total < MAX_HITS; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        const ranges: [number, number][] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) && ranges.length < 20) {
          ranges.push([m.index, m.index + Math.max(1, m[0].length)]);
          if (m[0].length === 0) re.lastIndex++;
        }
        if (ranges.length) {
          hits.push({ line: i + 1, text: line, ranges });
          total++;
        }
      }
      if (hits.length) files.push({ file, hits });
      if (total >= MAX_HITS) {
        truncated = true;
        break;
      }
    }
    files.sort((a, b) => b.file.metrics.importance - a.file.metrics.importance || a.file.id.localeCompare(b.file.id));
    // Symbols whose name matches, as shortcuts.
    const symbols = model.files
      .flatMap((f) => f.symbols.map((s) => ({ s, f })))
      .filter(({ s }) => {
        re.lastIndex = 0;
        return re.test(s.name);
      })
      .sort((a, b) => Number(b.s.exported) - Number(a.s.exported))
      .slice(0, 12);
    return { files, total, truncated, skipped, ms: Math.round(performance.now() - started), symbols };
  }, [deferred, regex, caseSensitive, word, deferredPaths, model]);

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar" style={{ gap: 10 }}>
        <div className="input-icon" style={{ flex: 1, minWidth: 220, maxWidth: 640 }}>
          <Search size={15} />
          <input
            ref={inputRef}
            className="input"
            style={{ height: 36, fontSize: 14 }}
            value={query}
            onChange={(e) => setState({ searchQuery: e.target.value })}
            placeholder="Search the code — text, error messages, TODOs, regex…"
            spellCheck={false}
          />
        </div>
        <button className={`toggle-btn${caseSensitive ? ' on' : ''}`} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case">
          Aa
        </button>
        <button className={`toggle-btn${word ? ' on' : ''}`} onClick={() => setWord(!word)} title="Whole word">
          ab
        </button>
        <button className={`toggle-btn${regex ? ' on' : ''}`} onClick={() => setRegex(!regex)} title="Regular expression">
          .*
        </button>
        <input className="input" style={{ width: 230 }} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="files: src/**, *.tsx, !**/*.test.*" spellCheck={false} title="Comma-separated globs; prefix with ! to exclude" />
        <span className="spacer" />
        {result && !('error' in result) && (
          <span className="small muted">
            {plural(result.total, 'match', 'matches')}
            {result.truncated ? '+' : ''} in {plural(result.files.length, 'file')} · {result.ms} ms
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!query && (
          <div className="empty">
            <div className="empty-icon">
              <Search size={24} />
            </div>
            <h3>Search across every file</h3>
            <p>Find where an error message comes from, every place an API is used, or all TODOs. Everything runs in your browser — nothing is uploaded.</p>
            <div className="tags" style={{ justifyContent: 'center', marginTop: 8 }}>
              {['TODO', 'useEffect(', 'process.env', 'console.log', 'fetch('].map((s) => (
                <button key={s} className="tag link" onClick={() => setState({ searchQuery: s })}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {result && 'error' in result && <div className="empty">Invalid regular expression: {result.error}</div>}
        {result && !('error' in result) && (
          <>
            {result.symbols.length > 0 && (
              <div style={{ padding: '10px 12px' }}>
                <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, marginBottom: 6 }}>
                  Matching declarations
                </div>
                <div className="tags">
                  {result.symbols.map(({ s, f }) => (
                    <button key={s.id} className="chip" onClick={() => selectSymbol(s.id)} title={`${f.id}:${s.line}`}>
                      <SymbolIcon kind={s.kind} />
                      <span className="mono">{s.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!result.files.length && <div className="empty">No matches for “{query}”.</div>}
            {result.files.map(({ file, hits }) => {
              const open = !collapsed.has(file.id);
              return (
                <div key={file.id}>
                  <div className="search-file" onClick={() => toggle(file.id)}>
                    {open ? <ChevronDown size={14} className="faint" /> : <ChevronRight size={14} className="faint" />}
                    <KindDot kind={file.kind} />
                    <span className="mono small" style={{ fontWeight: 600 }}>
                      {file.id}
                    </span>
                    <span className="badge">{hits.length}</span>
                  </div>
                  {open &&
                    hits.slice(0, 200).map((h) => (
                      <div key={h.line} className="search-hit" onClick={() => selectFile(file.id, h.line)}>
                        <span className="ln">{h.line}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{renderHit(h)}</span>
                      </div>
                    ))}
                </div>
              );
            })}
            {result.skipped > 0 && <div className="tiny faint" style={{ padding: 14 }}>{plural(result.skipped, 'file')} not searched because their source is not embedded (large files or --no-source).</div>}
          </>
        )}
      </div>
    </div>
  );
}
