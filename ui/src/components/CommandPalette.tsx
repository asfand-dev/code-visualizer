import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ClipboardCopy, CornerDownLeft, Folder, Moon, Package, Pin, Search, TextSearch } from 'lucide-react';
import { prSummaryMarkdown, projectSummaryMarkdown } from '../../../src/shared/markdown';
import { copyText } from '../lib/download';
import { plural } from '../lib/format';
import { describeKey } from '../lib/keys';
import { usePersonal } from '../state/personal';
import { useModel } from '../data/context';
import { KIND_META, METHOD_COLORS } from '../lib/colors';
import { searchCode, setState, toast, toggleTheme, type Selection, type ViewId } from '../state/store';
import { useNavEntries } from './Sidebar';
import { VIEW_ICONS } from './icons';
import { KindDot, SymbolIcon } from './ui';
import type { FileKind, SymbolKind } from '../types';

type ItemType = 'pinned' | 'view' | 'action' | 'file' | 'symbol' | 'route' | 'package' | 'folder' | 'text';

interface Item {
  type: ItemType;
  key: string;
  label: string;
  sub?: string;
  search: string;
  weight: number;
  kind?: FileKind;
  symbolKind?: SymbolKind;
  method?: string;
  run: () => void;
}

const GROUP_LABELS: Record<ItemType, string> = {
  pinned: 'Pinned',
  text: 'Code search',
  view: 'Views',
  action: 'Actions',
  file: 'Files',
  symbol: 'Symbols',
  route: 'Routes',
  package: 'Packages',
  folder: 'Folders',
};

const GROUP_ORDER: ItemType[] = ['pinned', 'view', 'action', 'file', 'symbol', 'route', 'folder', 'package', 'text'];

/** Fuzzy score: substring matches win, then subsequence matches; returns matched indices for highlighting. */
function score(query: string, text: string): { score: number; hits: number[] } | undefined {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) {
    const boundary = idx === 0 || /[\s/._#:-]/.test(t[idx - 1]);
    return { score: 1000 - idx + (boundary ? 200 : 0) - t.length * 0.5, hits: Array.from({ length: q.length }, (_, i) => idx + i) };
  }
  const hits: number[] = [];
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return undefined;
    if (hits.length && found !== hits[hits.length - 1] + 1) gaps++;
    hits.push(found);
    ti = found + 1;
  }
  return { score: 500 - gaps * 30 - t.length * 0.5, hits };
}

function highlight(text: string, hits: number[]): ReactNode {
  if (!hits.length) return text;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) {
      if (buf) out.push(inMark ? <mark key={i}>{buf}</mark> : buf);
      buf = '';
      inMark = m;
    }
    buf += text[i];
  }
  if (buf) out.push(inMark ? <mark key="end">{buf}</mark> : buf);
  return out;
}

export function CommandPalette() {
  const model = useModel();
  const navEntries = useNavEntries();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pins = usePersonal((s) => s.pins);
  const close = (): void => setState({ paletteOpen: false });
  const choose = (selection: Selection): void => setState({ selection, paletteOpen: false, detailTab: undefined });

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const e of navEntries) {
      list.push({ type: 'view', key: `view:${e.id}`, label: `Go to ${e.label}`, search: `${e.label} ${e.id}`, weight: 5, run: () => setState({ view: e.id as ViewId, paletteOpen: false }) });
    }
    list.push({ type: 'action', key: 'action:theme', label: 'Toggle dark / light theme', search: 'theme dark light mode', weight: 3, run: () => (toggleTheme(), close()) });
    const copy = (text: string, what: string): void => {
      void copyText(text).then((ok) => ok && toast(`${what} copied to the clipboard`));
      close();
    };
    if (model.data.changes?.files.length) {
      list.push({ type: 'action', key: 'action:pr', label: 'Copy PR description for my changes', search: 'copy pr pull request description summary changes review', weight: 6, run: () => copy(prSummaryMarkdown(model.data), 'PR description') });
    }
    list.push({ type: 'action', key: 'action:summary', label: 'Copy project summary (for AI assistants / onboarding docs)', search: 'copy project summary ai agents claude markdown onboarding', weight: 4, run: () => copy(projectSummaryMarkdown(model.data), 'Project summary') });
    for (const f of model.files) {
      list.push({ type: 'file', key: `file:${f.id}`, label: f.name, sub: f.id, search: f.id, weight: 10 + f.metrics.importance * 50, kind: f.kind, run: () => choose({ type: 'file', id: f.id }) });
      for (const s of f.symbols) {
        list.push({
          type: 'symbol',
          key: `symbol:${s.id}`,
          label: s.name,
          sub: `${s.kind} · ${f.id}:${s.line}`,
          search: s.name,
          weight: s.exported ? 8 : 4,
          symbolKind: s.kind,
          run: () => choose({ type: 'symbol', id: s.id }),
        });
      }
    }
    for (const r of model.data.routes) {
      list.push({ type: 'route', key: `route:${r.id}`, label: r.path, sub: `${r.handler ?? ''} · ${r.file}`, search: `${r.method} ${r.path}`, weight: 9, method: r.method, run: () => choose({ type: 'route', id: r.id }) });
    }
    for (const p of model.data.packages) {
      if (p.builtin && !p.importedBy.length) continue;
      list.push({ type: 'package', key: `pkg:${p.name}`, label: p.name, sub: `${plural(p.importedBy.length, 'file')}${p.version ? ` · ${p.version}` : ''}`, search: p.name, weight: 6, run: () => choose({ type: 'package', id: p.name }) });
    }
    for (const folder of model.folderByPath.values()) {
      if (!folder.path) continue;
      list.push({ type: 'folder', key: `folder:${folder.path}`, label: `${folder.path}/`, sub: plural(folder.fileCount, 'file'), search: folder.path, weight: 7, run: () => choose({ type: 'folder', id: folder.path }) });
    }
    return list;
  }, [model, navEntries]);

  const pinnedItems = useMemo<Item[]>(
    () =>
      pins
        .map((key) => describeKey(model, key))
        .filter((p): p is NonNullable<typeof p> => !!p?.exists)
        .slice(0, 8)
        .map((p) => ({ type: 'pinned' as const, key: `pin:${p.key}`, label: p.label, sub: p.sub, search: p.label, weight: 20, run: () => (p.open(), close()) })),
    [pins, model],
  );

  const results = useMemo(() => {
    if (!query.trim()) {
      const pinnedFirst = pinnedItems;
      const views = items.filter((i) => i.type === 'view');
      const files = items
        .filter((i) => i.type === 'file')
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8);
      return [...pinnedFirst, ...views, ...files].map((item) => ({ item, hits: [] as number[] }));
    }
    const q = query.trim();
    const scored: { item: Item; hits: number[]; s: number }[] = [];
    for (const item of items) {
      const res = score(q, item.search);
      if (!res) continue;
      const labelHits = item.type === 'file' ? (score(q, item.label)?.hits ?? []) : res.hits;
      scored.push({ item, hits: item.search === item.label ? res.hits : labelHits, s: res.score + item.weight });
    }
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, 80);
    // Groups are ordered by their best match so the strongest hit is always first.
    const best = new Map<ItemType, number>();
    for (const r of top) if (!best.has(r.item.type)) best.set(r.item.type, r.s);
    const groups = [...GROUP_ORDER].filter((g) => best.has(g)).sort((a, b) => best.get(b)! - best.get(a)!);
    const textItem: Item = { type: 'text', key: 'text:search', label: `Search code for “${q}”`, sub: 'full-text search in every file  ⇧↵', search: q, weight: 0, run: () => searchCode(q) };
    return [...groups.flatMap((g) => top.filter((r) => r.item.type === g).slice(0, g === 'symbol' || g === 'file' ? 20 : 8)), { item: textItem, hits: [] as number[] }];
  }, [items, query, pinnedItems]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && e.shiftKey && query.trim()) {
      e.preventDefault();
      searchCode(query.trim());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.item.run();
    } else if (e.key === 'Escape') {
      close();
    }
  };

  let lastGroup: ItemType | undefined;
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <div className="palette-input">
          <Search size={18} className="muted" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search files, components, functions, routes, packages…" spellCheck={false} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" ref={listRef}>
          {!results.length && <div className="empty">No matches for “{query}”</div>}
          {results.map(({ item, hits }, index) => {
            const header = item.type !== lastGroup ? <div className="palette-group">{GROUP_LABELS[item.type]}</div> : null;
            lastGroup = item.type;
            const ViewIcon = item.type === 'view' ? VIEW_ICONS[item.key.slice(5) as ViewId] : undefined;
            return (
              <div key={item.key}>
                {header}
                <div className={`palette-item${index === active ? ' active' : ''}`} data-index={index} onMouseMove={() => setActive(index)} onClick={() => item.run()}>
                  {item.type === 'file' && item.kind && <KindDot kind={item.kind} size={9} />}
                  {item.type === 'symbol' && item.symbolKind && <SymbolIcon kind={item.symbolKind} />}
                  {item.type === 'route' && (
                    <span className="method" style={{ ['--m' as string]: METHOD_COLORS[item.method ?? ''] ?? undefined, minWidth: 52 }}>
                      {item.method}
                    </span>
                  )}
                  {item.type === 'package' && <Package size={15} className="muted" />}
                  {item.type === 'folder' && <Folder size={15} className="muted" />}
                  {ViewIcon && <ViewIcon size={15} className="muted" />}
                  {item.type === 'action' && (item.key === 'action:theme' ? <Moon size={15} className="muted" /> : <ClipboardCopy size={15} className="muted" />)}
                  {item.type === 'pinned' && <Pin size={15} style={{ color: 'var(--accent)' }} />}
                  {item.type === 'text' && <TextSearch size={15} className="muted" />}
                  <span className="p-label">{item.type === 'file' || item.type === 'symbol' || item.type === 'route' || item.type === 'package' || item.type === 'folder' ? highlight(item.label, hits) : item.label}</span>
                  {item.sub && <span className="p-sub">{item.sub}</span>}
                  {item.kind && <span className="tiny faint">{KIND_META[item.kind].label}</span>}
                  {index === active && <ArrowRight size={14} className="muted" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span className="row nowrap">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className="row nowrap">
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{' '}
            open
          </span>
          <span className="row nowrap">
            <kbd>⇧</kbd>
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{' '}
            search code text
          </span>
          <span className="spacer" />
          <span>{items.length.toLocaleString('en-US')} items indexed</span>
        </div>
      </div>
    </div>
  );
}
