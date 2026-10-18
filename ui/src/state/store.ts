import { useSyncExternalStore } from 'react';
import type { LiveEvent, LiveSeverity } from '../types';

export type ViewId =
  | 'today'
  | 'changes'
  | 'search'
  | 'activity'
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

export const VIEW_IDS: ViewId[] = ['today', 'changes', 'search', 'activity', 'overview', 'tour', 'graph', 'architecture', 'structure', 'components', 'classes', 'routes', 'flow', 'packages', 'insights'];

export type SelectionType = 'file' | 'symbol' | 'folder' | 'package' | 'route';

export interface Selection {
  type: SelectionType;
  id: string;
  line?: number;
}

export type GraphMode = 'focus' | 'impact' | 'files' | 'cycle' | 'changes';

export interface GraphRequest {
  mode: GraphMode;
  files: string[];
  nonce: number;
}

export type EditorId = 'vscode' | 'cursor' | 'windsurf' | 'webstorm' | 'idea' | 'zed' | 'sublime' | 'none';

const EDITOR_IDS: EditorId[] = ['vscode', 'cursor', 'windsurf', 'webstorm', 'idea', 'zed', 'sublime', 'none'];

/** Your own choice wins, then the live server's default (CODE_VISUALIZER_EDITOR), then VS Code. */
function initialEditor(): EditorId {
  const fromServer = (window as unknown as { __CV_LIVE__?: { editor?: string } }).__CV_LIVE__?.editor;
  for (const value of [readStorage('cv-editor'), fromServer]) if (value && EDITOR_IDS.includes(value as EditorId)) return value as EditorId;
  return 'vscode';
}

export interface LiveStatus {
  connected: boolean;
  version: number;
  updatedAt: number;
  changed: string[];
  error?: string;
}

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
  /** Set when the report is served by `code-visualizer serve`. */
  live?: LiveStatus;
  /** Query for the code search view. */
  searchQuery: string;
  toast?: Toast;
  // --- live-guard ---
  /** What got worse or better while `serve` runs (oldest first, at most 200). */
  liveFeed: LiveEvent[];
  /** Problems announced in this session that are still there (from /api/events/history). */
  liveOpen: LiveEvent[];
  /** Number of open problems (errors and warnings), shown in the tab title. */
  liveOpenCount: number;
  /** Desktop notifications for new errors while the tab is in the background (off by default). */
  desktopNotify: boolean;
  // --- review-mode ---
  /** My changes shows your own work (author) or another branch / pull request (reviewer, live server only). */
  changesRole: ChangesRole;
  /** The branch or pull request under review (`#/changes?review=<ref>`). */
  review?: ReviewTarget;
}

// --- review-mode ---
export type ChangesRole = 'author' | 'reviewer';

export interface ReviewTarget {
  ref: string;
  base?: string;
  testFirst?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  /** When it appeared (ms since the epoch). */
  shownAt?: number;
  /** Colours the toast (live events). */
  tone?: LiveSeverity;
  /** A button next to the text, e.g. "Show". */
  action?: { label: string; run: () => void };
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
  const q = params.get('q');
  if (q !== null) result.searchQuery = q;
  const sel = params.get('sel');
  if (sel) {
    const i = sel.indexOf(':');
    const type = sel.slice(0, i) as SelectionType;
    if (['file', 'symbol', 'folder', 'package', 'route'].includes(type)) result.selection = { type, id: sel.slice(i + 1) };
  } else {
    result.selection = null;
  }
  // review-mode: `#/changes?review=feature&base=main&tf=1` opens My changes as a reviewer of that ref.
  if (result.view === 'changes') {
    const ref = params.get('review');
    result.changesRole = ref || params.get('role') === 'reviewer' ? 'reviewer' : 'author';
    result.review = ref ? { ref, base: params.get('base') || undefined, testFirst: params.get('tf') === '1' || undefined } : undefined;
  }
  return result;
}

function buildHash(s: AppState): string {
  const params = new URLSearchParams();
  if (s.view === 'search' && s.searchQuery) params.set('q', s.searchQuery);
  if (s.selection) params.set('sel', `${s.selection.type}:${s.selection.id}`);
  if (s.view === 'changes' && s.changesRole === 'reviewer') {
    if (s.review) {
      params.set('review', s.review.ref);
      if (s.review.base) params.set('base', s.review.base);
      if (s.review.testFirst) params.set('tf', '1');
    } else params.set('role', 'reviewer');
  }
  const q = params.toString();
  return `#/${s.view}${q ? `?${q}` : ''}`;
}

const initialTheme = (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'dark';

let state: AppState = {
  view: 'today',
  searchQuery: '',
  selection: null,
  paletteOpen: false,
  theme: initialTheme,
  navCollapsed: readStorage('cv-nav') === 'collapsed',
  mobileNav: false,
  editor: initialEditor(),
  liveFeed: [],
  liveOpen: [],
  liveOpenCount: 0,
  desktopNotify: readStorage('cv-notify') === 'on',
  changesRole: 'author',
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
  if (prev.desktopNotify !== state.desktopNotify) writeStorage('cv-notify', state.desktopNotify ? 'on' : 'off');
  const reviewMoved = prev.review !== state.review || prev.changesRole !== state.changesRole;
  if (prev.view !== state.view || prev.selection !== state.selection || (state.view === 'search' && prev.searchQuery !== state.searchQuery) || reviewMoved) {
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

export function searchCode(query: string): void {
  setState({ view: 'search', searchQuery: query, paletteOpen: false, mobileNav: false });
}

let toastId = 0;
export function toast(text: string, options: Pick<Toast, 'tone' | 'action'> = {}): void {
  toastId++;
  const id = toastId;
  setState({ toast: { id, text, shownAt: Date.now(), ...options } });
  // Toasts with a button stay long enough to use it.
  setTimeout(
    () => {
      if (getState().toast?.id === id) setState({ toast: undefined });
    },
    options.action ? 7000 : 3200,
  );
}

export function dismissToast(): void {
  setState({ toast: undefined });
}

// --- live-guard ---
export const LIVE_FEED_LIMIT = 200;

/** Add the events of a live update to the feed (capped) and update the open problems (the list, when the server sends it). */
export function pushLiveEvents(events: LiveEvent[], openCount: number, open?: LiveEvent[]): void {
  setState((s) => {
    const known = new Set(s.liveFeed.map((e) => e.id));
    const feed = events.length ? [...s.liveFeed, ...events.filter((e) => !known.has(e.id))].slice(-LIVE_FEED_LIMIT) : s.liveFeed;
    return { liveFeed: feed, liveOpenCount: openCount, ...(open ? { liveOpen: open } : {}) };
  });
}

export function toggleTheme(): void {
  setState((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' }));
}

// --- review-mode ---
/** Switch My changes between your own work and reviewing another ref. */
export function setChangesRole(changesRole: ChangesRole): void {
  setState({ changesRole });
}

/** Review a branch or pull request (undefined: pick one). */
export function setReview(review: ReviewTarget | undefined): void {
  setState({ review, changesRole: 'reviewer' });
}
