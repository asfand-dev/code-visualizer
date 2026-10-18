import { Copy } from 'lucide-react';
import { coChangeLabel, driftMessage, familiesOf, fragmentLocation, similarityLabel, similarityRange } from '../../../src/shared/clones';
import { useModel } from '../data/context';
import { basename, plural } from '../lib/format';
import { selectFile, showInGraph } from '../state/store';
import type { CloneDrift, CloneFamily, CloneFragment } from '../types';

/**
 * clone-radar: copy-paste clones in the report — a family with its copies (Insights, the detail panel's
 * "Similar code"), and clone drift in My changes (you changed one copy, not the others).
 */

function FragmentChip({ fragment, highlight }: { fragment: CloneFragment; highlight?: boolean }) {
  const model = useModel();
  const known = model.fileById.has(fragment.file);
  return (
    <button
      className="tag link"
      onClick={known ? () => selectFile(fragment.file, fragment.start) : undefined}
      title={`${fragmentLocation(fragment)}${fragment.importers ? ` · used in ${plural(fragment.importers, 'file')}` : ''}`}
      style={{ gap: 6, ...(highlight ? { borderColor: 'var(--accent)' } : {}) }}
    >
      {fragment.name && <strong className="mono">{fragment.name}</strong>}
      <span className="mono faint">
        {basename(fragment.file)}:{fragment.start}
      </span>
      {fragment.isNew && <span className="badge warn">new</span>}
    </button>
  );
}

/** One clone family: how similar, how big, how often its files changed together, and its copies. */
export function CloneFamilyItem({ family, focus }: { family: CloneFamily; focus?: { file: string; start?: number; end?: number } }) {
  const together = coChangeLabel(family);
  const files = [...new Set(family.fragments.map((f) => f.file))];
  const isFocus = (f: CloneFragment): boolean => !!focus && f.file === focus.file && (focus.start === undefined || (f.start <= (focus.end ?? focus.start) && f.end >= focus.start));
  return (
    <div style={{ padding: '6px 10px' }}>
      <div className="row nowrap small" style={{ gap: 8 }}>
        <span className={`badge ${family.similarity >= 0.9 ? 'danger' : family.similarity >= 0.5 ? 'warn' : ''}`} title="Shared tokens / tokens of the larger declaration, for each two copies">
          {similarityRange(family)}
        </span>
        <span className="tiny faint">
          {plural(family.fragments.length, 'copy', 'copies')} · {plural(family.tokens, 'token')} · {plural(family.lines, 'line')}
        </span>
        {together && <span className="badge danger" title="Files of these copies are usually committed together: a fix in one copy is easy to forget in the other">{together}</span>}
        <span className="spacer" />
        {files.length > 1 && (
          <button className="btn ghost sm" onClick={() => showInGraph(files, 'files')} title="Show the files in the graph">
            Graph
          </button>
        )}
      </div>
      <div className="tags" style={{ marginTop: 6 }}>
        {family.fragments.map((f) => (
          <FragmentChip key={`${f.file}:${f.start}`} fragment={f} highlight={isFocus(f)} />
        ))}
      </div>
    </div>
  );
}

/** The detail panel's "Similar code": clone families with a copy in this file (or in these lines). */
export function SimilarCode({ fileId, range }: { fileId: string; range?: { start: number; end: number } }) {
  const model = useModel();
  const families = familiesOf(model.data.insights.clones, fileId, range);
  if (!model.data.insights.clones) return <div className="muted small">Clone detection is off for this report ("clones": false).</div>;
  if (!families.length) return <div className="muted small">No copy-paste clones of this {range ? 'code' : 'file'} elsewhere.</div>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="small muted">
        Code that exists more than once (renamed variables and other literals still count). Fix a bug in one copy, fix it in all — or merge them.
      </div>
      {families.map((fam) => (
        <CloneFamilyItem key={fam.id} family={fam} focus={{ file: fileId, ...range }} />
      ))}
    </div>
  );
}

/** My changes: copies you changed while their clones stayed as they were. */
export function CloneDriftCard({ drift }: { drift: CloneDrift[] }) {
  const model = useModel();
  return (
    <section className="card">
      <div className="card-head">
        <Copy size={15} className="muted" />
        <h3>Clone drift</h3>
        <span className="badge warn">{drift.length}</span>
      </div>
      <div className="card-body stack" style={{ gap: 8 }}>
        <div className="small muted">You changed code that exists more than once — apply the same change to the other copies, or merge them.</div>
        <div className="list">
          {drift.slice(0, 8).map((d) => (
            <div key={`${d.changed.file}:${d.changed.start}`} className="list-item" style={{ padding: '6px 8px', cursor: 'default', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small">{driftMessage(d)}</div>
                <div className="tags" style={{ marginTop: 4 }}>
                  {[d.changed, ...d.untouched].map((f) => (
                    <button key={`${f.file}:${f.start}`} className="tag link" onClick={model.fileById.has(f.file) ? () => selectFile(f.file, f.start) : undefined}>
                      <span className="mono">{fragmentLocation(f)}</span>
                    </button>
                  ))}
                </div>
                {d.coChanges ? <div className="tiny faint">changed together {plural(d.coChanges, 'time')} before</div> : null}
              </div>
              {d.similarity !== undefined && <span className="meta">{similarityLabel(d.similarity)}</span>}
            </div>
          ))}
          {drift.length > 8 && <span className="tiny faint" style={{ padding: '2px 8px' }}>+ {drift.length - 8} more</span>}
        </div>
      </div>
    </section>
  );
}
