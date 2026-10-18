import { useSyncExternalStore } from 'react';

export type ViewId =
  | 'overview'
  | 'tour'
  | 'graph'
  | 'architecture'
  | 'structure'
  | 'components'
  | 'classes'
  | 'routes'
  | 'flow'
  | 'packages'
  | 'insights';

export const VIEW_IDS: ViewId[] = ['overview', 'tour', 'graph', 'architecture', 'structure', 'components', 'classes', 'routes', 'flow', 'packages', 'insights'];

export type SelectionType = 'file' | 'symbol' | 'folder' | 'package' | 'route';

export interface Selection {
  type: SelectionType;
  id: string;
  line?: number;
}

export type GraphMode = 'focus' | 'impact' | 'files' | 'cycle';

export interface GraphRequest {
  mode: GraphMode;
  files: string[];
  nonce: number;
}

export type EditorId = 'vscode' | 'cursor' | 'windsurf' | 'webstorm' | 'zed' | 'none';

export interface AppState {
  view: ViewId;
  selection: Selection | null;
  paletteOpen: boolean;
  theme: 'dark' | 'light';
  navCollapsed: boolean;
  mobileNav: boolean;
  graphRequest?: GraphRequest;
  /** Symbol id the Flow (call graph) view is centered on. */
  flowRoot?: string;
  /** Tab to open in the detail panel. */
  detailTab?: string;
  editor: EditorId;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode, file:// restrictions) */
  }
}

function parseHash(): Partial<AppState> {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [viewPart, query = ''] = hash.split('?');
  const result: Partial<AppState> = {};
  if (VIEW_IDS.includes(viewPart as ViewId)) result.view = viewPart as ViewId;
  const params = new URLSearchParams(query);
  const sel = params.get('sel');
  if (sel) {
    const i = sel.indexOf(':');
    const type = sel.slice(0, i) as SelectionType;
    if (['file', 'symbol', 'folder', 'package', 'route'].includes(type)) result.selection = { type, id: sel.slice(i + 1) };
  } else {
    result.selection = null;
  }
  return result;
}

function buildHash(s: AppState): string {
  const params = new URLSearchParams();
  if (s.selection) params.set('sel', `${s.selection.type}:${s.selection.id}`);
  const q = params.toString();
  return `#/${s.view}${q ? `?${q}` : ''}`;
}

const initialTheme = (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'dark';

let state: AppState = {
  view: 'overview',
  selection: null,
  paletteOpen: false,
  theme: initialTheme,
  navCollapsed: readStorage('cv-nav') === 'collapsed',
  mobileNav: false,
  editor: (readStorage('cv-editor') as EditorId) || 'vscode',
  ...parseHash(),
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  const prev = state;
  state = { ...state, ...next };
  if (prev.theme !== state.theme) {
    document.documentElement.setAttribute('data-theme', state.theme);
    writeStorage('cv-theme', state.theme);
  }
  if (prev.navCollapsed !== state.navCollapsed) writeStorage('cv-nav', state.navCollapsed ? 'collapsed' : 'expanded');
  if (prev.editor !== state.editor) writeStorage('cv-editor', state.editor);
  if (prev.view !== state.view || prev.selection !== state.selection) {
    const hash = buildHash(state);
    if (hash !== window.location.hash) {
      try {
        if (prev.view !== state.view) window.history.pushState(null, '', hash);
        else window.history.replaceState(null, '', hash);
      } catch {
        /* some file:// contexts disallow history manipulation */
      }
    }
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

window.addEventListener('popstate', () => {
  const parsed = parseHash();
  state = { ...state, ...parsed };
  listeners.forEach((l) => l());
});

/* --------------------------------- Actions -------------------------------- */

export function navigate(view: ViewId): void {
  setState({ view, mobileNav: false });
  document.querySelector('.view')?.scrollTo?.({ top: 0 });
}

export function select(selection: Selection | null, detailTab?: string): void {
  setState({ selection, detailTab });
}

export function selectFile(id: string, line?: number): void {
  setState({ selection: { type: 'file', id, line }, detailTab: line ? 'code' : undefined });
}

export function selectSymbol(id: string): void {
  setState({ selection: { type: 'symbol', id } });
}

let nonce = 0;
export function showInGraph(files: string[], mode: GraphMode = 'files'): void {
  nonce++;
  setState({ view: 'graph', graphRequest: { mode, files, nonce }, mobileNav: false });
}

export function showFlow(symbolId: string): void {
  setState({ view: 'flow', flowRoot: symbolId, mobileNav: false });
}

export function toggleTheme(): void {
  setState((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' }));
}
