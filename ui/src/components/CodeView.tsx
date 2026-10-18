import { useEffect, useMemo, useRef } from 'react';
import { highlightLines } from '../lib/highlight';

/** Syntax-highlighted source with line numbers; scrolls to and highlights a line range. */
export function CodeView({
  source,
  from,
  to,
  startLine = 1,
  maxHeight,
  onLineClick,
}: {
  source: string;
  from?: number;
  to?: number;
  startLine?: number;
  maxHeight?: number | string;
  onLineClick?: (line: number) => void;
}) {
  const lines = useMemo(() => highlightLines(source), [source]);
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
            return (
              <tr key={i} data-line={n} className={hl ? 'hl' : undefined} onClick={onLineClick ? () => onLineClick(n) : undefined}>
                <td className="ln">{n}</td>
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
