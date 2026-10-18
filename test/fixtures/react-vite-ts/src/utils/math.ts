import { formatNumber } from './format';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Percentage string such as "42%". */
export function percent(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${formatNumber(clamp((value / total) * 100, 0, 100))}%`;
}
