import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Network } from 'lucide-react';
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

export function TourView() {
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
