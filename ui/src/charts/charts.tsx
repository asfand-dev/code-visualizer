import { useMemo, useState, type ReactNode } from 'react';
import { arc, pie, scaleSqrt, type PieArcDatum } from 'd3';

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function Donut({ data, size = 168, thickness = 22, center }: { data: Slice[]; size?: number; thickness?: number; center?: ReactNode }) {
  const [hover, setHover] = useState<string | null>(null);
  const arcs = useMemo(() => pie<Slice>().value((d) => d.value).sort(null).padAngle(0.015)(data), [data]);
  const r = size / 2;
  const path = arc<PieArcDatum<Slice>>()
    .innerRadius(r - thickness)
    .outerRadius(r)
    .cornerRadius(3);
  const pathHover = arc<PieArcDatum<Slice>>()
    .innerRadius(r - thickness - 2)
    .outerRadius(r + 3)
    .cornerRadius(3);
  const total = data.reduce((n, d) => n + d.value, 0);
  const active = data.find((d) => d.key === hover);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`${-r - 4} ${-r - 4} ${size + 8} ${size + 8}`} role="img">
        {arcs.map((a) => (
          <path
            key={a.data.key}
            d={(a.data.key === hover ? pathHover(a) : path(a)) ?? ''}
            fill={a.data.color}
            opacity={hover && hover !== a.data.key ? 0.4 : 1}
            onMouseEnter={() => setHover(a.data.key)}
            onMouseLeave={() => setHover(null)}
            style={{ transition: 'opacity .15s' }}
          >
            <title>{`${a.data.label}: ${a.data.value.toLocaleString('en-US')}`}</title>
          </path>
        ))}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', pointerEvents: 'none' }}>
        {active ? (
          <>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{Math.round((active.value / Math.max(total, 1)) * 100)}%</div>
            <div className="tiny muted" style={{ maxWidth: size - thickness * 2 - 10 }}>
              {active.label}
            </div>
          </>
        ) : (
          center
        )}
      </div>
    </div>
  );
}

export function Legend({ data, format }: { data: Slice[]; format?: (v: number) => string }) {
  const total = data.reduce((n, d) => n + d.value, 0);
  return (
    <div className="stack" style={{ gap: 7, minWidth: 0, flex: 1 }}>
      {data.map((d) => (
        <div key={d.key} className="row nowrap small" style={{ gap: 8 }}>
          <span className="dot" style={{ ['--c' as string]: d.color }} />
          <span className="truncate" style={{ flex: 1 }}>
            {d.label}
          </span>
          <span className="muted num">{format ? format(d.value) : d.value.toLocaleString('en-US')}</span>
          <span className="faint num tiny" style={{ width: 36, textAlign: 'right' }}>
            {Math.round((d.value / Math.max(total, 1)) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ values, width = 320, height = 56, color = 'var(--accent)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((v, i) => [i * step, height - 4 - (v / max) * (height - 8)] as const);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = useMemo(() => `spark-${Math.random().toString(36).slice(2)}`, []);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface ScatterPoint {
  key: string;
  x: number;
  y: number;
  r: number;
  color: string;
  label: string;
  detail?: string;
}

export function Scatter({
  points,
  xLabel,
  yLabel,
  height = 320,
  onClick,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
  onClick?: (key: string) => void;
}) {
  const [hover, setHover] = useState<ScatterPoint | null>(null);
  const width = 640;
  const m = { l: 46, r: 16, t: 14, b: 38 };
  const xMax = Math.max(1, ...points.map((p) => p.x));
  const yMax = Math.max(1, ...points.map((p) => p.y));
  // Square-root axes keep a few huge outliers from squashing everything else into a corner.
  const x = scaleSqrt().domain([0, xMax * 1.05]).range([m.l, width - m.r]).nice();
  const y = scaleSqrt().domain([0, yMax * 1.08]).range([height - m.b, m.t]).nice();
  const rMax = Math.max(1, ...points.map((p) => p.r));
  const r = scaleSqrt().domain([0, rMax]).range([3, 16]);
  const xt = x.ticks(6);
  const yt = y.ticks(5);
  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block' }}>
        {/* quadrant hint: top-right = hotspots */}
        <rect x={x(xMax * 0.25)} y={m.t} width={Math.max(0, width - m.r - x(xMax * 0.25))} height={Math.max(0, y(yMax * 0.25) - m.t)} fill="var(--danger)" opacity="0.05" rx="8" />
        {xt.map((t) => (
          <g key={`x${t}`}>
            <line x1={x(t)} x2={x(t)} y1={m.t} y2={height - m.b} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={x(t)} y={height - m.b + 16} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">
              {t}
            </text>
          </g>
        ))}
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={m.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--text-faint)">
              {t}
            </text>
          </g>
        ))}
        <text x={(m.l + width - m.r) / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--text-dim)">
          {xLabel}
        </text>
        <text transform={`translate(12 ${(m.t + height - m.b) / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fill="var(--text-dim)">
          {yLabel}
        </text>
        {points.map((p) => (
          <circle
            key={p.key}
            cx={x(p.x)}
            cy={y(p.y)}
            r={r(p.r)}
            fill={p.color}
            fillOpacity={hover && hover.key !== p.key ? 0.25 : 0.7}
            stroke={p.color}
            strokeWidth={hover?.key === p.key ? 2.5 : 1}
            style={{ cursor: onClick ? 'pointer' : 'default', transition: 'fill-opacity .15s' }}
            onMouseEnter={() => setHover(p)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onClick?.(p.key)}
          />
        ))}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: `${(x(hover.x) / width) * 100}%`, top: `${(y(hover.y) / height) * 100}%`, transform: 'translate(12px, -50%)' }}>
          <div className="tt-title mono">{hover.label}</div>
          {hover.detail && <div className="muted">{hover.detail}</div>}
        </div>
      )}
    </div>
  );
}
