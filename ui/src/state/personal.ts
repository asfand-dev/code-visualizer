import { useSyncExternalStore } from 'react';
import { hashString } from '../lib/colors';
import { liveConfig, loadServerNotes, saveServerNotes } from '../data/live';
import type { Selection } from './store';

/**
 * Personal workspace: pins, notes, recently viewed items and a tour you are writing.
 * Stored in localStorage per project; with `code-visualizer serve` pins, notes and the
 * draft tour are also saved to `.code-visualizer/notes.json` in the project.
 */
export interface Note {
  text: string;
  updatedAt: number;
}

export interface TourDraftStep {
  key: string;
  title?: string;
  description: string;
}

export interface PersonalState {
  pins: string[];
  notes: Record<string, Note>;
  recent: { key: string; at: number }[];
  tour: { title: string; description?: string; steps: TourDraftStep[] };
  /** When this report was last opened before the current session. */
  previousVisit?: number;
}

export function selectionKey(sel: Pick<Selection, 'type' | 'id'>): string {
  return `${sel.type}:${sel.id}`;
}

export function parseKey(key: string): Selection | undefined {
  const i = key.indexOf(':');
  if (i === -1) return undefined;
  const type = key.slice(0, i) as Selection['type'];
  if (!['file', 'symbol', 'folder', 'package', 'route'].includes(type)) return undefined;
  return { type, id: key.slice(i + 1) };
}

let storageKey = 'cv:personal';
let state: PersonalState = { pins: [], notes: {}, recent: [], tour: { title: 'My tour', steps: [] } };
const listeners = new Set<() => void>();
let saveTimer: number | undefined;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const { previousVisit: _skip, ...rest } = state;
    write(storageKey, JSON.stringify(rest));
    if (liveConfig()) void saveServerNotes({ version: 1, pins: state.pins, notes: state.notes, tour: state.tour });
  }, 500);
}

function update(patch: Partial<PersonalState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  persist();
}

/** Load personal data for a project (call once at startup). */
export async function initPersonal(projectRoot: string): Promise<void> {
  storageKey = `cv:personal:${hashString(projectRoot)}`;
  const visitKey = `cv:visit:${hashString(projectRoot)}`;
  const previous = Number(read(visitKey)) || undefined;
  write(visitKey, String(Date.now()));
  try {
    const saved = JSON.parse(read(storageKey) ?? '{}') as Partial<PersonalState>;
    state = {
      pins: Array.isArray(saved.pins) ? saved.pins : [],
      notes: saved.notes && typeof saved.notes === 'object' ? saved.notes : {},
      recent: Array.isArray(saved.recent) ? saved.recent.slice(0, 30) : [],
      tour: saved.tour?.steps ? saved.tour : { title: 'My tour', steps: [] },
      previousVisit: previous,
    };
  } catch {
    state = { ...state, previousVisit: previous };
  }
  if (liveConfig()) {
    const server = (await loadServerNotes()) as Partial<PersonalState> | undefined;
    if (server && typeof server === 'object') {
      state = {
        ...state,
        pins: Array.isArray(server.pins) ? server.pins : state.pins,
        notes: server.notes && typeof server.notes === 'object' ? { ...state.notes, ...server.notes } : state.notes,
        tour: server.tour?.steps ? server.tour : state.tour,
      };
    }
  }
  listeners.forEach((l) => l());
}

export function getPersonal(): PersonalState {
  return state;
}

export function usePersonal<T>(selector: (s: PersonalState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
    () => selector(state),
  );
}

export function togglePin(key: string): void {
  update({ pins: state.pins.includes(key) ? state.pins.filter((p) => p !== key) : [key, ...state.pins].slice(0, 100) });
}

export function setNote(key: string, text: string): void {
  const notes = { ...state.notes };
  if (text.trim()) notes[key] = { text, updatedAt: Date.now() };
  else delete notes[key];
  update({ notes });
}

export function recordVisit(key: string): void {
  const recent = [{ key, at: Date.now() }, ...state.recent.filter((r) => r.key !== key)].slice(0, 30);
  update({ recent });
}

export function addTourStep(step: TourDraftStep): void {
  update({ tour: { ...state.tour, steps: [...state.tour.steps.filter((s) => s.key !== step.key), step] } });
}

export function updateTour(patch: Partial<PersonalState['tour']>): void {
  update({ tour: { ...state.tour, ...patch } });
}

export function removeTourStep(index: number): void {
  update({ tour: { ...state.tour, steps: state.tour.steps.filter((_, i) => i !== index) } });
}

export function moveTourStep(index: number, delta: number): void {
  const steps = [...state.tour.steps];
  const target = index + delta;
  if (target < 0 || target >= steps.length) return;
  [steps[index], steps[target]] = [steps[target], steps[index]];
  update({ tour: { ...state.tour, steps } });
}
