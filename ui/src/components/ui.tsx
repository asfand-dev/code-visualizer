import { useState, type ReactNode } from 'react';
import { Check, Copy, Search, X, type LucideIcon } from 'lucide-react';
import type { FileKind, SymbolKind } from '../types';
import { KIND_META, SYMBOL_META } from '../lib/colors';
import { copyText } from '../lib/download';
import { basename } from '../lib/format';
import { selectFile } from '../state/store';

export function KindDot({ kind, size = 8 }: { kind: FileKind; size?: number }) {
  return <span className="dot" style={{ ['--c' as string]: KIND_META[kind].color, width: size, height: size }} title={KIND_META[kind].label} />;
}

export function KindBadge({ kind }: { kind: FileKind }) {
  const meta = KIND_META[kind];
  return (
    <span className="badge" style={{ background: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color }}>
      {meta.label}
    </span>
  );
}

export function SymbolIcon({ kind, method }: { kind: SymbolKind; method?: boolean }) {
  const meta = SYMBOL_META[method ? 'method' : kind];
  return (
    <span className="kind-icon" style={{ ['--c' as string]: meta.color }} title={meta.label}>
      {meta.letter}
    </span>
  );
}

export function Stat({
  icon: Icon,
  value,
  label,
  hint,
  color,
  onClick,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  hint?: ReactNode;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`card stat${onClick ? ' interactive' : ''}`}
      onClick={onClick}
      style={color ? { ['--tint' as string]: `color-mix(in srgb, ${color} 16%, transparent)`, ['--tint-fg' as string]: color } : undefined}
    >
      <div className="stat-icon">
        <Icon size={16} />
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: LucideIcon; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)} title={o.title} role="tab" aria-selected={o.value === value}>
          {o.icon && <o.icon size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string }) {
  return (
    <label className="toggle" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  title,
  style,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)} title={title} style={style}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Filter…',
  style,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}) {
  return (
    <div className="input-icon" style={style}>
      <Search size={14} />
      <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} spellCheck={false} />
      {value && (
        <button className="btn ghost icon sm" style={{ position: 'absolute', right: 3 }} onClick={() => onChange('')} aria-label="Clear">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: { value: T; label: string; count?: number; icon?: LucideIcon }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} className={t.value === value ? 'active' : ''} onClick={() => onChange(t.value)} role="tab" aria-selected={t.value === value}>
          {t.icon && <t.icon size={13} />}
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn sm ${label ? '' : 'icon'}`}
      title="Copy"
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label}
    </button>
  );
}

export function FileChip({ id, kind, line, label }: { id: string; kind?: FileKind; line?: number; label?: string }) {
  return (
    <button className="chip" onClick={() => selectFile(id, line)} title={id}>
      {kind && <KindDot kind={kind} />}
      <span className="mono truncate">{label ?? basename(id)}</span>
    </button>
  );
}

export function BarList({
  items,
  max,
  onClick,
  format = (v) => v.toLocaleString('en-US'),
}: {
  items: { key: string; label: ReactNode; value: number; color?: string }[];
  max?: number;
  onClick?: (key: string) => void;
  format?: (v: number) => string;
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="barlist">
      {items.map((item) => (
        <div key={item.key} className="barlist-row" onClick={() => onClick?.(item.key)} style={{ cursor: onClick ? 'pointer' : 'default' }}>
          <div className="label truncate">{item.label}</div>
          <div className="bar">
            <span style={{ width: `${Math.max(2, (item.value / top) * 100)}%`, ['--c' as string]: item.color ?? undefined }} />
          </div>
          <div className="value">{format(item.value)}</div>
        </div>
      ))}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-title">
      {children}
      {right && <span style={{ order: 2, textTransform: 'none', letterSpacing: 0 }}>{right}</span>}
    </div>
  );
}
