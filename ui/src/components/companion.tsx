import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { heat } from '../lib/colors';
import { copyText } from '../lib/download';
import { parseDiff } from '../lib/diff';
import { highlightLines } from '../lib/highlight';
import { toast } from '../state/store';
import type { ChangeStatus, HistoryPoint } from '../types';

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export { personColor } from '../lib/people';
import { personColor } from '../lib/people';

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ ['--c' as string]: personColor(name) }} title={name}>
      {initials(name)}
    </span>
  );
}

const STATUS: Record<ChangeStatus, { letter: string; color: string; label: string }> = {
  added: { letter: 'A', color: '#34d399', label: 'Added' },
  untracked: { letter: 'U', color: '#34d399', label: 'New (untracked)' },
  modified: { letter: 'M', color: '#fbbf24', label: 'Modified' },
  deleted: { letter: 'D', color: '#f87171', label: 'Deleted' },
  renamed: { letter: 'R', color: '#60a5fa', label: 'Renamed' },
};

export function StatusBadge({ status }: { status: ChangeStatus }) {
  const s = STATUS[status];
  return (
    <span className="status" style={{ ['--s' as string]: s.color }} title={s.label}>
      {s.letter}
    </span>
  );
}

export function PlusMinus({ add, del }: { add: number; del: number }) {
  return (
    <span className="plusminus">
      <span className="add">+{add.toLocaleString('en-US')}</span> <span className="del">−{del.toLocaleString('en-US')}</span>
    </span>
  );
}

export function scoreColor(score: number): string {
  return score >= 80 ? '#34d399' : score >= 60 ? '#fbbf24' : '#f87171';
}

export function ScoreRing({ score, size = 112, label, sub }: { score: number; size?: number; label?: ReactNode; sub?: ReactNode }) {
  const stroke = Math.max(7, size / 12);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = scoreColor(score);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--surface-3)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`}
          style={{ transition: 'stroke-dasharray .6s var(--ease)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
        <div className="ring-label" style={{ fontSize: size / 3.6, fontWeight: 800, lineHeight: 1, color }}>
          {label ?? score}
        </div>
        {sub && <div className="tiny muted" style={{ marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  );
}

/** Small multi-point line chart for history trends. */
export function TrendChart({ points, field, height = 64, format = (v) => String(v) }: { points: HistoryPoint[]; field: keyof HistoryPoint; height?: number; format?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => Number(p[field]) || 0);
  if (values.length < 2) return <div className="tiny faint">Trends appear after a few runs.</div>;
  const width = 320;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number): number => (i / (values.length - 1)) * (width - 8) + 4;
  const y = (v: number): number => height - 6 - ((v - min) / span) * (height - 14);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const h = hover ?? values.length - 1;
  return (
    <div style={{ position: 'relative' }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - rect.left) / rect.width) * (values.length - 1));
          setHover(Math.max(0, Math.min(values.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <circle cx={x(h)} cy={y(values[h])} r={3.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="tiny muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{new Date(points[h].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <strong style={{ color: 'var(--text)' }}>{format(values[h])}</strong>
      </div>
    </div>
  );
}

export function riskColor(level: 'low' | 'medium' | 'high'): string {
  return level === 'high' ? '#f87171' : level === 'medium' ? '#fbbf24' : '#34d399';
}

export function heatColor(t: number): string {
  return heat(t);
}

export function DiffView({ diff, maxHeight }: { diff: string; maxHeight?: number | string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const highlighted = useMemo(() => {
    const code = lines.map((l) => (l.type === 'hunk' || l.type === 'meta' ? '' : l.text)).join('\n');
    return highlightLines(code);
  }, [lines]);
  return (
    <div className="diff" style={{ maxHeight }}>
      <table>
        <tbody>
          {lines.map((l, i) =>
            l.type === 'hunk' || l.type === 'meta' ? (
              <tr key={i} className={l.type}>
                <td colSpan={4}>{l.text}</td>
              </tr>
            ) : (
              <tr key={i} className={l.type}>
                <td className="ln">{l.oldNo ?? ''}</td>
                <td className="ln">{l.newNo ?? ''}</td>
                <td className="mark">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                <td className="lc" dangerouslySetInnerHTML={{ __html: highlighted[i] || ' ' }} />
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Button that copies generated Markdown (PR description, context for AI…) to the clipboard. */
export function CopyMarkdownButton({ label, getText, primary, small }: { label: string; getText: () => string; primary?: boolean; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn${primary ? ' primary' : ''}${small ? ' sm' : ''}`}
      onClick={async () => {
        const ok = await copyText(getText());
        if (ok) {
          setDone(true);
          toast(`${label.replace(/^Copy /, '')} copied to the clipboard`);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label}
    </button>
  );
}
