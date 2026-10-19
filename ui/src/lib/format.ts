export function fmtNum(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('en-US');
}

export function fmtCompact(n: number): string {
  if (Math.abs(n) < 1000) return String(Math.round(n * 10) / 10);
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return '–';
  const diff = Date.now() - ts;
  const day = 86_400_000;
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 30 * day) {
    const days = Math.round(diff / day);
    return days <= 1 ? 'yesterday' : `${days} days ago`;
  }
  if (diff < 365 * day) {
    const months = Math.round(diff / (30 * day));
    return months <= 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.round((diff / (365 * day)) * 10) / 10;
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** "in 5 min", "in 3 h", "in 2 days" for a time in the future (`now` when it is already past). */
export function timeUntil(ts: number | undefined): string {
  if (!ts) return '–';
  const diff = ts - Date.now();
  const day = 86_400_000;
  if (diff <= 0) return 'now';
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < day) return `in ${Math.round(diff / 3_600_000)} h`;
  const days = Math.round(diff / day);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function fmtDate(ts: number | string | undefined): string {
  if (!ts) return '–';
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${fmtNum(n)} ${n === 1 ? word : pluralWord}`;
}

export function pct(part: number, total: number): string {
  if (!total) return '0%';
  const v = (part / total) * 100;
  return `${v < 1 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function shortPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length <= 2) return `…${p.slice(-max)}`;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}
