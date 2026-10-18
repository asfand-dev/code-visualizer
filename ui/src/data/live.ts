import type { LiveFeed, LiveUpdate, ReportData, ReviewPlan, ReviewRef, SyncReport } from '../types';

export interface LiveConfig {
  token: string;
  version: number;
  /** Default editor of the server (CODE_VISUALIZER_EDITOR). */
  editor?: string;
}

/** Present when the report is served by `code-visualizer serve`. */
export function liveConfig(): LiveConfig | undefined {
  const value = (window as unknown as { __CV_LIVE__?: LiveConfig }).__CV_LIVE__;
  return value && typeof value.token === 'string' && location.protocol.startsWith('http') ? value : undefined;
}

function headers(live: LiveConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-CV-Token': live.token, ...extra };
}

export async function fetchLiveData(live: LiveConfig): Promise<ReportData> {
  const res = await fetch('/api/data', { headers: headers(live), cache: 'no-store' });
  if (!res.ok) throw new Error(`Live data request failed (${res.status})`);
  return (await res.json()) as ReportData;
}

/** This session's live feed and the problems still open (live-guard); undefined when unavailable. */
export async function fetchLiveFeed(live: LiveConfig): Promise<LiveFeed | undefined> {
  try {
    const res = await fetch('/api/events/history', { headers: headers(live), cache: 'no-store' });
    return res.ok ? ((await res.json()) as LiveFeed) : undefined;
  } catch {
    return undefined;
  }
}

// --- daily-loop ---
/** The sync forecast of the live server (`GET /api/sync`): incoming commits, conflicts, broken calls. */
export async function fetchSync(live: LiveConfig, options: { branches?: boolean } = {}): Promise<SyncReport> {
  const query = options.branches ? '?branches=1' : '';
  const res = await fetch(`/api/sync${query}`, { headers: headers(live), cache: 'no-store' });
  if (!res.ok) {
    let message = `Sync request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as SyncReport;
}
// --- /daily-loop ---

export function connectLive(
  live: LiveConfig,
  handlers: { onUpdate: (info: LiveUpdate) => void; onStatus: (connected: boolean) => void; onError: (message: string) => void },
): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let retry: number | undefined;
  const open = (): void => {
    source = new EventSource(`/api/events?token=${encodeURIComponent(live.token)}`);
    source.addEventListener('hello', () => handlers.onStatus(true));
    source.addEventListener('update', (e) => {
      // Servers before live-guard send no events.
      const info = JSON.parse((e as MessageEvent).data) as Partial<LiveUpdate> & Pick<LiveUpdate, 'version' | 'changed' | 'durationMs'>;
      handlers.onUpdate({ files: 0, ...info, events: info.events ?? [], open: info.open ?? 0 });
    });
    source.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      if (data) handlers.onError(JSON.parse(data).message);
    });
    source.onerror = () => {
      handlers.onStatus(false);
      source?.close();
      if (!closed) retry = window.setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}

/** Ask the live server to open a file in the editor. Returns false when unavailable. */
export async function openInEditor(file: string, line: number | undefined, editor: string): Promise<boolean> {
  const live = liveConfig();
  if (!live) return false;
  try {
    const res = await fetch('/api/open', { method: 'POST', headers: headers(live, { 'Content-Type': 'application/json' }), body: JSON.stringify({ file, line, editor }) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface BlameRange {
  start: number;
  end: number;
  author: string;
  date: number;
  hash: string;
  subject: string;
}

export async function fetchBlame(file: string): Promise<BlameRange[] | undefined> {
  const live = liveConfig();
  if (!live) return undefined;
  const res = await fetch(`/api/blame?file=${encodeURIComponent(file)}`, { headers: headers(live) });
  return res.ok ? ((await res.json()) as BlameRange[]) : undefined;
}

export async function loadServerNotes(): Promise<unknown> {
  const live = liveConfig();
  if (!live) return undefined;
  try {
    const res = await fetch('/api/notes', { headers: headers(live) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function saveServerNotes(payload: unknown): Promise<boolean> {
  const live = liveConfig();
  if (!live) return false;
  try {
    const res = await fetch('/api/notes', { method: 'PUT', headers: headers(live, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function saveServerTour(tour: unknown): Promise<string | undefined> {
  const live = liveConfig();
  if (!live) return undefined;
  const res = await fetch('/api/tours', { method: 'POST', headers: headers(live, { 'Content-Type': 'application/json' }), body: JSON.stringify(tour) });
  if (!res.ok) return undefined;
  return ((await res.json()) as { path: string }).path;
}

// --- review-mode ---

/** A failed review request: the message, and the fetch command for a pull request that is not fetched yet. */
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly fetch?: string,
  ) {
    super(message);
  }
}

async function reviewJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: { error?: string; fetch?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }
  throw new ReviewError(body.error ?? `Request failed (${res.status})`, body.fetch);
}

const reviewQuery = (ref: string, extra: Record<string, string | undefined> = {}): string => {
  const params = new URLSearchParams({ ref });
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return params.toString();
};

/** The reading plan of a branch or fetched pull request (`GET /api/review`), with diffs and viewed flags. */
export async function fetchReview(ref: string, options: { base?: string; testFirst?: boolean } = {}): Promise<ReviewPlan> {
  const live = liveConfig();
  if (!live) throw new ReviewError('Reviewing other branches needs the live companion (code-visualizer serve).');
  const res = await fetch(`/api/review?${reviewQuery(ref, { base: options.base, testFirst: options.testFirst ? '1' : undefined })}`, { headers: headers(live), cache: 'no-store' });
  return reviewJson<ReviewPlan>(res);
}

/** Branches and fetched pull requests updated recently, agent branches first (`GET /api/review-refs`). */
export async function fetchReviewRefs(): Promise<ReviewRef[]> {
  const live = liveConfig();
  if (!live) return [];
  try {
    const res = await fetch('/api/review-refs', { headers: headers(live), cache: 'no-store' });
    return res.ok ? ((await res.json()) as { refs: ReviewRef[] }).refs : [];
  } catch {
    return [];
  }
}

/** What the server answers about a review's viewed files: the ref's current commit and the files viewed there. */
export interface ReviewStateResponse {
  commit: string;
  viewed: string[];
  /** The ref moved past the version that was marked (PUT with `head`). */
  moved?: boolean;
}

/**
 * Mark files of a review as viewed or not (`PUT /api/review-state`). `head` is the commit the reviewer
 * was shown: files are stored at that version, so a newer push is not marked as viewed by mistake.
 */
export async function saveReviewViewed(ref: string, files: Record<string, boolean>, options: { head?: string; base?: string } = {}): Promise<ReviewStateResponse> {
  const live = liveConfig();
  if (!live) throw new ReviewError('Not connected to the live companion.');
  const res = await fetch(`/api/review-state?${reviewQuery(ref, { base: options.base })}`, { method: 'PUT', headers: headers(live, { 'Content-Type': 'application/json' }), body: JSON.stringify({ files, head: options.head }) });
  return reviewJson<ReviewStateResponse>(res);
}

/** The ref's current commit and the files viewed there (`GET /api/review-state`); undefined when unavailable. */
export async function fetchReviewState(ref: string): Promise<ReviewStateResponse | undefined> {
  const live = liveConfig();
  if (!live) return undefined;
  try {
    const res = await fetch(`/api/review-state?${reviewQuery(ref)}`, { headers: headers(live), cache: 'no-store' });
    return res.ok ? ((await res.json()) as ReviewStateResponse) : undefined;
  } catch {
    return undefined;
  }
}
