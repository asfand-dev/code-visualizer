import { useMemo, useState } from 'react';
import { Bot, FileText, Plug, Puzzle, Sparkles, SquareTerminal, Webhook, type LucideIcon } from 'lucide-react';
import { fmtCompact, plural, timeAgo } from '../lib/format';
import type { AiCatalog, AiItem, AiItemKind, AiScope } from '../types';
import { PathLink } from './PathLink';
import { CopyButton, SearchInput, Segmented, Select } from './ui';

type KindFilter = 'all' | AiItemKind;
type ScopeFilter = 'all' | AiScope;

const KIND: Record<AiItemKind, { label: string; plural: string; icon: LucideIcon }> = {
  skill: { label: 'Skill', plural: 'Skills', icon: Sparkles },
  command: { label: 'Command', plural: 'Commands', icon: SquareTerminal },
  agent: { label: 'Subagent', plural: 'Subagents', icon: Bot },
  mcp: { label: 'MCP server', plural: 'MCP servers', icon: Plug },
  hook: { label: 'Hook', plural: 'Hooks', icon: Webhook },
  plugin: { label: 'Plugin', plural: 'Plugins', icon: Puzzle },
  memory: { label: 'Memory', plural: 'Memory', icon: FileText },
};
const KIND_ORDER: AiItemKind[] = ['skill', 'command', 'agent', 'mcp', 'hook', 'plugin', 'memory'];
const SCOPE: Record<AiScope, { label: string; tone: string; title: string }> = {
  project: { label: 'project', tone: 'accent', title: 'Committed with the repository: everyone who works here has it' },
  local: { label: 'local', tone: '', title: 'Your own files in this repository (git-ignored)' },
  user: { label: 'personal', tone: 'info', title: 'From ~/.claude: available in every project on this computer' },
  plugin: { label: 'plugin', tone: 'success', title: 'Comes with an installed plugin' },
};
const SCOPE_ORDER: AiScope[] = ['project', 'local', 'user', 'plugin'];
/** Items listed before "Show more". */
const PAGE = 30;

export function kindCounts(items: AiItem[]): Record<AiItemKind, number> {
  const counts = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])) as Record<AiItemKind, number>;
  for (const item of items) counts[item.kind]++;
  return counts;
}

function ItemCard({ item }: { item: AiItem }) {
  const { icon: Icon, label } = KIND[item.kind];
  const scope = SCOPE[item.scope];
  return (
    <div className="ai-item">
      <div className="row" style={{ gap: 8 }}>
        <Icon size={15} className="muted" style={{ flexShrink: 0 }} aria-label={label} />
        <b className="mono small truncate" title={item.name}>
          {item.name}
        </b>
        <span className={`badge ${scope.tone}`} title={scope.title}>
          {scope.label}
        </span>
        {item.plugin && <span className="badge mono">{item.plugin}</span>}
        {item.auto && (
          <span className="badge" title="Claude can start it on its own when your request fits its description">
            automatic
          </span>
        )}
        {item.warning && (
          <span className="badge warn" title={item.warning}>
            check
          </span>
        )}
        <span className="spacer" />
        {item.invoke && <CopyButton text={item.invoke} label={item.invoke} />}
      </div>
      {item.description && <div className="tiny muted wrap-anywhere">{item.description}</div>}
      <div className="small wrap-anywhere">{item.usage}</div>
      {item.warning && (
        <div className="tiny" style={{ color: 'var(--warning)' }}>
          {item.warning}
        </div>
      )}
      <div className="row tiny faint" style={{ gap: 10 }}>
        {item.detail && <span>{item.detail}</span>}
        {item.model && <span>model {item.model}</span>}
        {item.tools && item.tools.length > 0 && <span title={item.tools.join(', ')}>{plural(item.tools.length, 'tool')}</span>}
        {item.tokens !== undefined && <span title="Rough size in Claude's context window when it is loaded">~{fmtCompact(item.tokens)} tokens</span>}
        {item.uses && <span title="Recorded by Claude Code">used {item.uses.count}× · last {timeAgo(item.uses.last)}</span>}
        <PathLink path={item.path} label={item.path} />
      </div>
    </div>
  );
}

/** Everything Claude Code can use here, filtered by kind, origin and text. */
export function AiCatalogList({ catalog }: { catalog: AiCatalog }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const counts = useMemo(() => kindCounts(catalog.items), [catalog.items]);
  const present = KIND_ORDER.filter((k) => counts[k] > 0);
  const scopes = SCOPE_ORDER.filter((s) => catalog.items.some((item) => item.scope === s));

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.items
      .filter((item) => (kind === 'all' || item.kind === kind) && (scope === 'all' || item.scope === scope) && (!q || `${item.name} ${item.description ?? ''} ${item.usage}`.toLowerCase().includes(q)))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name));
  }, [catalog.items, kind, scope, search]);

  return (
    <>
      <div className="row" style={{ gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <Segmented
          value={kind}
          onChange={(value) => {
            setKind(value);
            setLimit(PAGE);
          }}
          options={[{ value: 'all', label: `All (${catalog.items.length})` }, ...present.map((k) => ({ value: k, label: `${KIND[k].plural} (${counts[k]})` }))]}
        />
        <span className="spacer" />
        {scopes.length > 1 && <Select value={scope} onChange={(value) => { setScope(value); setLimit(PAGE); }} options={[{ value: 'all', label: 'Any origin' }, ...scopes.map((s) => ({ value: s, label: SCOPE[s].label }))]} title="Where it comes from" />}
        <SearchInput value={search} onChange={(value) => { setSearch(value); setLimit(PAGE); }} placeholder="Filter…" style={{ width: 180 }} />
      </div>
      <div className="ai-items">
        {shown.slice(0, limit).map((item) => (
          <ItemCard key={`${item.kind}:${item.scope}:${item.plugin ?? ''}:${item.name}:${item.path}`} item={item} />
        ))}
        {!shown.length && <div className="empty">{catalog.items.length ? 'Nothing matches.' : 'No skills, commands, agents, MCP servers or hooks found.'}</div>}
        {shown.length > limit && (
          <div style={{ padding: '8px 14px' }}>
            <button className="btn ghost sm" onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
