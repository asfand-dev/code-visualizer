/**
 * Review mode on the live server: `GET /api/review?ref=` (the reading plan of a branch or fetched pull
 * request, cached per head commit), `GET|PUT /api/review-state?ref=` (files marked as viewed) and
 * `GET /api/review-refs` (branches worth reviewing). Never fetches from a remote.
 */
import { createAnalyzeCache, type AnalyzeCache, type AnalyzeOptions } from '../analyzer/index.js';
import { loadDiskCache } from '../analyzer/disk-cache.js';
import { AnalyzeError } from '../analyzer/errors.js';
import { resolveCommit } from '../analyzer/git.js';
import { buildReviewPlan, currentlyViewed, listReviewRefs, pullRequestFetch, readReviewState, resolveReviewRef, reviewMergeBase, updateReviewState } from '../analyzer/review.js';
import { applyViewed } from '../shared/review.js';
import type { ReviewPlan } from '../shared/types.js';

export interface ReviewResponse {
  status: number;
  body: unknown;
}

/** Plans kept in memory (per head commit, base and test placement). */
const PLAN_LIMIT = 8;
const MAX_REF_LENGTH = 300;

export interface ReviewService {
  /** Handles the review endpoints; undefined for any other path. */
  handle(method: string, pathname: string, params: URLSearchParams, readBody: () => Promise<string>): Promise<ReviewResponse | undefined>;
}

const error = (status: number, message: string, extra: Record<string, unknown> = {}): ReviewResponse => ({ status, body: { error: message, ...extra } });

export function createReviewService(root: string, analysis: Omit<AnalyzeOptions, 'root' | 'cache' | 'onProgress'>): ReviewService {
  let cache: AnalyzeCache | undefined;
  const plans = new Map<string, Promise<ReviewPlan>>();
  // One review analysis at a time: they share a parse cache.
  let queue: Promise<unknown> = Promise.resolve();

  const sharedCache = (): AnalyzeCache => {
    if (!cache) {
      cache = createAnalyzeCache();
      // Files equal to the working tree reuse the warm parse results of `serve`.
      if (analysis.persist) loadDiskCache(root, cache);
    }
    return cache;
  };

  /** The ref parameter, resolved (pull / merge requests only when already fetched). */
  const resolve = async (params: URLSearchParams): Promise<{ ref: string; commit: string; label: string } | ReviewResponse> => {
    const input = params.get('ref')?.trim() ?? '';
    if (!input || input.length > MAX_REF_LENGTH || /[\0\n\r]/.test(input) || input.startsWith('-')) return error(400, 'Pass a branch, tag, commit, #123 or !45 as ?ref=');
    const resolved = await resolveReviewRef(root, input);
    if (resolved.ok) return resolved;
    if (resolved.pr) {
      const fetch = pullRequestFetch(resolved.pr);
      return error(404, `${input} is not fetched yet. Run: ${fetch.command}`, { fetch: fetch.command });
    }
    return error(404, `Unknown git ref "${input}".`);
  };

  const plan = async (params: URLSearchParams): Promise<ReviewResponse> => {
    const target = await resolve(params);
    if ('status' in target) return target;
    const base = params.get('base')?.trim() || undefined;
    if (base && (base.length > MAX_REF_LENGTH || !(await resolveCommit(root, base)))) return error(404, `Unknown git ref "${base}".`);
    const testFirst = params.get('testFirst') === '1';
    const key = `${target.commit}\0${target.label}\0${base ?? ''}\0${testFirst}`;
    let pending = plans.get(key);
    if (!pending) {
      const run = queue.then(() =>
        buildReviewPlan(root, target.ref, { base, testFirst, label: target.label, cache: sharedCache(), files: true, exclude: analysis.exclude, maxFiles: analysis.maxFiles, toolVersion: analysis.toolVersion, persist: analysis.persist }),
      );
      queue = run.catch(() => undefined);
      pending = run;
      plans.set(key, pending);
      pending.catch(() => plans.delete(key));
      while (plans.size > PLAN_LIMIT) plans.delete(plans.keys().next().value!);
    }
    try {
      const result = await pending;
      // Viewed flags change between requests; the cached plan stays untouched.
      const copy: ReviewPlan = { ...result, steps: result.steps.map((s) => ({ ...s })), skim: result.skim.map((s) => ({ ...s })) };
      applyViewed(copy, readReviewState(root, target.label).viewed);
      return { status: 200, body: copy };
    } catch (e) {
      if (e instanceof AnalyzeError) return error(422, e.message);
      throw e;
    }
  };

  const state = async (method: string, params: URLSearchParams, readBody: () => Promise<string>): Promise<ReviewResponse> => {
    const target = await resolve(params);
    if ('status' in target) return target;
    if (method === 'PUT') {
      let body: { file?: unknown; viewed?: unknown; files?: unknown; head?: unknown };
      try {
        body = JSON.parse(await readBody()) as typeof body;
      } catch {
        return error(400, 'Expected JSON: { "file": "src/a.ts", "viewed": true } or { "files": { "src/a.ts": true } }, optionally with "head": the commit you reviewed');
      }
      if (!body || typeof body !== 'object') return error(400, 'Expected a JSON object.');
      const changes: Record<string, boolean> = {};
      if (typeof body.file === 'string') changes[body.file] = body.viewed !== false;
      if (body.files && typeof body.files === 'object') for (const [file, v] of Object.entries(body.files as Record<string, unknown>)) changes[file] = v === true;
      if (!Object.keys(changes).length) return error(400, 'Nothing to update: pass "file" (and "viewed") or "files".');
      if (Object.keys(changes).length > 5000) return error(400, 'Too many files.');
      // The version the reviewer looked at (the plan's head): the branch may have moved since the page loaded.
      let shown = target.commit;
      if (body.head !== undefined) {
        const head = typeof body.head === 'string' && /^[0-9a-f]{7,64}$/i.test(body.head) ? await resolveCommit(root, body.head) : undefined;
        if (!head) return error(400, '"head" must be the commit of the reviewed version.');
        shown = head;
      }
      const base = params.get('base')?.trim() || undefined;
      if (base && (base.length > MAX_REF_LENGTH || base.startsWith('-'))) return error(400, 'Invalid base.');
      try {
        const mergeBase = await reviewMergeBase(root, shown, base);
        const next = await updateReviewState(root, target.label, target.commit, changes, { shown, mergeBase });
        // `moved`: the ref has a newer version than the one viewed; files that changed since are not viewed.
        return { status: 200, body: { ref: target.label, commit: target.commit, viewed: Object.keys(next.viewed).sort(), moved: shown !== target.commit || undefined } };
      } catch (e) {
        if (e instanceof AnalyzeError) return error(400, e.message);
        throw e;
      }
    }
    const viewed = await currentlyViewed(root, target.commit, readReviewState(root, target.label));
    return { status: 200, body: { ref: target.label, commit: target.commit, viewed } };
  };

  return {
    async handle(method, pathname, params, readBody) {
      if (pathname === '/api/review' && method === 'GET') return plan(params);
      if (pathname === '/api/review-state' && (method === 'GET' || method === 'PUT')) return state(method, params, readBody);
      if (pathname === '/api/review-refs' && method === 'GET') {
        const days = Number(params.get('days') ?? 14);
        return { status: 200, body: { refs: await listReviewRefs(root, { days: Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 14 }) } };
      }
      return undefined;
    },
  };
}
