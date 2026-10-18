import type { ReactNode } from 'react';
import { Blocks } from 'lucide-react';
import { useModel } from '../data/context';
import { breakingExports, cycleLabel, exportChangeLabel, exportImpactLabel, functionLabel, isEmptyDelta } from '../../../src/shared/delta';
import { cloneSides, fragmentLocation, newCloneMessage, similarityLabel } from '../../../src/shared/clones';
import { plural } from '../lib/format';
import { navigate, select, selectFile, showInGraph } from '../state/store';
import type { ArchitectureDelta } from '../types';

/**
 * What your branch or uncommitted work changes architecturally (`changes.delta`, compare-engine):
 * new cycles and rule breaks, new dependencies between areas, breaking API changes, removed routes
 * that are still called, complexity and health — the same facts as the PR description, clickable.
 */

const SHOWN = 5;

function Group({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="tiny section-label" style={{ color }}>
        {title}
      </div>
      <div className="list">{children}</div>
    </div>
  );
}

/** One finding; `stacked` puts the meta on a second line, so a long signature or pair of copies stays readable. */
function Row({ onClick, children, meta, title, stacked }: { onClick?: () => void; children: ReactNode; meta?: ReactNode; title?: string; stacked?: boolean }) {
  if (stacked) {
    return (
      <button className="list-item stacked" style={{ padding: '5px 8px' }} onClick={onClick} disabled={!onClick} title={title}>
        <span className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <span className="small wrap-anywhere">{children}</span>
          {meta !== undefined && <span className="tiny faint">{meta}</span>}
        </span>
      </button>
    );
  }
  return (
    <button className="list-item" style={{ padding: '5px 8px' }} onClick={onClick} disabled={!onClick} title={title}>
      <span className="small truncate" style={{ flex: 1 }}>
        {children}
      </span>
      {meta !== undefined && <span className="meta">{meta}</span>}
    </button>
  );
}

const more = (total: number): ReactNode => (total > SHOWN ? <span className="tiny faint" style={{ padding: '2px 8px' }}>+ {total - SHOWN} more</span> : null);

export function ArchitectureDeltaCard({ delta }: { delta: ArchitectureDelta }) {
  const model = useModel();
  const exists = (id: string): boolean => model.fileById.has(id);
  const openFile = (id: string, line?: number): (() => void) | undefined => (exists(id) ? () => selectFile(id, line) : undefined);
  const breaking = breakingExports(delta);
  const newAreas = delta.areaEdges.filter((a) => a.isNew);
  const stillCalled = delta.routes.removed.filter((r) => r.stillCalledFrom.length);
  // Judged with the configured limit (new-only-gates: `check.maxComplexity`), like `check` does.
  const complexityLimit = delta.complexityThreshold ?? 10;
  const complex = delta.complexity.filter((c) => c.after > complexityLimit);
  const missing = [...delta.newMissingDependencies.map((name) => ({ name, dev: false })), ...(delta.newDevDependenciesInProduction ?? []).map((d) => ({ name: d.name, dev: true }))];
  const healthMoved = delta.health.after - delta.health.before;
  const fixed = [
    delta.fixedCycles.length ? plural(delta.fixedCycles.length, 'cycle') : '',
    delta.fixedViolations.length ? plural(delta.fixedViolations.length, 'rule violation') : '',
    // new-only-gates: the findings of the base that went away.
    delta.fixedComplexity?.length ? plural(delta.fixedComplexity.length, 'complex function') : '',
    (delta.fixedMissingDependencies?.length ?? 0) + (delta.fixedDevDependenciesInProduction?.length ?? 0)
      ? plural((delta.fixedMissingDependencies?.length ?? 0) + (delta.fixedDevDependenciesInProduction?.length ?? 0), 'dependency problem')
      : '',
    delta.fixedUnusedExports?.length ? plural(delta.fixedUnusedExports.length, 'unused export') : '',
    // clone-radar: copies that were merged or removed.
    delta.fixedClones?.length ? plural(delta.fixedClones.length, 'copy-paste clone') : '',
  ].filter(Boolean);
  const newClones = delta.newClones ?? [];
  const empty = isEmptyDelta(delta);
  const nothingWorse = !delta.newCycles.length && !delta.newViolations.length && !breaking.length && !stillCalled.length && !missing.length && !complex.length && !newAreas.length && !newClones.length;

  return (
    <section className="card">
      <div className="card-head">
        <Blocks size={15} className="muted" />
        <h3 title={`Compared with ${delta.base}`}>Architecture changes</h3>
        <span className="spacer" />
        {healthMoved !== 0 && (
          <button className={`badge ${healthMoved < 0 ? 'danger' : 'success'}`} onClick={() => navigate('insights')} title={delta.health.categories.map((c) => `${c.id} ${c.before} → ${c.after}`).join('\n')}>
            health {delta.health.before} → {delta.health.after}
          </button>
        )}
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {empty || nothingWorse ? (
          <div className="small muted">
            {/* A health drop alone (e.g. new unused exports) is not "nothing got worse". */}
            {empty ? 'No architectural changes: no' : healthMoved < 0 ? 'No' : 'Nothing got worse: no'} new cycles, rule breaks, dependencies between areas or breaking API changes
            {!empty && healthMoved < 0 ? ', but health dropped (see Insights).' : '.'}
          </div>
        ) : null}
        {delta.newCycles.length > 0 && (
          <Group title={plural(delta.newCycles.length, 'new cycle')} color="var(--danger)">
            {delta.newCycles.slice(0, SHOWN).map((c) => (
              <Row key={c.join('|')} onClick={() => showInGraph(c.filter(exists), 'cycle')} title={c.join(' → ')}>
                <span className="mono">{cycleLabel(c)}</span>
              </Row>
            ))}
            {more(delta.newCycles.length)}
          </Group>
        )}
        {delta.newViolations.length > 0 && (
          <Group title={plural(delta.newViolations.length, 'new rule violation')} color="var(--danger)">
            {delta.newViolations.slice(0, SHOWN).map((v) => (
              <Row key={`${v.rule}|${v.source}|${v.target}`} onClick={openFile(v.source, v.line)} meta={v.rule === 'layers' ? 'layers' : v.rule} title={v.message}>
                <span className="mono">
                  {v.source}:{v.line} → {v.target}
                </span>
              </Row>
            ))}
            {more(delta.newViolations.length)}
          </Group>
        )}
        {breaking.length > 0 && (
          <Group title={plural(breaking.length, 'breaking API change')} color="var(--warning)">
            {breaking.slice(0, SHOWN).map((e) => (
              <Row key={`${e.file}#${e.name}`} stacked onClick={openFile(e.file, e.line)} meta={exportImpactLabel(e, 1)} title={`${e.file}\n${exportChangeLabel(e)}`}>
                <span className="mono">{exportChangeLabel(e, true)}</span>
              </Row>
            ))}
            {more(breaking.length)}
          </Group>
        )}
        {stillCalled.length > 0 && (
          <Group title={`${plural(stillCalled.length, 'removed route')} still called`} color="var(--danger)">
            {stillCalled.slice(0, SHOWN).map((r) => (
              <Row key={r.id} onClick={openFile(r.stillCalledFrom[0].file, r.stillCalledFrom[0].line)} meta={plural(r.stillCalledFrom.length, 'call')} title={r.stillCalledFrom.map((c) => `${c.file}:${c.line}`).join('\n')}>
                <span className="mono">{r.label}</span>
              </Row>
            ))}
            {more(stillCalled.length)}
          </Group>
        )}
        {missing.length > 0 && (
          <Group title="Dependencies" color="var(--danger)">
            {missing.slice(0, SHOWN).map((m) => (
              <Row key={`${m.name}|${m.dev}`} onClick={() => select({ type: 'package', id: m.name })} meta={m.dev ? 'devDependency in production' : 'not in package.json'}>
                <span className="mono">{m.name}</span>
              </Row>
            ))}
            {more(missing.length)}
          </Group>
        )}
        {newAreas.length > 0 && (
          <Group title={plural(newAreas.length, 'new dependency between areas', 'new dependencies between areas')} color="var(--info)">
            {newAreas.slice(0, SHOWN).map((a) => {
              const files = [...new Set((a.via ?? []).flatMap((v) => [v.source, v.target]))].filter(exists);
              return (
                <Row key={`${a.from}|${a.to}`} onClick={files.length ? () => showInGraph(files, 'files') : undefined} meta={plural(a.after, 'import')} title={(a.via ?? []).map((v) => `${v.source}${v.line ? `:${v.line}` : ''} → ${v.target}`).join('\n')}>
                  <span className="mono">
                    {a.from} → {a.to}
                  </span>
                </Row>
              );
            })}
            {more(newAreas.length)}
          </Group>
        )}
        {complex.length > 0 && (
          <Group title="More complex functions" color="var(--warning)">
            {complex.slice(0, SHOWN).map((c) => (
              <Row key={c.symbol} onClick={openFile(c.file, c.line)} meta={c.before ? `${c.before} → ${c.after}` : `new · ${c.after}`} title={c.file}>
                <span className="mono">{functionLabel(c.name)}</span>
              </Row>
            ))}
            {more(complex.length)}
          </Group>
        )}
        {/* --- clone-radar: "this already exists: import it instead" --- */}
        {newClones.length > 0 && (
          <Group title={plural(newClones.length, 'new copy-paste clone')} color="var(--warning)">
            {newClones.slice(0, SHOWN).map((fam) => {
              const { copy, original, similarity } = cloneSides(fam);
              return (
                <Row key={fam.id} stacked onClick={openFile(copy.file, copy.start)} meta={`${similarityLabel(similarity)} similar · ${fragmentLocation(copy)}`} title={newCloneMessage(fam)}>
                  <span className="mono">
                    {copy.name ?? fragmentLocation(copy)} ≈ {original ? `${original.name ?? 'code'} (${original.file})` : 'other code'}
                  </span>
                </Row>
              );
            })}
            {more(newClones.length)}
          </Group>
        )}
        {/* --- /clone-radar --- */}
        {fixed.length > 0 && <div className="small" style={{ color: 'var(--success)' }}>✔ Fixed: {fixed.join(', ')}</div>}
        <div className="tiny faint">
          Compared with {delta.base}
          {delta.mergeBase ? ', where your branch started' : ''} · {delta.head}
        </div>
      </div>
    </section>
  );
}
