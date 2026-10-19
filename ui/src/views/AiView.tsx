import { useMemo, useState } from 'react';
import { Bot, Check, FileText, Plug, Sparkles, SquareTerminal, Webhook, X } from 'lucide-react';
import { CLAUDE_GUIDE, CODE_VISUALIZER_PROMPTS, CODE_VISUALIZER_TOOLS, guideTemplates } from '../../../src/shared/ai-guide';
import { useModel } from '../data/context';
import { fmtCompact, fmtNum, plural } from '../lib/format';
import { useRefreshOnFocus } from '../lib/use-refresh-on-focus';
import { AiCatalogList, kindCounts } from '../components/AiCatalogList';
import { CommandBlock } from '../components/CommandBlock';
import { PathLink } from '../components/PathLink';
import { RefreshButton } from '../components/RefreshButton';
import { CopyButton, Empty, Stat, Tabs } from '../components/ui';
import type { AiCatalog, ToolCheck } from '../types';

type AiTab = 'available' | 'guide' | 'templates' | 'tools';

/** The project's own setup: one-line verdicts with the command that fixes what is missing. */
function ChecksCard({ catalog }: { catalog: AiCatalog }) {
  const failing = catalog.checks.filter((c) => !c.ok).length;
  const { permissions } = catalog;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Setup</h3>
        <span className="tiny faint">{failing ? `${failing} to improve` : 'all good'}</span>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {catalog.checks.map((check: ToolCheck) => (
          <div key={check.id} className="row nowrap small" style={{ gap: 8, alignItems: 'flex-start' }}>
            {check.ok ? <Check size={15} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} /> : <X size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />}
            <span style={{ minWidth: 0, flex: 1 }}>
              {check.label}
              {check.detail && <div className="tiny muted wrap-anywhere">{check.detail}</div>}
              {!check.ok && check.fix && (
                <div style={{ marginTop: 4 }}>
                  <CommandBlock commands={check.fix} />
                </div>
              )}
            </span>
          </div>
        ))}
        <div className="tiny muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          Claude loads about <b>{fmtCompact(catalog.startupTokens)} tokens</b> at the start of every session (memory files and the descriptions of skills); everything else is loaded when used.
          {permissions && (
            <>
              {' '}
              Permissions: {permissions.allow} allowed, {permissions.ask} ask, {permissions.deny} denied{permissions.mode ? `, mode ${permissions.mode}` : ''}.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GuideTab() {
  return (
    <div className="card-body stack" style={{ gap: 20 }}>
      {CLAUDE_GUIDE.map((section) => (
        <section key={section.id}>
          <div className="section-title">{section.title}</div>
          <div className="tiny muted" style={{ marginBottom: 8 }}>
            {section.intro}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {section.entries.map((entry) => (
              <div key={entry.name} className="guide-entry">
                <span className="mono small" style={{ fontWeight: 600 }}>
                  {entry.name}
                </span>
                <span className="small muted wrap-anywhere">{entry.text}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TemplatesTab() {
  const { data } = useModel();
  const templates = useMemo(() => guideTemplates(data.project), [data.project]);
  return (
    <div className="card-body stack" style={{ gap: 18 }}>
      <div className="tiny muted">Starting points filled in from this project. Save each at its path, then edit: a short, specific file beats a long one.</div>
      {templates.map((template) => (
        <section key={template.id}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <b className="small">{template.title}</b>
            <span className="mono tiny muted">{template.path}</span>
            <span className="spacer" />
            <CopyButton text={template.content} label="Copy" />
          </div>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            {template.text}
          </div>
          <pre className="template-body">{template.content}</pre>
        </section>
      ))}
    </div>
  );
}

function ToolsTab({ catalog }: { catalog: AiCatalog }) {
  const registered = catalog.items.some((item) => item.kind === 'mcp' && item.name === 'code-visualizer');
  return (
    <div className="card-body stack" style={{ gap: 16 }}>
      <div className="small">
        code-visualizer can give Claude Code {CODE_VISUALIZER_TOOLS.length} tools that answer from the analysis of this repository instead of reading files: what a change affects, which tests to run, who owns a file.{' '}
        {registered ? (
          <span className="badge success">registered in this project</span>
        ) : (
          <>
            Register it once:
            <div style={{ marginTop: 6 }}>
              <CommandBlock commands="code-visualizer agents init --write" />
            </div>
          </>
        )}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {CODE_VISUALIZER_TOOLS.map((tool) => (
          <div key={tool.name} className="guide-entry">
            <span className="mono small" style={{ fontWeight: 600 }}>
              {tool.name}
            </span>
            <span className="small muted wrap-anywhere">{tool.text}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="section-title">Ask Claude like this</div>
        <div className="stack" style={{ gap: 6 }}>
          {CODE_VISUALIZER_PROMPTS.map((prompt) => (
            <div key={prompt} className="row nowrap small" style={{ gap: 8 }}>
              <span className="wrap-anywhere" style={{ flex: 1, minWidth: 0 }}>
                “{prompt}”
              </span>
              <CopyButton text={prompt} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AiView() {
  const { data } = useModel();
  const catalog = data.ai;
  const [tab, setTab] = useState<AiTab>('available');
  useRefreshOnFocus();
  const counts = useMemo(() => kindCounts(catalog?.items ?? []), [catalog]);
  if (!catalog) {
    return (
      <div className="page">
        <Empty icon={Bot} title="No AI assistant setup found">
          The AI view lists the skills, commands, agents, MCP servers and hooks Claude Code can use here, and how to use them. It is empty in a report made without the <code>ai</code> analysis.
        </Empty>
      </div>
    );
  }
  const automatic = catalog.items.filter((item) => item.kind === 'skill' && item.auto).length;
  return (
    <div className="page">
      <div className="grid cols-4 stats">
        <Stat icon={Sparkles} value={fmtNum(counts.skill)} label="Skills" hint={counts.skill ? `${automatic} can start on their own` : 'none yet'} color="#a78bfa" />
        <Stat icon={SquareTerminal} value={fmtNum(counts.command)} label="Slash commands" hint={counts.command ? 'type / to use them' : 'none yet'} color="#38bdf8" />
        <Stat icon={Bot} value={fmtNum(counts.agent)} label="Subagents" hint={counts.agent ? 'delegate with @name' : 'none yet'} color="#34d399" />
        <Stat icon={Plug} value={fmtNum(counts.mcp)} label="MCP servers" hint={`${plural(counts.hook, 'hook')} · ${plural(counts.memory, 'memory file')}`} color="#fbbf24" />
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <RefreshButton what="AI setup" />
      </div>
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'available', label: 'Available here', count: catalog.items.length, icon: Webhook },
              { value: 'guide', label: 'How to use Claude Code', icon: FileText },
              { value: 'templates', label: 'Templates' },
              { value: 'tools', label: 'code-visualizer tools' },
            ]}
          />
        </div>
        {tab === 'available' && <AiCatalogList catalog={catalog} />}
        {tab === 'guide' && <GuideTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'tools' && <ToolsTab catalog={catalog} />}
      </div>

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <ChecksCard catalog={catalog} />
        <div className="card">
          <div className="card-head">
            <h3>Instructions for other assistants</h3>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {catalog.instructions.map((file) => (
              <div key={file.path} className="row nowrap small" style={{ gap: 8 }}>
                <span className="badge">{file.tool}</span>
                <PathLink path={file.path} label={file.path} />
                <span className="spacer" />
                <span className="tiny faint">{plural(file.lines, 'line')} · ~{fmtCompact(file.tokens)} tokens</span>
              </div>
            ))}
            {!catalog.instructions.length && <div className="small muted">No AGENTS.md, Cursor rules, Copilot or Gemini instructions found.</div>}
            <div className="tiny faint">Keeping these files consistent with CLAUDE.md saves every assistant from learning the project twice.</div>
          </div>
        </div>
      </div>
      <p className="tiny faint" style={{ marginTop: 12 }}>
        {catalog.personal ? 'Includes your personal setup in ~/.claude and installed plugins; only names, descriptions and paths are shown, never file contents or secrets. ' : 'Your personal ~/.claude setup is not included. '}
        Run with <code>--no-personal-ai</code> to leave it out of a report you share.
      </p>
    </div>
  );
}
