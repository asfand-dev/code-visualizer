import { useEffect, useMemo, useRef } from 'react';
import { highlightLines } from '../lib/highlight';
import type { BlameRange } from '../data/live';
import { timeAgo } from '../lib/format';

/** Syntax-highlighted source with line numbers; scrolls to and highlights a line range. Optional git blame gutter. */
export function CodeView({
  source,
  from,
  to,
  startLine = 1,
  maxHeight,
  onLineClick,
  blame,
  changedLines,
  uncoveredLines,
}: {
  source: string;
  from?: number;
  to?: number;
  startLine?: number;
  maxHeight?: number | string;
  onLineClick?: (line: number) => void;
  blame?: BlameRange[];
  changedLines?: Set<number>;
  /** test-intelligence: changed lines no test executed (patch coverage) — a red gutter. */
  uncoveredLines?: Set<number>;
}) {
  const lines = useMemo(() => highlightLines(source), [source]);
  const blameByLine = useMemo(() => {
    if (!blame) return undefined;
    const map = new Map<number, { range: BlameRange; start: boolean }>();
    for (const r of blame) for (let l = r.start; l <= r.end; l++) map.set(l, { range: r, start: l === r.start });
    return map;
  }, [blame]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!from || !ref.current) return;
    const row = ref.current.querySelector<HTMLElement>(`[data-line="${from}"]`);
    if (row) ref.current.scrollTop = Math.max(0, row.offsetTop - 60);
  }, [from, source]);
  const end = to ?? from;
  return (
    <div className="code" ref={ref} style={{ maxHeight, height: maxHeight ? undefined : '100%' }}>
      <table>
        <tbody>
          {lines.map((html, i) => {
            const n = i + startLine;
            const hl = from !== undefined && end !== undefined && n >= from && n <= end;
            const b = blameByLine?.get(n);
            const changed = changedLines?.has(n);
            const uncovered = uncoveredLines?.has(n);
            return (
              <tr
                key={i}
                data-line={n}
                className={[hl ? 'hl' : '', b?.start ? 'blame-start' : '', uncovered ? 'uncovered' : ''].filter(Boolean).join(' ') || undefined}
                onClick={onLineClick ? () => onLineClick(n) : undefined}
              >
                {blameByLine && (
                  <td className="blame" title={b ? `${b.range.author} · ${new Date(b.range.date).toLocaleDateString()} · ${b.range.subject}` : undefined}>
                    {b?.start ? `${b.range.author.split(' ')[0]} · ${timeAgo(b.range.date)}` : ''}
                  </td>
                )}
                <td
                  className="ln"
                  style={uncovered ? { boxShadow: 'inset 3px 0 0 var(--danger)' } : changed ? { boxShadow: 'inset 3px 0 0 var(--warning)' } : undefined}
                  title={uncovered ? 'Changed line that no test executed (coverage report)' : undefined}
                >
                  {n}
                </td>
                <td className="lc" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function sliceLines(source: string, from: number, to: number): string {
  return source
    .split('\n')
    .slice(Math.max(0, from - 1), to)
    .join('\n');
}
