import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, ChevronLeft, ChevronRight, Download, Network, Save, Trash2, Users, Wand2 } from 'lucide-react';
import { describeKey } from '../lib/keys';
import { downloadBlob } from '../lib/download';
import { liveConfig, saveServerTour } from '../data/live';
import { moveTourStep, parseKey, removeTourStep, updateTour, usePersonal } from '../state/personal';
import { toast } from '../state/store';
import { Segmented } from '../components/ui';
import type { CustomTour } from '../types';
import { useModel } from '../data/context';
import { Markdown } from '../lib/markdown';
import { basename } from '../lib/format';
import { navigate, selectFile, showInGraph, type ViewId } from '../state/store';
import { TOUR_ICONS } from '../components/icons';
import { KindDot } from '../components/ui';

const VIEW_LABELS: Partial<Record<string, string>> = {
  overview: 'Overview',
  graph: 'Dependency graph',
  structure: 'Structure',
  routes: 'Routes',
  components: 'Components',
  classes: 'Classes',
  insights: 'Insights',
};

function GeneratedTour() {
  const model = useModel();
  const steps = model.data.tour;
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const isFile = (id: string): boolean => model.fileById.has(id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowDown' || e.key === 'j') setActive((a) => Math.min(steps.length - 1, a + 1));
      if (e.key === 'ArrowUp' || e.key === 'k') setActive((a) => Math.max(0, a - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps.length]);

  useEffect(() => {
    refs.current[active]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [active]);

  return (
    <div className="tour">
      <div style={{ marginBottom: 28 }}>
        <div className="badge accent" style={{ marginBottom: 10 }}>
          Onboarding · {steps.length} steps
        </div>
        <h2 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>New to this codebase? Start here.</h2>
        <p className="muted" style={{ margin: '6px 0 0', maxWidth: 620 }}>
          An automatically generated walkthrough: what the project is, how to run it, where execution starts, how it is organized and which parts matter most. Use <kbd>↑</kbd> <kbd>↓</kbd> to move between steps.
        </p>
      </div>
      {steps.map((step, i) => {
        const Icon = TOUR_ICONS[step.icon ?? ''] ?? TOUR_ICONS.sparkles;
        const files = (step.files ?? []).filter(isFile);
        return (
          <div key={step.id} ref={(el) => void (refs.current[i] = el)} className={`tour-step${i === active ? ' active' : ''}`} onClick={() => setActive(i)}>
            <div className="tour-num">
              <Icon size={19} />
            </div>
            <div className="card tour-card" style={i === active ? { borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))', boxShadow: 'var(--shadow)' } : undefined}>
              <div className="row nowrap" style={{ marginBottom: 6 }}>
                <span className="tiny faint" style={{ fontWeight: 650, letterSpacing: '0.06em' }}>
                  STEP {i + 1}
                </span>
              </div>
              <h3>{step.title}</h3>
              <Markdown text={step.body} isFile={isFile} onFile={(id) => selectFile(id)} />
              {step.id === 'reading-order' ? (
                <div className="reading-order">
                  {files.map((id) => {
                    const f = model.fileById.get(id)!;
                    return (
                      <div key={id} className="ro-item" onClick={() => selectFile(id)}>
                        <KindDot kind={f.kind} />
                        <span className="mono truncate" style={{ flex: 1 }}>
                          {id}
                        </span>
                        {f.description && <span className="tiny faint truncate desktop-only" style={{ maxWidth: 260 }}>{f.description}</span>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                files.length > 0 && (
                  <div className="tags" style={{ marginTop: 10 }}>
                    {files.map((id) => {
                      const f = model.fileById.get(id)!;
                      return (
                        <button key={id} className="chip" onClick={(e) => (e.stopPropagation(), selectFile(id))} title={id}>
                          <KindDot kind={f.kind} />
                          <span className="mono">{basename(id)}</span>
                        </button>
                      );
                    })}
                  </div>
                )
              )}
              <div className="row" style={{ marginTop: 14 }}>
                {files.length > 0 && (
                  <button className="btn sm" onClick={(e) => (e.stopPropagation(), showInGraph(files, files.length === 1 ? 'focus' : 'files'))}>
                    <Network size={13} /> Show in graph
                  </button>
                )}
                {step.view && VIEW_LABELS[step.view] && (
                  <button className="btn sm" onClick={(e) => (e.stopPropagation(), navigate(step.view as ViewId))}>
                    Open {VIEW_LABELS[step.view]} <ArrowRight size={13} />
                  </button>
                )}
                <span className="spacer" />
                {i > 0 && (
                  <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), setActive(i - 1))} aria-label="Previous step">
                    <ChevronLeft size={14} />
                  </button>
                )}
                {i < steps.length - 1 && (
                  <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), setActive(i + 1))}>
                    Next <ChevronRight size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type TourTab = 'guided' | 'team' | 'mine';

export function TourView() {
  const model = useModel();
  const mine = usePersonal((s) => s.tour);
  const [tab, setTab] = useState<TourTab>('guided');
  const teamTours = model.data.tours;
  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'guided', label: 'Generated tour', icon: Wand2 },
            { value: 'team', label: `Team tours (${teamTours.length})`, icon: Users },
            { value: 'mine', label: `My tour (${mine.steps.length})`, icon: BookOpen },
          ]}
        />
        <span className="spacer" />
        <span className="small muted desktop-only">Tours use the VS Code CodeTour format (.tours/*.tour)</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'guided' && <GeneratedTour />}
        {tab === 'team' && <TeamTours tours={teamTours} />}
        {tab === 'mine' && <MyTour />}
      </div>
    </div>
  );
}

function TeamTours({ tours }: { tours: CustomTour[] }) {
  const model = useModel();
  const [index, setIndex] = useState(0);
  if (!tours.length) {
    return (
      <div className="tour">
        <div className="empty">
          <div className="empty-icon">
            <Users size={24} />
          </div>
          <h3>No team tours yet</h3>
          <p>
            Build one under <strong>My tour</strong> while you explore — add files and functions with “Add to tour” in the details panel — then save it to <code>.tours/</code> and commit it. Teammates see it here and in VS Code's CodeTour extension.
          </p>
        </div>
      </div>
    );
  }
  const tour = tours[Math.min(index, tours.length - 1)];
  const isFile = (id: string): boolean => model.fileById.has(id);
  return (
    <div className="tour">
      {tours.length > 1 && (
        <div className="tags" style={{ marginBottom: 18 }}>
          {tours.map((t, i) => (
            <button key={t.source} className={`chip${i === index ? ' active' : ''}`} style={i === index ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setIndex(i)}>
              {t.title}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginBottom: 24 }}>
        <div className="badge accent" style={{ marginBottom: 10 }}>
          {tour.source} · {tour.steps.length} steps
        </div>
        <h2 style={{ margin: 0, fontSize: 24, letterSpacing: '-0.02em' }}>{tour.title}</h2>
        {tour.description && <p className="muted">{tour.description}</p>}
      </div>
      {tour.steps.map((step, i) => (
        <div key={i} className="tour-step">
          <div className="tour-num">{i + 1}</div>
          <div className="card tour-card">
            {step.title && <h3>{step.title}</h3>}
            <Markdown text={step.description || ''} isFile={isFile} onFile={(id) => selectFile(id)} />
            {step.file && (
              <div className="row" style={{ marginTop: 10 }}>
                <button className="chip" onClick={() => selectFile(step.file!, step.line)} title={step.file}>
                  {model.fileById.get(step.file) && <KindDot kind={model.fileById.get(step.file)!.kind} />}
                  <span className="mono">
                    {step.file}
                    {step.line ? `:${step.line}` : ''}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function stepLocation(model: ReturnType<typeof useModel>, key: string): { file?: string; line?: number; directory?: string } {
  const sel = parseKey(key);
  if (!sel) return {};
  if (sel.type === 'file') return { file: sel.id };
  if (sel.type === 'symbol') {
    const ref = model.resolveSymbol(sel.id);
    return ref ? { file: ref.file.id, line: ref.member?.line ?? ref.symbol.line } : { file: sel.id.split('#')[0] };
  }
  if (sel.type === 'folder') return { directory: sel.id };
  if (sel.type === 'route') {
    const r = model.routeById.get(sel.id);
    return r ? { file: r.file, line: r.line } : {};
  }
  return {};
}

function MyTour() {
  const model = useModel();
  const tour = usePersonal((s) => s.tour);
  const live = !!liveConfig();
  const toCodeTour = () => ({
    title: tour.title,
    description: tour.description,
    steps: tour.steps.map((st) => ({ title: st.title, description: st.description || st.title || '', ...stepLocation(model, st.key) })),
  });
  return (
    <div className="tour">
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="stack" style={{ gap: 10 }}>
          <input className="input" style={{ fontSize: 18, fontWeight: 650, height: 40 }} value={tour.title} onChange={(e) => updateTour({ title: e.target.value })} placeholder="Tour title" />
          <textarea className="note-box" style={{ minHeight: 60 }} value={tour.description ?? ''} onChange={(e) => updateTour({ description: e.target.value })} placeholder="What will someone learn from this tour? (e.g. “How a checkout request flows from the cart page to the payment provider”)" />
          <div className="row">
            <button
              className="btn primary"
              disabled={!tour.steps.length}
              onClick={() => {
                const slug = tour.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tour';
                downloadBlob(`${slug}.tour`, JSON.stringify({ $schema: 'https://aka.ms/codetour-schema', ...toCodeTour() }, null, 2), 'application/json');
              }}
            >
              <Download size={14} /> Export .tour
            </button>
            {live && (
              <button
                className="btn"
                disabled={!tour.steps.length}
                onClick={async () => {
                  const path = await saveServerTour(toCodeTour());
                  toast(path ? `Saved to ${path} — commit it to share with your team` : 'Could not save the tour');
                }}
              >
                <Save size={14} /> Save to .tours/
              </button>
            )}
            <span className="small muted">{live ? 'Saved tours appear under “Team tours” and in VS Code CodeTour.' : 'Put the exported file in .tours/ and commit it to share it.'}</span>
          </div>
        </div>
      </div>
      {!tour.steps.length && (
        <div className="empty">
          <div className="empty-icon">
            <BookOpen size={24} />
          </div>
          <h3>Your tour is empty</h3>
          <p>Open any file, function, folder or route and press “Add to tour” in the details panel. Your notes become the step descriptions.</p>
        </div>
      )}
      {tour.steps.map((step, i) => {
        const info = describeKey(model, step.key);
        return (
          <div key={step.key} className="tour-step">
            <div className="tour-num">{i + 1}</div>
            <div className="card tour-card stack" style={{ gap: 8 }}>
              <div className="row nowrap" style={{ gap: 6 }}>
                <input
                  className="input"
                  style={{ flex: 1, fontWeight: 600 }}
                  value={step.title ?? ''}
                  placeholder="Step title"
                  onChange={(e) => {
                    const steps = [...tour.steps];
                    steps[i] = { ...step, title: e.target.value };
                    updateTour({ steps });
                  }}
                />
                <button className="btn ghost icon sm" onClick={() => moveTourStep(i, -1)} disabled={i === 0} aria-label="Move up">
                  <ArrowUp size={14} />
                </button>
                <button className="btn ghost icon sm" onClick={() => moveTourStep(i, 1)} disabled={i === tour.steps.length - 1} aria-label="Move down">
                  <ArrowDown size={14} />
                </button>
                <button className="btn ghost icon sm danger" onClick={() => removeTourStep(i)} aria-label="Remove step">
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                className="note-box"
                value={step.description}
                placeholder="Explain what matters here (Markdown works)…"
                onChange={(e) => {
                  const steps = [...tour.steps];
                  steps[i] = { ...step, description: e.target.value };
                  updateTour({ steps });
                }}
              />
              {info && (
                <button className="chip" style={{ alignSelf: 'flex-start' }} onClick={info.open}>
                  {info.icon}
                  <span className="mono">{info.label}</span>
                  <span className="faint tiny">{info.sub}</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
