import type { ReactNode } from 'react';
import { Folder, Package, Route } from 'lucide-react';
import type { Model } from '../data/model';
import { parseKey } from '../state/personal';
import { select, selectFile, selectSymbol } from '../state/store';
import { KindDot, SymbolIcon } from '../components/ui';
import { basename } from './format';

export interface KeyInfo {
  key: string;
  icon: ReactNode;
  label: string;
  sub: string;
  open: () => void;
  exists: boolean;
}

/** Resolve a personal-store key (`file:…`, `symbol:…`, …) to something displayable. */
export function describeKey(model: Model, key: string): KeyInfo | undefined {
  const sel = parseKey(key);
  if (!sel) return undefined;
  switch (sel.type) {
    case 'file': {
      const f = model.fileById.get(sel.id);
      return { key, icon: f ? <KindDot kind={f.kind} /> : <KindDot kind="module" />, label: basename(sel.id), sub: sel.id, open: () => selectFile(sel.id), exists: !!f };
    }
    case 'symbol': {
      const ref = model.resolveSymbol(sel.id);
      return {
        key,
        icon: <SymbolIcon kind={ref?.member ? 'function' : (ref?.symbol.kind ?? 'function')} method={!!ref?.member} />,
        label: ref?.label ?? sel.id.split('#')[1],
        sub: ref?.file.id ?? sel.id.split('#')[0],
        open: () => selectSymbol(sel.id),
        exists: !!ref,
      };
    }
    case 'folder':
      return { key, icon: <Folder size={14} className="muted" />, label: `${basename(sel.id) || '/'}/`, sub: sel.id || 'project root', open: () => select(sel), exists: model.folderByPath.has(sel.id) };
    case 'route': {
      const r = model.routeById.get(sel.id);
      return { key, icon: <Route size={14} className="muted" />, label: r ? `${r.method} ${r.path}` : sel.id, sub: r?.file ?? '', open: () => select(sel), exists: !!r };
    }
    case 'package':
      return { key, icon: <Package size={14} className="muted" />, label: sel.id, sub: 'package', open: () => select(sel), exists: model.packageByName.has(sel.id) };
  }
}
